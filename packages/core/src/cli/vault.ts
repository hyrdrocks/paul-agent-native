import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";

import {
  CLIENTS,
  canonicalUrl,
  configPathFor,
  readMcpConnectionsForClient,
  type ClientId,
} from "./mcp-config-writers.js";

/**
 * Private exit codes so `vault exec` never impersonates the command it wrapped.
 * A plain `1` would collapse "the lease was refused" into "the tests failed".
 * The child's own exit code propagates unchanged, which is why the wrapper's
 * own failures live in the sysexits.h range instead.
 */
export const EXIT = {
  USAGE: 64, // malformed invocation (EX_USAGE)
  NO_CREDENTIAL: 65, // no connect bearer found on this machine
  AMBIGUOUS_APP: 66, // several connected apps, none selected
  LEASE_REFUSED: 67, // server said no (missing key, ambiguous key, auth)
  SPAWN_FAILED: 68, // command not found / not executable
} as const;

/** Matches `lease-vault-secrets`, which refuses more than 50 keys server-side. */
const MAX_LEASED_KEYS = 50;

const LEASE_ACTION = "lease-vault-secrets";
const LEASE_ENV_VAR = "AGENT_NATIVE_VAULT_LEASE";

/**
 * One connected app as found in a coding agent's own MCP config. The URL and
 * the bearer arrive together from a single entry, so a candidate is never half
 * resolved.
 */
export interface ConnectedApp {
  serverName: string;
  url: string;
  bearer: string;
  /** Which client config the entry came from — shown when disambiguating. */
  client: string;
  configFile: string;
}

export interface VaultLease {
  leaseId: string;
  env: Record<string, string>;
}

/**
 * The one seam the wrapper is tested through. The behaviours that matter most
 * — never spawning after a refusal, leased-wins merging, exit-code fidelity —
 * sit *between* parsing, resolving, and merging, so pinning those separately
 * would leave the interesting parts untested.
 */
export interface VaultExecDeps {
  discoverConnectedApps: () => ConnectedApp[];
  leaseSecrets: (
    keys: string[],
    leaseId: string,
    app: ConnectedApp,
  ) => Promise<VaultLease>;
  spawnChild: (
    cmd: string,
    args: string[],
    env: Record<string, string>,
  ) => Promise<number>;
  env: Record<string, string | undefined>;
  stderr: (line: string) => void;
  stdout?: (line: string) => void;
  newLeaseId?: () => string;
}

interface ParsedExecArgs {
  help: boolean;
  keys: string[];
  app?: string;
  command?: string;
  commandArgs: string[];
  errors: string[];
}

const VALUE_FLAGS = new Set(["key", "app"]);

/**
 * `--` is mandatory and terminates option parsing, so there is no shell string
 * to quote and nothing to inject: everything after it goes to the child
 * verbatim, including further `--key`-looking tokens.
 */
function parseExecArgv(argv: string[]): ParsedExecArgs {
  const parsed: ParsedExecArgs = {
    help: false,
    keys: [],
    commandArgs: [],
    errors: [],
  };

  const separator = argv.indexOf("--");
  const flags = separator === -1 ? argv : argv.slice(0, separator);
  const rest = separator === -1 ? [] : argv.slice(separator + 1);

  const seenKeys = new Set<string>();
  for (let i = 0; i < flags.length; i += 1) {
    const arg = flags[i];
    if (!arg.startsWith("-")) {
      parsed.errors.push(`Unexpected argument: ${arg}`);
      continue;
    }

    const eqIndex = arg.indexOf("=");
    const name = (
      eqIndex === -1 ? arg.replace(/^--?/, "") : arg.slice(0, eqIndex)
    ).replace(/^--?/, "");
    const inlineValue = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);

    if (name === "help" || name === "h") {
      parsed.help = true;
      continue;
    }
    if (!VALUE_FLAGS.has(name)) {
      parsed.errors.push(`Unknown option: --${name}`);
      continue;
    }

    const next = flags[i + 1];
    const value =
      inlineValue ??
      (next !== undefined && !next.startsWith("-") ? flags[++i] : undefined);
    if (value === undefined || value === "") {
      parsed.errors.push(`Missing value for --${name}`);
      continue;
    }

    if (name === "app") {
      if (parsed.app !== undefined) {
        parsed.errors.push("--app may only be given once");
        continue;
      }
      parsed.app = value;
      continue;
    }

    // Never comma-split: `credentialKey` is free text, so a comma-bearing key
    // is a real key and splitting it would silently lease the wrong thing.
    if (seenKeys.has(value)) {
      parsed.errors.push(`Duplicate --key ${value}`);
      continue;
    }
    seenKeys.add(value);
    parsed.keys.push(value);
  }

  if (parsed.help) return parsed;

  if (separator === -1) {
    parsed.errors.push(
      "Missing `--`. The command to run must follow `--`, e.g. `agent-native vault exec --key K -- pnpm test`.",
    );
  } else if (rest.length === 0) {
    parsed.errors.push("Nothing to run after `--`.");
  } else {
    parsed.command = rest[0];
    parsed.commandArgs = rest.slice(1);
  }

  if (parsed.keys.length === 0) {
    parsed.errors.push(
      "Missing --key. Name every credential explicitly; there is no --all.",
    );
  }
  if (parsed.keys.length > MAX_LEASED_KEYS) {
    parsed.errors.push(
      `Too many keys: ${parsed.keys.length}. A lease covers at most ${MAX_LEASED_KEYS} keys.`,
    );
  }

  return parsed;
}

