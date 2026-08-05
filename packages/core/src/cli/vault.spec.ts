import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXIT,
  createVaultSecret,
  discoverConnectedApps,
  leaseSecrets,
  listVaultSecrets,
  formatVaultAddUsage,
  formatVaultEnvUsage,
  formatVaultExecUsage,
  formatVaultUsage,
  promptForSecretValue,
  runVaultExec,
  type ConnectedApp,
  type VaultExecDeps,
} from "./vault.js";

// Obviously fake. Every failure-path test asserts this substring never reaches
// stderr, so it has to be a value a naive implementation would echo.
const FAKE_VALUE = "fake-leased-value-do-not-print";

function app(serverName: string, url = `https://${serverName}.test/mcp`) {
  return {
    serverName,
    url,
    bearer: `fake-bearer-${serverName}`,
    client: "claude-code",
    configFile: `/home/dev/.claude.json`,
  } satisfies ConnectedApp;
}

interface Harness {
  deps: VaultExecDeps;
  stderrText: () => string;
  spawnChild: ReturnType<typeof vi.fn>;
  leaseSecrets: ReturnType<typeof vi.fn>;
  listSecrets: ReturnType<typeof vi.fn>;
  createSecret: ReturnType<typeof vi.fn>;
  promptSecret: ReturnType<typeof vi.fn>;
  discoverConnectedApps: ReturnType<typeof vi.fn>;
  stdoutText: () => string;
}

function harness(overrides: Partial<VaultExecDeps> = {}): Harness {
  const lines: string[] = [];
  const out: string[] = [];
  const discoverConnectedApps = vi.fn(() => [app("dispatch")]);
  const leaseSecrets = vi.fn(async (keys: string[], leaseId: string) => ({
    leaseId,
    env: Object.fromEntries(keys.map((key) => [key, FAKE_VALUE])),
  }));
  // Carries a `value` the CLI must never surface: a deployment that starts
  // returning one must not turn `vault list` into a credential printer.
  const listSecrets = vi.fn(async () => [
    {
      credentialKey: "ANTHROPIC_API_KEY",
      name: "Anthropic (prod)",
      value: FAKE_VALUE,
    },
    { credentialKey: "STRIPE_KEY", name: "Stripe", value: FAKE_VALUE },
  ]);
  const spawnChild = vi.fn(async () => 0);
  // The value is what the operator types, so it exists nowhere in argv.
  const promptSecret = vi.fn(async () => FAKE_VALUE);
  // The create action answers with the stored row, value included; the CLI has
  // to stay incapable of surfacing it.
  const createSecret = vi.fn(async (draft: { credentialKey: string }) => ({
    credentialKey: draft.credentialKey,
    value: FAKE_VALUE,
  }));

  const deps: VaultExecDeps = {
    discoverConnectedApps,
    leaseSecrets,
    listSecrets,
    createSecret,
    promptSecret,
    spawnChild,
    env: {},
    stderr: (line) => lines.push(line),
    stdout: (line) => out.push(line),
    newLeaseId: () => "lease-0001",
    ...overrides,
  };

  return {
    deps,
    stderrText: () => lines.join("\n"),
    stdoutText: () => out.join("\n"),
    spawnChild: (overrides.spawnChild ?? spawnChild) as any,
    leaseSecrets: (overrides.leaseSecrets ?? leaseSecrets) as any,
    listSecrets: (overrides.listSecrets ?? listSecrets) as any,
    createSecret: (overrides.createSecret ?? createSecret) as any,
    promptSecret: (overrides.promptSecret ?? promptSecret) as any,
    discoverConnectedApps: (overrides.discoverConnectedApps ??
      discoverConnectedApps) as any,
  };
}

describe("runVaultExec — happy path", () => {
  it("runs the command with the leased values in its environment", async () => {
    const h = harness();

    const code = await runVaultExec(
      ["exec", "--key", "ANTHROPIC_API_KEY", "--", "pnpm", "test"],
      h.deps,
    );

    expect(code).toBe(0);
    expect(h.leaseSecrets).toHaveBeenCalledWith(
      ["ANTHROPIC_API_KEY"],
      "lease-0001",
      expect.objectContaining({ serverName: "dispatch" }),
    );
    expect(h.spawnChild).toHaveBeenCalledTimes(1);
    const [cmd, args, env] = h.spawnChild.mock.calls[0];
    expect(cmd).toBe("pnpm");
    expect(args).toEqual(["test"]);
    expect(env.ANTHROPIC_API_KEY).toBe(FAKE_VALUE);
  });

  it("rejects the bare form: the subcommand word `exec` is required", async () => {
    const h = harness();

    const code = await runVaultExec(["--key", "K", "--", "true"], h.deps);

    expect(code).toBe(EXIT.USAGE);
    expect(h.spawnChild).not.toHaveBeenCalled();
  });

  it("passes everything after `--` to the child verbatim", async () => {
    const h = harness();

    await runVaultExec(
      [
        "exec",
        "--key",
        "K",
        "--",
        "node",
        "-e",
        "process.exit(0)",
        "--key",
        "--all",
      ],
      h.deps,
    );

    const [cmd, args] = h.spawnChild.mock.calls[0];
    expect(cmd).toBe("node");
    expect(args).toEqual(["-e", "process.exit(0)", "--key", "--all"]);
  });

  it("prints the lease id to stderr and puts it in the child env", async () => {
    const h = harness();

    await runVaultExec(["exec", "--key", "K", "--", "true"], h.deps);

    expect(h.stderrText()).toContain("lease-0001");
    const [, , env] = h.spawnChild.mock.calls[0];
    expect(env.AGENT_NATIVE_VAULT_LEASE).toBe("lease-0001");
  });

  it("supports repeated --key and --key=VALUE", async () => {
    const h = harness();

    await runVaultExec(["exec", "--key", "A", "--key=B", "--", "true"], h.deps);

    expect(h.leaseSecrets).toHaveBeenCalledWith(
      ["A", "B"],
      "lease-0001",
      expect.anything(),
    );
  });
});

