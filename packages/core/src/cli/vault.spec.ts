import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EXIT,
  discoverConnectedApps,
  leaseSecrets,
  listVaultSecrets,
  formatVaultExecUsage,
  formatVaultUsage,
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

  const deps: VaultExecDeps = {
    discoverConnectedApps,
    leaseSecrets,
    listSecrets,
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
    expect(formatVaultUsage()).toContain("list");
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