/**
 * Identity includes the bearer on purpose. The same app in two client configs
 * is one candidate, but the SAME app holding two DIFFERENT bearers is two: one
 * of them may be revoked, and picking by iteration order would spend the wrong
 * credential and report the result as an opaque refusal.
 */
function candidateId(app: ConnectedApp): string {
  return [app.serverName, canonicalUrl(app.url) ?? app.url, app.bearer].join(
    "\n",
  );
}

function distinctApps(apps: ConnectedApp[]): ConnectedApp[] {
  const byId = new Map<string, ConnectedApp>();
  for (const app of apps) {
    if (!byId.has(candidateId(app))) byId.set(candidateId(app), app);
  }
  return [...byId.values()];
}

function describeCandidates(apps: ConnectedApp[]): string {
  return distinctApps(apps)
    .map((app) => `  ${app.serverName}  ${app.url}  (${app.configFile})`)
    .join("\n");
}

type ResolvedApp =
  | { ok: true; app: ConnectedApp }
  | { ok: false; code: number; message: string };

/**
 * `--app` selects a **credential source**, not a principal and not a scope.
 * Several connected apps with none chosen is a refusal naming every candidate,
 * never a guess: inferring from the project's `.mcp.json` would make *which
 * credential authenticated you* depend on where you were standing.
 */
function resolveApp(
  apps: ConnectedApp[],
  requested: string | undefined,
): ResolvedApp {
  const candidates = distinctApps(apps);

  if (candidates.length === 0) {
    return {
      ok: false,
      code: EXIT.NO_CREDENTIAL,
      message:
        "No connected agent-native app found on this machine. Run `agent-native connect <url>` first.",
    };
  }

  const pool = requested
    ? candidates.filter((app) => app.serverName === requested)
    : candidates;

  if (pool.length === 0) {
    return {
      ok: false,
      code: EXIT.NO_CREDENTIAL,
      message: `No connected app named "${requested}". Connected apps:\n${describeCandidates(candidates)}`,
    };
  }
  if (pool.length > 1) {
    const sameName =
      new Set(pool.map((app) => app.serverName)).size < pool.length;
    return {
      ok: false,
      code: EXIT.AMBIGUOUS_APP,
      message: [
        "Several connected credential sources; select one with --app <name>. Candidates:",
        describeCandidates(pool),
        ...(sameName
          ? [
              "Entries sharing a name hold different bearers for the same app - re-run `agent-native connect` so one of them wins.",
            ]
          : []),
      ].join("\n"),
    };
  }
  return { ok: true, app: pool[0] };
}

/**
 * Build the **child** env. This never reads or mutates `process.env` — the env
 * guards forbid both, and a leased-wins merge needs neither.
 *
 * Leased values win. Preferring a stale `export` is a silent-wrong-value bug in
 * a new costume; refusing outright is unusable in any shell direnv has touched.
 * Collisions are reported by key NAME only.
 */
function buildChildEnv(
  base: Record<string, string | undefined>,
  lease: VaultLease,
): { env: Record<string, string>; collisions: string[] } {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) env[key] = value;
  }

  const collisions: string[] = [];
  const overwrite = (key: string, value: string) => {
    if (env[key] !== undefined && env[key] !== value) collisions.push(key);
    env[key] = value;
  };
  for (const [key, value] of Object.entries(lease.env)) overwrite(key, value);
  // Written through the same path so a leased key that happens to be named
  // LEASE_ENV_VAR cannot be replaced without the collision being reported.
  overwrite(LEASE_ENV_VAR, lease.leaseId);
  return { env, collisions };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * `argv` is everything after `agent-native vault`, so the first token is the
 * subcommand — tests exercise the same array the CLI hands over.
 */