describe("runVaultExec — usage failures (64)", () => {
  it("rejects a missing `--` and never spawns", async () => {
    const h = harness();

    const code = await runVaultExec(["exec", "--key", "K", "pnpm"], h.deps);

    expect(code).toBe(EXIT.USAGE);
    expect(h.spawnChild).not.toHaveBeenCalled();
    expect(h.leaseSecrets).not.toHaveBeenCalled();
    expect(h.stderrText()).toContain("--");
  });

  it("rejects no --key and says there is no --all", async () => {
    const h = harness();

    const code = await runVaultExec(["exec", "--", "pnpm", "test"], h.deps);

    expect(code).toBe(EXIT.USAGE);
    expect(h.stderrText()).toContain("--all");
    expect(h.spawnChild).not.toHaveBeenCalled();
  });

  it("rejects --all as an unknown option", async () => {
    const h = harness();

    const code = await runVaultExec(["exec", "--all", "--", "pnpm"], h.deps);

    expect(code).toBe(EXIT.USAGE);
    expect(h.stderrText()).toContain("Unknown option: --all");
    expect(h.leaseSecrets).not.toHaveBeenCalled();
  });

  it("treats --key A,B as one key and never splits it", async () => {
    const h = harness();

    await runVaultExec(["exec", "--key", "A,B", "--", "true"], h.deps);

    expect(h.leaseSecrets).toHaveBeenCalledWith(
      ["A,B"],
      "lease-0001",
      expect.anything(),
    );
  });

  it("rejects a duplicate --key", async () => {
    const h = harness();

    const code = await runVaultExec(
      ["exec", "--key", "A", "--key", "A", "--", "true"],
      h.deps,
    );

    expect(code).toBe(EXIT.USAGE);
    expect(h.stderrText()).toContain("A");
    expect(h.leaseSecrets).not.toHaveBeenCalled();
  });

  it("rejects more than 50 keys", async () => {
    const h = harness();
    const keys = Array.from({ length: 51 }, (_, i) => [
      "--key",
      `K${i}`,
    ]).flat();

    const code = await runVaultExec(["exec", ...keys, "--", "true"], h.deps);

    expect(code).toBe(EXIT.USAGE);
    expect(h.stderrText()).toContain("50");
    expect(h.leaseSecrets).not.toHaveBeenCalled();
  });

  it("rejects nothing after `--`", async () => {
    const h = harness();

    const code = await runVaultExec(["exec", "--key", "K", "--"], h.deps);

    expect(code).toBe(EXIT.USAGE);
    expect(h.spawnChild).not.toHaveBeenCalled();
  });

  it("rejects a --key with no value", async () => {
    const h = harness();

    const code = await runVaultExec(["exec", "--key", "--", "true"], h.deps);

    expect(code).toBe(EXIT.USAGE);
    expect(h.leaseSecrets).not.toHaveBeenCalled();
  });

  it("rejects a stray positional before `--`", async () => {
    const h = harness();

    const code = await runVaultExec(
      ["exec", "--key", "K", "oops", "--", "true"],
      h.deps,
    );

    expect(code).toBe(EXIT.USAGE);
    expect(h.leaseSecrets).not.toHaveBeenCalled();
  });
});

describe("runVaultExec — credential source resolution (65/66)", () => {
  it("returns 65 when no app is connected on this machine", async () => {
    const h = harness({ discoverConnectedApps: vi.fn(() => []) });

    const code = await runVaultExec(
      ["exec", "--key", "K", "--", "true"],
      h.deps,
    );

    expect(code).toBe(EXIT.NO_CREDENTIAL);
    expect(h.spawnChild).not.toHaveBeenCalled();
  });

  it("returns 65 when --app names an unconnected app, and lists what is connected", async () => {
    const h = harness({
      discoverConnectedApps: vi.fn(() => [app("dispatch"), app("plan")]),
    });

    const code = await runVaultExec(
      ["exec", "--app", "nope", "--key", "K", "--", "true"],
      h.deps,
    );

    expect(code).toBe(EXIT.NO_CREDENTIAL);
    expect(h.stderrText()).toContain("dispatch");
    expect(h.stderrText()).toContain("plan");
    expect(h.spawnChild).not.toHaveBeenCalled();
  });

  it("returns 66 naming every candidate when several apps are connected and none selected", async () => {
    const h = harness({
      discoverConnectedApps: vi.fn(() => [
        app("dispatch"),
        app("plan"),
        app("mail"),
      ]),
    });

    const code = await runVaultExec(
      ["exec", "--key", "K", "--", "true"],
      h.deps,
    );

    expect(code).toBe(EXIT.AMBIGUOUS_APP);
    for (const name of ["dispatch", "plan", "mail"]) {
      expect(h.stderrText()).toContain(name);
    }
    expect(h.spawnChild).not.toHaveBeenCalled();
    expect(h.leaseSecrets).not.toHaveBeenCalled();
  });

  it("proceeds with the selected app's bearer and URL", async () => {
    const h = harness({
      discoverConnectedApps: vi.fn(() => [app("dispatch"), app("plan")]),
    });

    const code = await runVaultExec(
      ["exec", "--app", "plan", "--key", "K", "--", "true"],
      h.deps,
    );

    expect(code).toBe(0);
    expect(h.leaseSecrets).toHaveBeenCalledWith(
      ["K"],
      "lease-0001",
      expect.objectContaining({
        serverName: "plan",
        url: "https://plan.test/mcp",
        bearer: "fake-bearer-plan",
      }),
    );
  });

  it("does not treat the same app in two client configs as ambiguous", async () => {
    const claude = app("dispatch");
    const codex = {
      ...app("dispatch"),
      client: "codex",
      configFile: "/c.toml",
    };
    const h = harness({ discoverConnectedApps: vi.fn(() => [claude, codex]) });

    const code = await runVaultExec(
      ["exec", "--key", "K", "--", "true"],
      h.deps,
    );

    expect(code).toBe(0);
  });
});

describe("runVaultExec — lease refusal (67)", () => {
  it("returns 67 and names every missing key, never spawning", async () => {
    const h = harness({
      leaseSecrets: vi.fn(async () => {
        throw new Error(
          "Vault lease refused (all-or-nothing): no vault secret for A, B",
        );
      }),
    });

    const code = await runVaultExec(
      ["exec", "--key", "A", "--key", "B", "--", "true"],
      h.deps,
    );

    expect(code).toBe(EXIT.LEASE_REFUSED);
    expect(h.stderrText()).toContain("A, B");
    expect(h.spawnChild).not.toHaveBeenCalled();
  });

  it("returns 67 on an ambiguous key and makes no guess", async () => {
    const h = harness({
      leaseSecrets: vi.fn(async () => {
        throw new Error(
          "Vault lease refused (all-or-nothing): ambiguous credential key(s) A",
        );
      }),
    });

    const code = await runVaultExec(
      ["exec", "--key", "A", "--", "true"],
      h.deps,
    );

    expect(code).toBe(EXIT.LEASE_REFUSED);
    expect(h.spawnChild).not.toHaveBeenCalled();
  });
});

describe("runVaultExec — env merge", () => {
  it("lets the leased value win and names the colliding key without its value", async () => {
    const h = harness({ env: { K: "stale-shell-export", PATH: "/usr/bin" } });

    const code = await runVaultExec(
      ["exec", "--key", "K", "--", "true"],
      h.deps,
    );

    expect(code).toBe(0);
    const [, , env] = h.spawnChild.mock.calls[0];
    expect(env.K).toBe(FAKE_VALUE);
    expect(env.PATH).toBe("/usr/bin");
    expect(h.stderrText()).toContain("K");
    expect(h.stderrText()).not.toContain("stale-shell-export");
    expect(h.stderrText()).not.toContain(FAKE_VALUE);
  });

  it("does not report a collision when the existing value already matches", async () => {
    const h = harness({ env: { K: FAKE_VALUE } });

    await runVaultExec(["exec", "--key", "K", "--", "true"], h.deps);

    expect(h.stderrText().toLowerCase()).not.toContain("overrid");
  });

  it("reports a collision on the lease variable itself", async () => {
    const h = harness({
      env: {},
      leaseSecrets: vi.fn(async (keys: string[], leaseId: string) => ({
        leaseId,
        env: { AGENT_NATIVE_VAULT_LEASE: FAKE_VALUE },
      })),
    });

    await runVaultExec(
      ["exec", "--key", "AGENT_NATIVE_VAULT_LEASE", "--", "true"],
      h.deps,
    );

    const [, , env] = h.spawnChild.mock.calls[0];
    expect(env.AGENT_NATIVE_VAULT_LEASE).toBe("lease-0001");
    expect(h.stderrText()).toContain("AGENT_NATIVE_VAULT_LEASE");
    expect(h.stderrText()).not.toContain(FAKE_VALUE);
  });

  it("never mutates the caller's environment record", async () => {
    const callerEnv: Record<string, string | undefined> = { K: "stale" };
    const h = harness({ env: callerEnv });

    await runVaultExec(["exec", "--key", "K", "--", "true"], h.deps);

    expect(callerEnv.K).toBe("stale");
    expect(callerEnv.AGENT_NATIVE_VAULT_LEASE).toBeUndefined();
  });
});

describe("runVaultExec — child exit propagation", () => {
  it("returns the child's own exit code unchanged", async () => {
    const h = harness({ spawnChild: vi.fn(async () => 1) });

    const code = await runVaultExec(
      ["exec", "--key", "K", "--", "true"],
      h.deps,
    );

    expect(code).toBe(1);
  });

  it("returns 0 when the child exits 0", async () => {
    const h = harness({ spawnChild: vi.fn(async () => 0) });

    expect(
      await runVaultExec(["exec", "--key", "K", "--", "true"], h.deps),
    ).toBe(0);
  });

  it("returns 68 when the command cannot be spawned", async () => {
    const enoent = Object.assign(new Error("spawn nope ENOENT"), {
      code: "ENOENT",
    });
    const h = harness({
      spawnChild: vi.fn(async () => {
        throw enoent;
      }),
    });

    const code = await runVaultExec(
      ["exec", "--key", "K", "--", "nope"],
      h.deps,
    );

    expect(code).toBe(EXIT.SPAWN_FAILED);
  });
});

describe("runVault — subcommand dispatch", () => {
  it("rejects an unknown subcommand with the usage exit code and names it", async () => {
    const h = harness();

    const code = await runVaultExec(["lst", "--app", "dispatch"], h.deps);

    expect(code).toBe(EXIT.USAGE);
    expect(h.stderrText()).toContain("lst");
    expect(h.listSecrets).not.toHaveBeenCalled();
    expect(h.spawnChild).not.toHaveBeenCalled();
  });

  it("rejects no subcommand at all rather than defaulting to one", async () => {
    const h = harness();

    expect(await runVaultExec([], h.deps)).toBe(EXIT.USAGE);
    expect(h.listSecrets).not.toHaveBeenCalled();
  });

  it("lists every subcommand in the top-level usage", async () => {
    const h = harness();

    const code = await runVaultExec(["--help"], h.deps);

    expect(code).toBe(0);
    expect(h.stdoutText()).toContain("exec");
    expect(h.stdoutText()).toContain("list");
    expect(h.stdoutText()).toContain("add");
    expect(h.stdoutText()).toContain("env");
    expect(formatVaultUsage()).toContain("list");
    expect(formatVaultUsage()).toContain("add");
    expect(formatVaultUsage()).toContain("env");
  });
});