export async function runVaultExec(
  argv: string[],
  deps: VaultExecDeps,
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const { stderr } = deps;

  const [subcommand, ...rest] = argv;
  if (subcommand === "--help" || subcommand === "-h" || subcommand === "help") {
    stdout(formatVaultExecUsage());
    return 0;
  }
  if (subcommand !== "exec") {
    stderr(`Unknown vault subcommand: ${subcommand ?? "(none)"}`);
    stderr("");
    stderr(formatVaultExecUsage());
    return EXIT.USAGE;
  }

  const parsed = parseExecArgv(rest);
  if (parsed.help) {
    stdout(formatVaultExecUsage());
    return 0;
  }
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) stderr(error);
    stderr("");
    stderr(formatVaultExecUsage());
    return EXIT.USAGE;
  }

  let discovered: ConnectedApp[];
  try {
    discovered = deps.discoverConnectedApps();
  } catch (err) {
    // A config file that exists but cannot be read is still "no bearer here",
    // but the message has to name the real cause rather than let the developer
    // conclude they never connected.
    stderr(errorMessage(err));
    return EXIT.NO_CREDENTIAL;
  }

  const resolved = resolveApp(discovered, parsed.app);
  if (!resolved.ok) {
    stderr(resolved.message);
    return resolved.code;
  }

  const leaseId = (deps.newLeaseId ?? randomUUID)();
  let lease: VaultLease;
  try {
    lease = await deps.leaseSecrets(parsed.keys, leaseId, resolved.app);
  } catch (err) {
    // The server names every offending key at once and never echoes a value,
    // so its message is safe to surface verbatim.
    stderr(errorMessage(err));
    return EXIT.LEASE_REFUSED;
  }

  const { env, collisions } = buildChildEnv(deps.env, lease);
  for (const key of collisions) {
    stderr(`Leased value overrides the existing environment variable ${key}.`);
  }
  stderr(
    `Vault lease ${lease.leaseId} from ${resolved.app.serverName} (${parsed.keys.length} key(s)). Check the audit log to confirm.`,
  );

  try {
    return await deps.spawnChild(parsed.command!, parsed.commandArgs, env);
  } catch (err) {
    stderr(`Could not run ${parsed.command}: ${errorMessage(err)}`);
    return EXIT.SPAWN_FAILED;
  }
}