describe("runVaultExec — list", () => {
  it("prints the credential keys and their display names", async () => {
    const h = harness();

    const code = await runVaultExec(["list"], h.deps);

    expect(code).toBe(0);
    expect(h.listSecrets).toHaveBeenCalledWith(
      expect.objectContaining({ serverName: "dispatch" }),
    );
    const out = h.stdoutText();
    expect(out).toContain("ANTHROPIC_API_KEY");
    expect(out).toContain("Anthropic (prod)");
    expect(out).toContain("STRIPE_KEY");
    expect(out).toContain("Stripe");
  });

  it("never prints a value, even when the deployment returns one", async () => {
    const h = harness();

    await runVaultExec(["list"], h.deps);

    expect(h.stdoutText()).not.toContain(FAKE_VALUE);
    expect(h.stderrText()).not.toContain(FAKE_VALUE);
    expect(h.stdoutText()).not.toContain("fake-bearer");
  });

  it("takes the deployment as an argument on the subcommand", async () => {
    const h = harness({
      discoverConnectedApps: vi.fn(() => [app("dispatch"), app("plan")]),
    });

    const code = await runVaultExec(["list", "--app", "plan"], h.deps);

    expect(code).toBe(0);
    expect(h.listSecrets).toHaveBeenCalledWith(
      expect.objectContaining({
        serverName: "plan",
        bearer: "fake-bearer-plan",
      }),
    );
  });

  it("refuses with 66 when several apps are connected and none selected", async () => {
    const h = harness({
      discoverConnectedApps: vi.fn(() => [app("dispatch"), app("plan")]),
    });

    const code = await runVaultExec(["list"], h.deps);

    expect(code).toBe(EXIT.AMBIGUOUS_APP);
    expect(h.stderrText()).toContain("plan");
    expect(h.listSecrets).not.toHaveBeenCalled();
  });

  it("returns 65 when no app is connected on this machine", async () => {
    const h = harness({ discoverConnectedApps: vi.fn(() => []) });

    expect(await runVaultExec(["list"], h.deps)).toBe(EXIT.NO_CREDENTIAL);
    expect(h.listSecrets).not.toHaveBeenCalled();
  });

  it("reports a broken client config as 65 naming the file", async () => {
    const h = harness({
      discoverConnectedApps: vi.fn(() => {
        throw new Error(
          "Cannot parse JSON config file: /home/dev/.claude.json",
        );
      }),
    });

    const code = await runVaultExec(["list"], h.deps);

    expect(code).toBe(EXIT.NO_CREDENTIAL);
    expect(h.stderrText()).toContain("/home/dev/.claude.json");
  });

  it("returns 64 on an unknown option and never calls the deployment", async () => {
    const h = harness();

    const code = await runVaultExec(["list", "--all"], h.deps);

    expect(code).toBe(EXIT.USAGE);
    expect(h.stderrText()).toContain("Unknown option: --all");
    expect(h.listSecrets).not.toHaveBeenCalled();
  });

  it("returns 64 on a stray positional", async () => {
    const h = harness();

    expect(await runVaultExec(["list", "dispatch"], h.deps)).toBe(EXIT.USAGE);
    expect(h.listSecrets).not.toHaveBeenCalled();
  });

  it("surfaces a refusal from the deployment with its own exit code", async () => {
    const h = harness({
      listSecrets: vi.fn(async () => {
        throw new Error("Vault list refused by dispatch: HTTP 401");
      }),
    });

    const code = await runVaultExec(["list"], h.deps);

    expect(code).toBe(EXIT.REQUEST_REFUSED);
    expect(h.stderrText()).toContain("HTTP 401");
  });

  it("says the vault is empty rather than printing nothing at all", async () => {
    const h = harness({ listSecrets: vi.fn(async () => []) });

    const code = await runVaultExec(["list"], h.deps);

    expect(code).toBe(0);
    expect(h.stdoutText()).toBe("");
    expect(h.stderrText().toLowerCase()).toContain("no secrets");
  });

  it("shows help without contacting the deployment", async () => {
    const h = harness();

    const code = await runVaultExec(["list", "--help"], h.deps);

    expect(code).toBe(0);
    expect(h.stdoutText()).toContain("--app");
    expect(h.listSecrets).not.toHaveBeenCalled();
  });

  it("prints a key whose secret has no display name", async () => {
    const h = harness({
      listSecrets: vi.fn(async () => [{ credentialKey: "LONELY_KEY" }]),
    });

    const code = await runVaultExec(["list"], h.deps);

    expect(code).toBe(0);
    expect(h.stdoutText()).toContain("LONELY_KEY");
  });
});

describe("runVaultExec — add", () => {
  it("creates the secret with the value read from the prompt", async () => {
    const h = harness();

    const code = await runVaultExec(
      ["add", "MY_API_TOKEN", "Vendor API token"],
      h.deps,
    );

    expect(code).toBe(0);
    expect(h.promptSecret).toHaveBeenCalledTimes(1);
    expect(h.createSecret).toHaveBeenCalledWith(
      {
        credentialKey: "MY_API_TOKEN",
        name: "Vendor API token",
        value: FAKE_VALUE,
      },
      expect.objectContaining({ serverName: "dispatch" }),
    );
  });

  it("has no way to pass the value in argv: there is no value flag", async () => {
    const h = harness();

    const code = await runVaultExec(
      ["add", "MY_API_TOKEN", "Vendor API token", "--value", FAKE_VALUE],
      h.deps,
    );

    expect(code).toBe(EXIT.USAGE);
    expect(h.createSecret).not.toHaveBeenCalled();
    expect(h.promptSecret).not.toHaveBeenCalled();
    expect(h.stderrText()).toContain("Unknown option: --value");
  });

  it("has no way to pass the value in argv: a third positional is refused", async () => {
    const h = harness();

    const code = await runVaultExec(
      ["add", "MY_API_TOKEN", "Vendor API token", FAKE_VALUE],
      h.deps,
    );

    expect(code).toBe(EXIT.USAGE);
    expect(h.createSecret).not.toHaveBeenCalled();
    expect(h.promptSecret).not.toHaveBeenCalled();
  });

  it("sends whatever the prompt returned, so stdin is the only source", async () => {
    const h = harness({
      promptSecret: vi.fn(async () => "typed-at-the-prompt"),
    });

    await runVaultExec(
      ["add", "MY_API_TOKEN", "Vendor API token", "--app", "dispatch"],
      h.deps,
    );

    const [draft] = h.createSecret.mock.calls[0];
    expect(draft.value).toBe("typed-at-the-prompt");
  });

  it("takes the deployment as an argument on the subcommand", async () => {
    const h = harness({
      discoverConnectedApps: vi.fn(() => [app("dispatch"), app("plan")]),
    });

    const code = await runVaultExec(
      ["add", "K", "A key", "--app", "plan"],
      h.deps,
    );

    expect(code).toBe(0);
    expect(h.createSecret).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        serverName: "plan",
        bearer: "fake-bearer-plan",
      }),
    );
  });

  it("never prints the value, not even the one the deployment echoes back", async () => {
    const h = harness();

    await runVaultExec(["add", "K", "A key"], h.deps);

    expect(h.stdoutText()).not.toContain(FAKE_VALUE);
    expect(h.stderrText()).not.toContain(FAKE_VALUE);
    expect(h.stderrText()).not.toContain("fake-bearer");
  });

  it("does not prompt before it knows which deployment it is talking to", async () => {
    const h = harness({ discoverConnectedApps: vi.fn(() => []) });

    expect(await runVaultExec(["add", "K", "A key"], h.deps)).toBe(
      EXIT.NO_CREDENTIAL,
    );
    expect(h.promptSecret).not.toHaveBeenCalled();
    expect(h.createSecret).not.toHaveBeenCalled();
  });

  it("refuses with 66 when several apps are connected and none selected", async () => {
    const h = harness({
      discoverConnectedApps: vi.fn(() => [app("dispatch"), app("plan")]),
    });

    const code = await runVaultExec(["add", "K", "A key"], h.deps);

    expect(code).toBe(EXIT.AMBIGUOUS_APP);
    expect(h.promptSecret).not.toHaveBeenCalled();
  });

  it("refuses an empty value rather than storing one", async () => {
    const h = harness({ promptSecret: vi.fn(async () => "") });

    const code = await runVaultExec(["add", "K", "A key"], h.deps);

    expect(code).toBe(EXIT.NO_VALUE);
    expect(h.createSecret).not.toHaveBeenCalled();
    expect(h.stderrText()).toContain("No value");
  });

  it("does not report an unreadable terminal as a malformed command", async () => {
    const h = harness({
      promptSecret: vi.fn(async () => {
        throw new Error("Standard input closed before a value was entered.");
      }),
    });

    const code = await runVaultExec(["add", "K", "A key"], h.deps);

    expect(code).toBe(EXIT.NO_VALUE);
    expect(code).not.toBe(EXIT.USAGE);
    expect(h.createSecret).not.toHaveBeenCalled();
    expect(h.stderrText()).toContain("closed before a value");
  });

  it("confirms the key the deployment stored, not the one that was typed", async () => {
    const h = harness({
      createSecret: vi.fn(async () => ({ credentialKey: "NORMALIZED_KEY" })),
    });

    await runVaultExec(["add", " NORMALIZED_KEY ", "A key"], h.deps);

    expect(h.stderrText()).toContain("NORMALIZED_KEY");
  });

  it("keeps a value the operator typed with surrounding whitespace intact", async () => {
    const h = harness({ promptSecret: vi.fn(async () => "  padded  ") });

    await runVaultExec(["add", "K", "A key"], h.deps);

    const [draft] = h.createSecret.mock.calls[0];
    expect(draft.value).toBe("  padded  ");
  });

  it("surfaces a refusal from the deployment with its own exit code", async () => {
    const h = harness({
      createSecret: vi.fn(async () => {
        throw new Error("Vault add refused by dispatch: HTTP 403");
      }),
    });

    const code = await runVaultExec(["add", "K", "A key"], h.deps);

    expect(code).toBe(EXIT.REQUEST_REFUSED);
    expect(h.stderrText()).toContain("HTTP 403");
  });

  it("returns 64 when the description is missing and never prompts", async () => {
    const h = harness();

    const code = await runVaultExec(["add", "K"], h.deps);

    expect(code).toBe(EXIT.USAGE);
    expect(h.promptSecret).not.toHaveBeenCalled();
    expect(h.createSecret).not.toHaveBeenCalled();
  });

  it("returns 64 when no key is given at all", async () => {
    const h = harness();

    expect(await runVaultExec(["add"], h.deps)).toBe(EXIT.USAGE);
    expect(h.promptSecret).not.toHaveBeenCalled();
  });

  it("shows help without prompting or contacting the deployment", async () => {
    const h = harness();

    const code = await runVaultExec(["add", "--help"], h.deps);

    expect(code).toBe(0);
    expect(h.stdoutText()).toContain("--app");
    expect(h.promptSecret).not.toHaveBeenCalled();
    expect(h.createSecret).not.toHaveBeenCalled();
  });

  it("says in its usage that the value is never an argument", async () => {
    expect(formatVaultAddUsage()).toContain("argv");
    expect(formatVaultUsage()).toContain("add");
  });

  it("confirms the write by naming the key, on stderr, leaving stdout clean", async () => {
    const h = harness();

    await runVaultExec(["add", "MY_API_TOKEN", "Vendor API token"], h.deps);

    expect(h.stderrText()).toContain("MY_API_TOKEN");
    expect(h.stdoutText()).toBe("");
  });
});