export function formatVaultExecUsage(): string {
  return [
    "Usage: agent-native vault exec --key KEY [--key KEY...] [--app NAME] -- <command> [args...]",
    "",
    "Runs <command> with workspace vault secrets in its environment, so a local",
    "agent session never has to paste a credential into a prompt. This wrapper",
    "never prints a leased value, never writes one to disk, and never puts one",
    "in your transcript. <command> inherits this terminal, so what it chooses to",
    "print is its own business.",
    "",
    "Options:",
    "  --key <KEY>     Credential key to lease. Required, repeatable, and never",
    "                  comma-split — `--key A,B` is one key literally named A,B.",
    "                  There is no --all: every key is named explicitly.",
    "  --app <NAME>    Which connected app supplies the credential. This selects a",
    "                  credential source, not a principal and not a scope. With",
    "                  several apps connected and none selected, the command",
    "                  refuses and names them rather than guessing.",
    "  --help          Show this message.",
    "",
    "The lease id is printed to stderr and passed to the child as",
    `  ${LEASE_ENV_VAR}`,
    'so "this was audited" is a claim you can go and check.',
    "",
    "Exit codes (the child's own exit code otherwise propagates unchanged):",
    `  ${EXIT.USAGE}  malformed invocation`,
    `  ${EXIT.NO_CREDENTIAL}  no connect bearer found on this machine`,
    `  ${EXIT.AMBIGUOUS_APP}  several connected apps, none selected`,
    `  ${EXIT.LEASE_REFUSED}  the server refused the lease`,
    `  ${EXIT.SPAWN_FAILED}  the command could not be run`,
    "",
    "WHAT THIS DOES AND DOES NOT CLAIM",
    "  This is hygiene, not containment.",
    "  It keeps secrets out of your transcript on the happy path and leaves an",
    "  audit trail you can check afterwards. That is the whole claim.",
    "  It does not prevent anything running as you from reading those secrets:",
    "  the same connect bearer authenticates the same call from curl, and node",
    "  cannot execve, so this process stays alive holding the leased values",
    "  while the child runs. Anything that can read this process can read them.",
    "  Nothing bounds a CLI lease — the lease id is a receipt, not a boundary.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Real dependencies
// ---------------------------------------------------------------------------

/**
 * The live bearer is the `Authorization: Bearer …` header inside the MCP entry
 * in each client's own config — NOT `~/.agent-native/connect-profiles.json`,
 * which is only a rollback backup. Reading per-client across possibly several
 * files is exactly where `--app`'s ambiguity comes from.
 */
export function discoverConnectedApps(
  baseDir = process.cwd(),
  onUnreadable?: (message: string) => void,
): ConnectedApp[] {
  const apps: ConnectedApp[] = [];
  const seenFiles = new Set<string>();
  const unreadable: string[] = [];

  for (const client of CLIENTS) {
    for (const scope of ["user", "project"] as const) {
      const file = configPathFor(client as ClientId, baseDir, scope);
      // Several clients resolve to the same path -- claude-code and
      // claude-code-cli always do -- and a path only ever has one format.
      if (seenFiles.has(file)) continue;
      seenFiles.add(file);

      let entries;
      try {
        entries = readMcpConnectionsForClient(client as ClientId, file);
      } catch (err) {
        // One client's broken file must not hide another client's working
        // bearer, but it must not vanish either, or the app the developer
        // wanted reads back as one they never connected.
        unreadable.push(errorMessage(err));
        continue;
      }

      for (const entry of entries) {
        const authorization =
          entry.headers.Authorization ?? entry.headers.authorization;
        if (!entry.url || !authorization?.startsWith("Bearer ")) continue;
        const bearer = authorization.slice("Bearer ".length).trim();
        if (!bearer) continue;
        apps.push({
          serverName: entry.serverName,
          url: entry.url,
          bearer,
          client,
          configFile: file,
        });
      }
    }
  }

  if (unreadable.length > 0) {
    if (apps.length === 0) throw new Error(unreadable.join("\n"));
    for (const message of unreadable) onUnreadable?.(message);
  }

  return apps;
}

/** `https://app.example.com/mcp` → `https://app.example.com`. */
function appBaseUrl(mcpUrl: string): string {
  const url = new URL(mcpUrl);
  url.hash = "";
  url.search = "";
  url.pathname = url.pathname
    .replace(/\/+$/, "")
    .replace(/\/_agent-native\/mcp$/, "")
    .replace(/\/mcp$/, "");
  return url.toString().replace(/\/+$/, "");
}

export async function leaseSecrets(
  keys: string[],
  leaseId: string,
  app: ConnectedApp,
): Promise<VaultLease> {
  const url = `${appBaseUrl(app.url)}/_agent-native/actions/${LEASE_ACTION}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${app.bearer}`,
      },
      body: JSON.stringify({ keys, leaseId }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`Could not reach ${app.serverName}: ${errorMessage(err)}`);
  } finally {
    clearTimeout(timeout);
  }

  let json: any = null;
  try {
    json = await response.json();
  } catch {
    json = null;
  }

  if (!response.ok) {
    // The action route reports failures as `{ error }`; `message` is only
    // there for hand-rolled route errors. Reading one and not the other turns
    // "no vault secret for A, B" into a bare status code.
    const detail =
      typeof json?.error === "string" && json.error.trim()
        ? json.error
        : typeof json?.message === "string" && json.message.trim()
          ? json.message
          : `HTTP ${response.status}`;
    throw new Error(
      `Vault lease ${leaseId} refused by ${app.serverName}: ${detail}`,
    );
  }

  // "Absent" and "unreadable" must not collapse into an empty lease: a lease
  // that silently yields no variables would run the child without the
  // credential it asked for and look like success.
  const env = json?.env;
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new Error(
      `Vault lease ${leaseId} returned no env map. Is ${app.serverName} running a core that exposes ${LEASE_ACTION}?`,
    );
  }
  const missing = keys.filter((key) => typeof env[key] !== "string");
  if (missing.length > 0) {
    throw new Error(
      `Vault lease ${leaseId} did not return values for: ${missing.join(", ")}`,
    );
  }

  return { leaseId, env: env as Record<string, string> };
}

export function spawnChild(
  cmd: string,
  args: string[],
  env: Record<string, string>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: "inherit", env });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      // A signalled child has no exit code; mirror the shell's 128+n so the
      // caller never reads a null as a clean zero.
      if (code === null)
        resolve(signal ? 128 + (osSignalNumber(signal) ?? 0) : 1);
      else resolve(code);
    });
  });
}

function osSignalNumber(signal: NodeJS.Signals): number | undefined {
  const numbers: Partial<Record<NodeJS.Signals, number>> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGKILL: 9,
    SIGTERM: 15,
  };
  return numbers[signal];
}

export async function runVault(argv: string[]): Promise<number> {
  return runVaultExec(argv, {
    discoverConnectedApps: () =>
      discoverConnectedApps(process.cwd(), (message) => console.error(message)),
    leaseSecrets,
    spawnChild,
    env: process.env,
    stderr: (line) => console.error(line),
    stdout: (line) => console.log(line),
  });
}