describe("runVaultExec — env", () => {
  it("emits a shell assignment for every leased key", async () => {
    const h = harness();

    const code = await runVaultExec(
      ["env", "--key", "A", "--key", "B"],
      h.deps,
    );

    expect(code).toBe(0);
    const out = h.stdoutText();
    expect(out).toContain(`export A='${FAKE_VALUE}'`);
    expect(out).toContain(`export B='${FAKE_VALUE}'`);
  });

  it("leases through the same audited path as exec, with the same receipt", async () => {
    const h = harness();

    await runVaultExec(["env", "--key", "A"], h.deps);

    // Same dependency, same argument shape as the exec happy path: one lease,
    // one audit record, only the output shape differs.
    expect(h.leaseSecrets).toHaveBeenCalledWith(
      ["A"],
      "lease-0001",
      expect.objectContaining({ serverName: "dispatch" }),
    );
    expect(h.stdoutText()).toContain(
      "export AGENT_NATIVE_VAULT_LEASE='lease-0001'",
    );
    expect(h.stderrText()).toContain("lease-0001");
    expect(h.spawnChild).not.toHaveBeenCalled();
  });

  it("says plainly that it is weaker than running a child process", async () => {
    const h = harness();

    await runVaultExec(["env", "--key", "A"], h.deps);

    const warning = h.stderrText().toLowerCase();
    expect(warning).toContain("weaker");
    expect(warning).toContain("vault exec");
  });

  it("quotes a value that contains a quote so the output stays sourceable", async () => {
    const h = harness({
      leaseSecrets: vi.fn(async (keys: string[], leaseId: string) => ({
        leaseId,
        env: { A: `it's ${FAKE_VALUE}` },
      })),
    });

    const code = await runVaultExec(["env", "--key", "A"], h.deps);

    expect(code).toBe(0);
    expect(h.stdoutText()).toContain(`export A='it'\\''s ${FAKE_VALUE}'`);
  });

  it("takes the deployment as an argument on the subcommand", async () => {
    const h = harness({
      discoverConnectedApps: vi.fn(() => [app("dispatch"), app("plan")]),
    });

    const code = await runVaultExec(
      ["env", "--app", "plan", "--key", "A"],
      h.deps,
    );

    expect(code).toBe(0);
    expect(h.leaseSecrets).toHaveBeenCalledWith(
      ["A"],
      "lease-0001",
      expect.objectContaining({
        serverName: "plan",
        bearer: "fake-bearer-plan",
      }),
    );
  });

  it("refuses a key that cannot become a shell variable, before leasing", async () => {
    const h = harness();

    const code = await runVaultExec(["env", "--key", "A,B"], h.deps);

    expect(code).toBe(EXIT.USAGE);
    expect(h.stderrText()).toContain("A,B");
    expect(h.leaseSecrets).not.toHaveBeenCalled();
    expect(h.stdoutText()).toBe("");
  });

  it("returns 64 with no --key and never contacts the deployment", async () => {
    const h = harness();

    const code = await runVaultExec(["env"], h.deps);

    expect(code).toBe(EXIT.USAGE);
    expect(h.leaseSecrets).not.toHaveBeenCalled();
  });

  it("returns 64 on an unknown option", async () => {
    const h = harness();

    const code = await runVaultExec(["env", "--all"], h.deps);

    expect(code).toBe(EXIT.USAGE);
    expect(h.stderrText()).toContain("Unknown option: --all");
    expect(h.leaseSecrets).not.toHaveBeenCalled();
  });

  it("refuses with 66 when several apps are connected and none selected", async () => {
    const h = harness({
      discoverConnectedApps: vi.fn(() => [app("dispatch"), app("plan")]),
    });

    const code = await runVaultExec(["env", "--key", "A"], h.deps);

    expect(code).toBe(EXIT.AMBIGUOUS_APP);
    expect(h.leaseSecrets).not.toHaveBeenCalled();
  });

  it("returns 65 when no app is connected on this machine", async () => {
    const h = harness({ discoverConnectedApps: vi.fn(() => []) });

    expect(await runVaultExec(["env", "--key", "A"], h.deps)).toBe(
      EXIT.NO_CREDENTIAL,
    );
    expect(h.leaseSecrets).not.toHaveBeenCalled();
  });

  it("returns 67 on a refused lease and emits nothing on stdout", async () => {
    const h = harness({
      leaseSecrets: vi.fn(async () => {
        throw new Error(
          "Vault lease refused (all-or-nothing): no vault secret for A",
        );
      }),
    });

    const code = await runVaultExec(["env", "--key", "A"], h.deps);

    expect(code).toBe(EXIT.LEASE_REFUSED);
    expect(h.stdoutText()).toBe("");
  });

  it("names the lease variable when the receipt overrides a leased value", async () => {
    const h = harness();

    const code = await runVaultExec(
      ["env", "--key", "AGENT_NATIVE_VAULT_LEASE"],
      h.deps,
    );

    expect(code).toBe(0);
    // Last assignment wins in the sourcing shell, so the receipt is what
    // survives — and the caller is told, by name and never by value.
    const lines = h.stdoutText().split("\n");
    expect(lines.at(-1)).toBe("export AGENT_NATIVE_VAULT_LEASE='lease-0001'");
    expect(h.stderrText()).toContain("AGENT_NATIVE_VAULT_LEASE");
    expect(h.stderrText()).not.toContain(FAKE_VALUE);
  });

  it("shows help without leasing, and the help states the weakness", async () => {
    const h = harness();

    const code = await runVaultExec(["env", "--help"], h.deps);

    expect(code).toBe(0);
    expect(h.stdoutText().toLowerCase()).toContain("weaker");
    expect(h.leaseSecrets).not.toHaveBeenCalled();
    expect(formatVaultEnvUsage()).toContain("--app");
  });
});

describe("promptForSecretValue", () => {
  function streams() {
    const input = new PassThrough();
    const output = new PassThrough();
    const written: string[] = [];
    output.on("data", (chunk) => written.push(String(chunk)));
    return { input, output, written: () => written.join("") };
  }

  it("resolves on Enter, without the terminal ever sending EOF", async () => {
    const { input, output, written } = streams();

    const pending = promptForSecretValue("Value for K: ", { input, output });
    input.write(`${FAKE_VALUE}\n`);

    await expect(pending).resolves.toBe(FAKE_VALUE);
    // Still open: the operator pressed Enter, not Ctrl-D.
    expect(input.writableEnded).toBe(false);
    expect(written()).not.toContain(FAKE_VALUE);
  });

  it("does not echo the typed characters", async () => {
    const { input, output, written } = streams();

    const pending = promptForSecretValue("Value for K: ", { input, output });
    for (const char of FAKE_VALUE) input.write(char);
    input.write("\n");

    await pending;
    expect(written()).not.toContain(FAKE_VALUE);
    expect(written()).not.toContain(FAKE_VALUE.slice(0, 4));
  });

  it("prints the prompt itself, so the operator knows what is being asked", async () => {
    const { input, output, written } = streams();

    const pending = promptForSecretValue("Value for K: ", { input, output });
    input.write("x\n");
    await pending;

    expect(written()).toContain("Value for K:");
  });

  it("rejects when standard input ends before a value is entered", async () => {
    const { input, output } = streams();

    const pending = promptForSecretValue("Value for K: ", { input, output });
    input.end();

    await expect(pending).rejects.toThrow(/closed before/i);
  });
});

describe("runVaultExec — no secret value ever reaches stderr", () => {
  const cases: {
    name: string;
    argv: string[];
    deps: Partial<VaultExecDeps>;
  }[] = [
    { name: "usage error", argv: ["exec", "--key", "K"], deps: {} },
    {
      name: "no connected app",
      argv: ["exec", "--key", "K", "--", "true"],
      deps: { discoverConnectedApps: vi.fn(() => []) },
    },
    {
      name: "ambiguous app",
      argv: ["exec", "--key", "K", "--", "true"],
      deps: {
        discoverConnectedApps: vi.fn(() => [app("a"), app("b")]),
      },
    },
    {
      name: "lease refused",
      argv: ["exec", "--key", "K", "--", "true"],
      deps: {
        leaseSecrets: vi.fn(async () => {
          throw new Error(`refused: ${"K"}`);
        }),
      },
    },
    {
      name: "spawn failed",
      argv: ["exec", "--key", "K", "--", "nope"],
      deps: {
        spawnChild: vi.fn(async () => {
          throw new Error("spawn nope ENOENT");
        }),
      },
    },
    {
      name: "child failed",
      argv: ["exec", "--key", "K", "--", "false"],
      deps: { spawnChild: vi.fn(async () => 1) },
    },
    { name: "list", argv: ["list"], deps: {} },
    {
      name: "list refused",
      argv: ["list"],
      deps: {
        listSecrets: vi.fn(async () => {
          throw new Error("Vault list refused by dispatch: HTTP 401");
        }),
      },
    },
    { name: "unknown subcommand", argv: ["lst"], deps: {} },
    { name: "add", argv: ["add", "K", "A key"], deps: {} },
    {
      name: "add refused",
      argv: ["add", "K", "A key"],
      deps: {
        createSecret: vi.fn(async () => {
          throw new Error("Vault add refused by dispatch: HTTP 403");
        }),
      },
    },
    {
      name: "add with an empty value",
      argv: ["add", "K", "A key"],
      deps: { promptSecret: vi.fn(async () => "") },
    },
    // `env` prints values on stdout by design; stderr still must not carry one.
    { name: "env", argv: ["env", "--key", "K"], deps: {} },
    {
      name: "env lease refused",
      argv: ["env", "--key", "K"],
      deps: {
        leaseSecrets: vi.fn(async () => {
          throw new Error("refused: K");
        }),
      },
    },
    { name: "env usage error", argv: ["env"], deps: {} },
  ];

  for (const { name, argv, deps } of cases) {
    it(`prints no leased value on: ${name}`, async () => {
      const h = harness({ env: { K: "stale-shell-export" }, ...deps });

      await runVaultExec(argv, h.deps);

      expect(h.stderrText()).not.toContain(FAKE_VALUE);
      expect(h.stderrText()).not.toContain("stale-shell-export");
      expect(h.stderrText()).not.toContain("fake-bearer");
    });
  }
});

describe("discoverConnectedApps", () => {
  const created: string[] = [];

  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of created.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  function sandbox(): { home: string; project: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "vault-exec-"));
    created.push(root);
    const home = path.join(root, "home");
    const project = path.join(root, "project");
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    vi.stubEnv("HOME", home);
    vi.stubEnv("XDG_CONFIG_HOME", path.join(home, ".config"));
    // Codex resolves its config from CODEX_HOME before $HOME, so leaving the
    // developer's real value set would read their actual bearers.
    vi.stubEnv("CODEX_HOME", path.join(home, ".codex"));
    return { home, project };
  }

  it("reads the bearer and URL out of a Claude Code user config", () => {
    const { home, project } = sandbox();
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          dispatch: {
            type: "http",
            url: "https://dispatch.test/mcp",
            headers: { Authorization: "Bearer fake-connect-bearer" },
          },
        },
      }),
    );

    const apps = discoverConnectedApps(project);

    expect(apps).toContainEqual(
      expect.objectContaining({
        serverName: "dispatch",
        url: "https://dispatch.test/mcp",
        bearer: "fake-connect-bearer",
      }),
    );
  });

  it("skips entries with no bearer rather than reporting a half-resolved app", () => {
    const { home, project } = sandbox();
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          oauth: { type: "http", url: "https://oauth.test/mcp" },
          local: { command: "node", args: ["server.js"] },
        },
      }),
    );

    expect(discoverConnectedApps(project)).toEqual([]);
  });

  it("reads a Codex TOML entry with inline http_headers", () => {
    const { home, project } = sandbox();
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codex", "config.toml"),
      [
        '[mcp_servers."plan"]',
        'url = "https://plan.test/mcp"',
        'http_headers = { "Authorization" = "Bearer fake-codex-bearer" }',
        "",
      ].join("\n"),
    );

    expect(discoverConnectedApps(project)).toContainEqual(
      expect.objectContaining({
        serverName: "plan",
        url: "https://plan.test/mcp",
        bearer: "fake-codex-bearer",
        client: "codex",
      }),
    );
  });

  it("reads a Codex entry whose http_headers live in a sub-table", () => {
    const { home, project } = sandbox();
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(
      path.join(home, ".codex", "config.toml"),
      [
        '[mcp_servers."plan"]',
        'url = "https://plan.test/mcp"',
        "",
        '[mcp_servers."plan".http_headers]',
        'Authorization = "Bearer fake-subtable-bearer"',
        "",
      ].join("\n"),
    );

    expect(discoverConnectedApps(project)).toContainEqual(
      expect.objectContaining({
        serverName: "plan",
        bearer: "fake-subtable-bearer",
      }),
    );
  });

  it("finds a project-scoped .mcp.json entry", () => {
    const { project } = sandbox();
    fs.writeFileSync(
      path.join(project, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          local: {
            type: "http",
            url: "http://localhost:3000/mcp",
            headers: { Authorization: "Bearer fake-project-bearer" },
          },
        },
      }),
    );

    expect(discoverConnectedApps(project)).toContainEqual(
      expect.objectContaining({
        serverName: "local",
        bearer: "fake-project-bearer",
      }),
    );
  });

  it("returns nothing when no client config exists", () => {
    const { project } = sandbox();

    expect(discoverConnectedApps(project)).toEqual([]);
  });

  it("throws on a broken config when it is the only one", () => {
    const { home, project } = sandbox();
    fs.writeFileSync(path.join(home, ".claude.json"), "{ not json");

    expect(() => discoverConnectedApps(project)).toThrow(/Cannot parse/);
  });

  it("keeps a working bearer when an unrelated client config is broken", () => {
    const { home, project } = sandbox();
    fs.writeFileSync(
      path.join(home, ".claude.json"),
      JSON.stringify({
        mcpServers: {
          dispatch: {
            type: "http",
            url: "https://dispatch.test/mcp",
            headers: { Authorization: "Bearer fake-connect-bearer" },
          },
        },
      }),
    );
    fs.mkdirSync(path.join(home, ".cursor"), { recursive: true });
    fs.writeFileSync(path.join(home, ".cursor", "mcp.json"), "{ not json");

    const warnings: string[] = [];
    const apps = discoverConnectedApps(project, (line) => warnings.push(line));

    expect(apps.map((a) => a.serverName)).toEqual(["dispatch"]);
    expect(warnings.join("\n")).toContain("mcp.json");
  });

  it("reports a broken config as 65 naming the file, not as an unconnected machine", async () => {
    const h = harness({
      discoverConnectedApps: vi.fn(() => {
        throw new Error(
          "Cannot parse JSON config file: /home/dev/.claude.json",
        );
      }),
    });

    const code = await runVaultExec(
      ["exec", "--key", "K", "--", "true"],
      h.deps,
    );

    expect(code).toBe(EXIT.NO_CREDENTIAL);
    expect(h.stderrText()).toContain("/home/dev/.claude.json");
    expect(h.spawnChild).not.toHaveBeenCalled();
  });
});

describe("leaseSecrets", () => {
  function stubFetch(status: number, body: unknown) {
    const fetchMock = vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts to the action route with the bearer and returns the env map", async () => {
    const fetchMock = stubFetch(200, {
      leaseId: "lease-0001",
      env: { K: FAKE_VALUE },
    });

    const lease = await leaseSecrets(["K"], "lease-0001", app("dispatch"));

    expect(lease).toEqual({ leaseId: "lease-0001", env: { K: FAKE_VALUE } });
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe(
      "https://dispatch.test/_agent-native/actions/lease-vault-secrets",
    );
    expect(init.headers.authorization).toBe("Bearer fake-bearer-dispatch");
    // Same explicit agent as every other vault call: the edge proxy in front of
    // at least one deployment rejects a default runtime agent string outright.
    expect(init.headers["user-agent"]).toBeTruthy();
    expect(JSON.parse(init.body)).toEqual({
      keys: ["K"],
      leaseId: "lease-0001",
    });
  });

  it("surfaces the refusal from the route's `error` field, not a bare status", async () => {
    stubFetch(400, {
      error:
        "Vault lease lease-0001 refused (all-or-nothing): no vault secret for A, B",
    });

    await expect(
      leaseSecrets(["A", "B"], "lease-0001", app("dispatch")),
    ).rejects.toThrow(/no vault secret for A, B/);
  });

  it("refuses a 200 that returned no env map rather than leasing nothing", async () => {
    stubFetch(200, { leaseId: "lease-0001" });

    await expect(
      leaseSecrets(["K"], "lease-0001", app("dispatch")),
    ).rejects.toThrow(/no env map/);
  });

  it("refuses a 200 that silently dropped a requested key", async () => {
    stubFetch(200, { leaseId: "lease-0001", env: { A: FAKE_VALUE } });

    await expect(
      leaseSecrets(["A", "B"], "lease-0001", app("dispatch")),
    ).rejects.toThrow(/did not return values for: B/);
  });
});

describe("listVaultSecrets", () => {
  function stubFetch(status: number, body: unknown) {
    const fetchMock = vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("gets the action route with the bearer and an explicit user agent", async () => {
    const fetchMock = stubFetch(200, [
      { credentialKey: "K", name: "Key", value: FAKE_VALUE },
    ]);

    const secrets = await listVaultSecrets(app("dispatch"));

    expect(secrets).toEqual([{ credentialKey: "K", name: "Key" }]);
    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe(
      "https://dispatch.test/_agent-native/actions/list-vault-secrets",
    );
    expect(init.method).toBe("GET");
    expect(init.headers.authorization).toBe("Bearer fake-bearer-dispatch");
    // A default runtime agent string is rejected outright by the edge proxy in
    // front of at least one deployment, and the failure looks like a disabled
    // route rather than a rejected client.
    expect(init.headers["user-agent"]).toBeTruthy();
  });

  it("surfaces the refusal from the route's `error` field, not a bare status", async () => {
    stubFetch(403, { error: "Vault access is not granted for this app" });

    await expect(listVaultSecrets(app("dispatch"))).rejects.toThrow(
      /not granted/,
    );
  });

  it("refuses a 200 that is not a secret list rather than reporting an empty vault", async () => {
    stubFetch(200, { ok: true });

    await expect(listVaultSecrets(app("dispatch"))).rejects.toThrow(
      /secret list/,
    );
  });

  it("refuses a row with no credential key rather than printing a blank one", async () => {
    stubFetch(200, [{ name: "Nameless" }]);

    await expect(listVaultSecrets(app("dispatch"))).rejects.toThrow(
      /credentialKey/,
    );
  });
});

describe("createVaultSecret", () => {
  function stubFetch(status: number, body: unknown) {
    const fetchMock = vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
    }));
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  }

  const draft = {
    credentialKey: "MY_API_TOKEN",
    name: "Vendor API token",
    value: FAKE_VALUE,
  };

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts the draft to the action route with the bearer and an explicit user agent", async () => {
    const fetchMock = stubFetch(200, {
      id: "sec_1",
      credentialKey: "MY_API_TOKEN",
      value: FAKE_VALUE,
    });

    await createVaultSecret(draft, app("dispatch"));

    const [url, init] = fetchMock.mock.calls[0] as any;
    expect(url).toBe(
      "https://dispatch.test/_agent-native/actions/create-vault-secret",
    );
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual(draft);
    expect(init.headers.authorization).toBe("Bearer fake-bearer-dispatch");
    // A default runtime agent string is rejected outright by the edge proxy in
    // front of at least one deployment.
    expect(init.headers["user-agent"]).toBeTruthy();
  });

  it("carries no value out of the deployment's reply, which contains one", async () => {
    stubFetch(200, {
      id: "sec_1",
      credentialKey: "MY_API_TOKEN",
      value: FAKE_VALUE,
    });

    const stored = await createVaultSecret(draft, app("dispatch"));

    expect(stored).toEqual({ credentialKey: "MY_API_TOKEN" });
    expect(JSON.stringify(stored)).not.toContain(FAKE_VALUE);
  });

  it("surfaces the refusal from the route's `error` field, not a bare status", async () => {
    stubFetch(403, { error: "Vault writes require an admin" });

    await expect(createVaultSecret(draft, app("dispatch"))).rejects.toThrow(
      /require an admin/,
    );
  });

  it("refuses a 200 that names no stored secret, without claiming it was stored", async () => {
    stubFetch(200, { ok: true });

    await expect(createVaultSecret(draft, app("dispatch"))).rejects.toThrow(
      /whether it was stored is unknown/,
    );
  });

  it("names the deployment rather than the value when the call cannot be made", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("getaddrinfo ENOTFOUND dispatch.test");
      }),
    );

    await expect(createVaultSecret(draft, app("dispatch"))).rejects.toThrow(
      /Could not reach dispatch/,
    );
  });
});

describe("vault exec --help", () => {
  it("states plainly that this is hygiene, not containment", async () => {
    const h = harness();

    const code = await runVaultExec(["exec", "--help"], h.deps);

    expect(code).toBe(0);
    const help = h.stdoutText();
    expect(help).toContain("hygiene");
    expect(help).toContain("not containment");
    expect(help.toLowerCase()).toContain("does not prevent");
    expect(h.spawnChild).not.toHaveBeenCalled();
  });

  it("documents --app as a credential source rather than a scope", async () => {
    expect(formatVaultExecUsage()).toContain("credential source");
  });

  it("documents that there is no --all", async () => {
    expect(formatVaultExecUsage()).toContain("--all");
  });
});
