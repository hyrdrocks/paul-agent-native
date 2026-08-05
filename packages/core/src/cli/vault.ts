import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import os from "node:os";
import readline from "node:readline";

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
  REQUEST_REFUSED: 69, // a non-lease vault call was refused or unreachable
  NO_VALUE: 74, // the prompt yielded no value (EX_IOERR)
} as const;

/** Matches `lease-vault-secrets`, which refuses more than 50 keys server-side. */
const MAX_LEASED_KEYS = 50;

const LEASE_ACTION = "lease-vault-secrets";
const LIST_ACTION = "list-vault-secrets";
const CREATE_ACTION = "create-vault-secret";
const LEASE_ENV_VAR = "AGENT_NATIVE_VAULT_LEASE";

/**
 * Load-bearing. The edge proxy in front of at least one deployment rejects a
 * default runtime agent string outright, and the rejection reads exactly like
 * the action route being disabled — so it sends whoever hits it after the
 * wrong problem.
 */
const USER_AGENT = "agent-native-cli";

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
 * What `vault list` is allowed to know about a secret. The value is absent from
 * the type, not merely unprinted: a deployment that starts returning one cannot
 * turn listing into a credential printer by accident.
 */
export interface VaultSecretSummary {
  credentialKey: string;
  name?: string;
}

/**
 * What `vault add` sends. `value` is only ever populated from the prompt: no
 * parser writes this field, so there is no invocation that could put a secret
 * in argv for the process table to show.
 */
export interface VaultSecretDraft {
  credentialKey: string;
  name: string;
  value: string;
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
  listSecrets: (app: ConnectedApp) => Promise<VaultSecretSummary[]>;
  createSecret: (
    draft: VaultSecretDraft,
    app: ConnectedApp,
  ) => Promise<VaultSecretSummary>;
  /** Reads one secret value from the terminal. Never echoes, never returns
   *  until Enter, and throws rather than yielding "" if stdin ends first. */
  promptSecret: (prompt: string) => Promise<string>;
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

interface ParsedFlags {
  help: boolean;
  /** Every occurrence, in order, so a repeatable flag and a once-only flag
   *  are told apart by the subcommand rather than by the parser. */
  values: Map<string, string[]>;
  /** Collected, not rejected here: `add` takes two, `list` and `exec` take
   *  none, and one parser deciding for all three is how the three drift. */
  positionals: string[];
  errors: string[];
}

/**
 * Shared by every vault subcommand, so `list` and `exec` reject the same typo
 * the same way instead of each growing its own dialect.
 */
function parseFlags(tokens: string[], valueFlags: Set<string>): ParsedFlags {
  const parsed: ParsedFlags = {
    help: false,
    values: new Map(),
    positionals: [],
    errors: [],
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const arg = tokens[i];
    if (!arg.startsWith("-")) {
      parsed.positionals.push(arg);
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
    if (!valueFlags.has(name)) {
      parsed.errors.push(`Unknown option: --${name}`);
      continue;
    }

    const next = tokens[i + 1];
    const value =
      inlineValue ??
      (next !== undefined && !next.startsWith("-") ? tokens[++i] : undefined);
    if (value === undefined || value === "") {
      parsed.errors.push(`Missing value for --${name}`);
      continue;
    }

    const seen = parsed.values.get(name);
    if (seen) seen.push(value);
    else parsed.values.set(name, [value]);
  }

  return parsed;
}

/** Every subcommand that spends a lease names its keys and its source alike. */
const LEASE_VALUE_FLAGS = new Set(["key", "app"]);
const LIST_VALUE_FLAGS = new Set(["app"]);
const ADD_VALUE_FLAGS = new Set(["app"]);

/** For the subcommands whose whole argument list is flags. */
function rejectPositionals(flags: ParsedFlags): void {
  for (const extra of flags.positionals) {
    flags.errors.push(`Unexpected argument: ${extra}`);
  }
}

/**
 * A credential key is free text, so it can be something no shell can assign —
 * `A,B` is a legal key and an illegal variable name. `exec` puts such a key in
 * a child's environment unharmed; an assignment cannot carry it, so `env`
 * refuses it before spending a lease rather than emitting a line that would
 * break, or silently reshape, whatever sources it.
 */
const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `--app` is a credential source on every subcommand that takes it. */
function takeApp(flags: ParsedFlags): string | undefined {
  const given = flags.values.get("app") ?? [];
  if (given.length > 1) {
    flags.errors.push("--app may only be given once");
    return undefined;
  }
  return given[0];
}

/** `--key` is named the same way, and refused the same way, on every
 *  subcommand that leases. */
function takeKeys(flags: ParsedFlags): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const key of flags.values.get("key") ?? []) {
    // Never comma-split: `credentialKey` is free text, so a comma-bearing key
    // is a real key and splitting it would silently lease the wrong thing.
    if (seen.has(key)) {
      flags.errors.push(`Duplicate --key ${key}`);
      continue;
    }
    seen.add(key);
    keys.push(key);
  }

  if (keys.length === 0) {
    flags.errors.push(
      "Missing --key. Name every credential explicitly; there is no --all.",
    );
  }
  if (keys.length > MAX_LEASED_KEYS) {
    flags.errors.push(
      `Too many keys: ${keys.length}. A lease covers at most ${MAX_LEASED_KEYS} keys.`,
    );
  }
  return keys;
}

interface ParsedListArgs {
  help: boolean;
  app?: string;
  errors: string[];
}

function parseListArgv(argv: string[]): ParsedListArgs {
  const flags = parseFlags(argv, LIST_VALUE_FLAGS);
  if (flags.help) return { help: true, errors: [] };
  rejectPositionals(flags);
  const app = takeApp(flags);
  return { help: false, ...(app ? { app } : {}), errors: flags.errors };
}

interface ParsedAddArgs {
  help: boolean;
  credentialKey?: string;
  name?: string;
  app?: string;
  errors: string[];
}

/**
 * Exactly two positionals: the key and its description. A third is refused
 * rather than read as the value — an operator who types the secret on the
 * command line has already put it in the process table and their shell
 * history, so the only useful thing left to do is say so.
 */
function parseAddArgv(argv: string[]): ParsedAddArgs {
  const flags = parseFlags(argv, ADD_VALUE_FLAGS);
  if (flags.help) return { help: true, errors: [] };

  const app = takeApp(flags);
  const [credentialKey, name, ...extra] = flags.positionals;

  if (!credentialKey) flags.errors.push("Missing KEY.");
  else if (!name)
    flags.errors.push(`Missing description for ${credentialKey}.`);
  // The rejected token is NOT echoed. If it is the secret the operator tried
  // to pass, repeating it into the transcript is the very leak this command
  // exists to prevent.
  if (extra.length > 0) {
    flags.errors.push(
      `${extra.length} unexpected argument(s) after KEY and description. The secret value is never given on the command line; \`add\` prompts for it.`,
    );
  }

  return {
    help: false,
    ...(credentialKey ? { credentialKey } : {}),
    ...(name ? { name } : {}),
    ...(app ? { app } : {}),
    errors: flags.errors,
  };
}

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
  const flags = parseFlags(
    separator === -1 ? argv : argv.slice(0, separator),
    LEASE_VALUE_FLAGS,
  );
  const rest = separator === -1 ? [] : argv.slice(separator + 1);

  parsed.help = flags.help;
  if (parsed.help) return parsed;

  rejectPositionals(flags);
  parsed.app = takeApp(flags);
  parsed.keys = takeKeys(flags);
  parsed.errors = flags.errors;

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

  return parsed;
}

interface ParsedEnvArgs {
  help: boolean;
  keys: string[];
  app?: string;
  errors: string[];
}

function parseEnvArgv(argv: string[]): ParsedEnvArgs {
  const flags = parseFlags(argv, LEASE_VALUE_FLAGS);
  if (flags.help) return { help: true, keys: [], errors: [] };

  const app = takeApp(flags);
  const keys = takeKeys(flags);
  for (const key of keys) {
    if (!SHELL_NAME.test(key)) {
      flags.errors.push(
        `--key ${key} cannot be exported: a shell variable name must match ${SHELL_NAME.source}. Lease it with \`agent-native vault exec\` instead.`,
      );
    }
  }

  return {
    help: false,
    keys,
    ...(app ? { app } : {}),
    errors: flags.errors,
  };
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
 * Discovery plus `--app` resolution, shared by every subcommand that spends a
 * credential. A config file that exists but cannot be read is still "no bearer
 * here", but the message has to name the real cause rather than let the
 * developer conclude they never connected.
 */
function resolveCredentialSource(
  deps: VaultExecDeps,
  requested: string | undefined,
): ResolvedApp {
  let discovered: ConnectedApp[];
  try {
    discovered = deps.discoverConnectedApps();
  } catch (err) {
    return {
      ok: false,
      code: EXIT.NO_CREDENTIAL,
      message: errorMessage(err),
    };
  }
  return resolveApp(discovered, requested);
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
    stdout(formatVaultUsage());
    return 0;
  }
  if (subcommand === "list") return runVaultList(rest, deps);
  if (subcommand === "add") return runVaultAdd(rest, deps);
  if (subcommand === "env") return runVaultEnv(rest, deps);
  if (subcommand !== "exec") {
    stderr(`Unknown vault subcommand: ${subcommand ?? "(none)"}`);
    stderr("");
    stderr(formatVaultUsage());
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

  const resolved = resolveCredentialSource(deps, parsed.app);
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

/**
 * Prints what is in the vault, never what is in a secret. The value is not
 * merely omitted from the output: `VaultSecretSummary` has no field to hold
 * one, so a deployment that starts returning values cannot leak them here.
 */
async function runVaultList(
  argv: string[],
  deps: VaultExecDeps,
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const { stderr } = deps;

  const parsed = parseListArgv(argv);
  if (parsed.help) {
    stdout(formatVaultListUsage());
    return 0;
  }
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) stderr(error);
    stderr("");
    stderr(formatVaultListUsage());
    return EXIT.USAGE;
  }

  const resolved = resolveCredentialSource(deps, parsed.app);
  if (!resolved.ok) {
    stderr(resolved.message);
    return resolved.code;
  }

  let secrets: VaultSecretSummary[];
  try {
    secrets = await deps.listSecrets(resolved.app);
  } catch (err) {
    stderr(errorMessage(err));
    return EXIT.REQUEST_REFUSED;
  }

  // An empty vault and a refused call must not read alike on a terminal, so
  // the empty case says so on stderr and leaves stdout parseable.
  if (secrets.length === 0) {
    stderr(`No secrets in ${resolved.app.serverName}'s vault.`);
    return 0;
  }

  const rows = [...secrets].sort((a, b) =>
    a.credentialKey.localeCompare(b.credentialKey),
  );
  const width = Math.max(...rows.map((row) => row.credentialKey.length));
  for (const row of rows) {
    stdout(`${row.credentialKey.padEnd(width)}  ${row.name ?? ""}`.trimEnd());
  }
  return 0;
}

/**
 * Stores a secret whose value this process only ever learns from stdin. The
 * prompt runs *after* the deployment is resolved, so an operator is never
 * asked to type a credential into a command that was going to refuse anyway.
 */
async function runVaultAdd(
  argv: string[],
  deps: VaultExecDeps,
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const { stderr } = deps;

  const parsed = parseAddArgv(argv);
  if (parsed.help) {
    stdout(formatVaultAddUsage());
    return 0;
  }
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) stderr(error);
    stderr("");
    stderr(formatVaultAddUsage());
    return EXIT.USAGE;
  }

  const resolved = resolveCredentialSource(deps, parsed.app);
  if (!resolved.ok) {
    stderr(resolved.message);
    return resolved.code;
  }

  // Not a usage failure: "this terminal could not be read" and "you typed the
  // command wrong" are different problems, and one exit code for both sends
  // the reader to the wrong one.
  let value: string;
  try {
    value = await deps.promptSecret(`Value for ${parsed.credentialKey!}: `);
  } catch (err) {
    stderr(errorMessage(err));
    return EXIT.NO_VALUE;
  }
  // Not trimmed: a credential may legitimately begin or end with whitespace,
  // and quietly storing a different string than the one entered is the kind of
  // helpfulness that surfaces days later as an authentication failure.
  if (value === "") {
    stderr(`No value entered; ${parsed.credentialKey} was not stored.`);
    return EXIT.NO_VALUE;
  }

  let stored: VaultSecretSummary;
  try {
    stored = await deps.createSecret(
      {
        credentialKey: parsed.credentialKey!,
        name: parsed.name!,
        value,
      },
      resolved.app,
    );
  } catch (err) {
    stderr(errorMessage(err));
    return EXIT.REQUEST_REFUSED;
  }

  // The key the deployment stored, not the one that was typed: it normalizes
  // the key, so echoing the input back would confirm a row that may not exist
  // under that name.
  // stdout stays empty so `add` composes in a pipeline the way `list` does.
  stderr(
    `Stored ${stored.credentialKey} in ${resolved.app.serverName}'s vault.`,
  );
  return 0;
}

/**
 * POSIX single-quoting: inside `'…'` every byte is literal, so the only case to
 * handle is the quote itself, which ends the string, gets escaped, and reopens
 * it. Newlines and `$(…)` need nothing further.
 */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Said at the moment it happens as well as in `--help`: an operator who reached
 * for `env` out of habit should learn here that `exec` is the stronger command.
 */
const ENV_WEAKER_NOTICE = [
  "This is weaker than running a child process. `agent-native vault exec` hands",
  "the values to one command and nothing else; these assignments last as long as",
  "the shell that sourced them, are inherited by everything it starts, and are",
  "visible to anything that can read that shell. Reach for `vault env` only when",
  "you cannot control how the process is launched.",
];

/**
 * The same lease as `vault exec`, printed instead of executed — one call to the
 * same dependency, so it leaves one audit record of the same shape. Weaker than
 * `exec` in the way that matters: the values outlive the command they were
 * leased for, and the caller decides what reads them. The warning is stderr
 * only, so stdout stays sourceable.
 */
async function runVaultEnv(
  argv: string[],
  deps: VaultExecDeps,
): Promise<number> {
  const stdout = deps.stdout ?? console.log;
  const { stderr } = deps;

  const parsed = parseEnvArgv(argv);
  if (parsed.help) {
    stdout(formatVaultEnvUsage());
    return 0;
  }
  if (parsed.errors.length > 0) {
    for (const error of parsed.errors) stderr(error);
    stderr("");
    stderr(formatVaultEnvUsage());
    return EXIT.USAGE;
  }

  const resolved = resolveCredentialSource(deps, parsed.app);
  if (!resolved.ok) {
    stderr(resolved.message);
    return resolved.code;
  }

  const leaseId = (deps.newLeaseId ?? randomUUID)();
  let lease: VaultLease;
  try {
    lease = await deps.leaseSecrets(parsed.keys, leaseId, resolved.app);
  } catch (err) {
    stderr(errorMessage(err));
    return EXIT.LEASE_REFUSED;
  }

  // Parsing already refused an unexportable key the operator asked for; a name
  // the deployment added is refused here rather than emitted as a broken line.
  const unexportable = Object.keys(lease.env).filter(
    (key) => !SHELL_NAME.test(key),
  );
  if (unexportable.length > 0) {
    stderr(
      `Vault lease ${lease.leaseId} returned key(s) that cannot be exported: ${unexportable.join(", ")}. Nothing was written.`,
    );
    return EXIT.LEASE_REFUSED;
  }

  for (const [key, value] of Object.entries(lease.env)) {
    stdout(`export ${key}=${shellQuote(value)}`);
  }
  // The receipt travels with the values, exactly as `exec` passes it to the
  // child, so "this was audited" stays checkable in the shell that sourced it.
  // A leased key of the same name is overwritten by it, so say so by name —
  // last assignment wins in the sourcing shell, and a silent loss here would
  // hand the caller a variable holding something other than what they leased.
  if (lease.env[LEASE_ENV_VAR] !== undefined) {
    stderr(`The lease id overrides the leased value of ${LEASE_ENV_VAR}.`);
  }
  stdout(`export ${LEASE_ENV_VAR}=${shellQuote(lease.leaseId)}`);

  stderr(
    `Vault lease ${lease.leaseId} from ${resolved.app.serverName} (${parsed.keys.length} key(s)). Check the audit log to confirm.`,
  );
  for (const line of ENV_WEAKER_NOTICE) stderr(line);
  return 0;
}

export function formatVaultUsage(): string {
  return [
    "Usage: agent-native vault <subcommand> [options]",
    "",
    "Subcommands:",
    "  exec    Run a command with workspace vault secrets in its environment.",
    "  list    Print the secret keys stored in a workspace vault. Never values.",
    "  add     Store a secret, reading its value from a prompt that does not echo.",
    "  env     Print leased secrets as shell assignments. Weaker than exec.",
    "",
    "Every subcommand takes --app <NAME> to name the deployment supplying the",
    "credential, so one installation serves every deployment you have connected.",
    "",
    "Run `agent-native vault <subcommand> --help` for that subcommand's options.",
    "",
    "This is hygiene, not containment — see `agent-native vault exec --help`.",
  ].join("\n");
}

export function formatVaultListUsage(): string {
  return [
    "Usage: agent-native vault list [--app NAME]",
    "",
    "Prints the credential keys and display names of the secrets in a workspace",
    "vault, so you can see what is available without opening the web UI. It never",
    "prints a secret value, not even a masked preview: a routine command must not",
    "be able to put a credential in your transcript.",
    "",
    "Options:",
    "  --app <NAME>    Which connected app's vault to list. This selects a",
    "                  credential source, not a principal and not a scope. With",
    "                  several apps connected and none selected, the command",
    "                  refuses and names them rather than guessing.",
    "  --help          Show this message.",
    "",
    "Exit codes:",
    `  ${EXIT.USAGE}  malformed invocation`,
    `  ${EXIT.NO_CREDENTIAL}  no connect bearer found on this machine`,
    `  ${EXIT.AMBIGUOUS_APP}  several connected apps, none selected`,
    `  ${EXIT.REQUEST_REFUSED}  the deployment refused the request or was unreachable`,
  ].join("\n");
}

export function formatVaultAddUsage(): string {
  return [
    'Usage: agent-native vault add KEY "description" [--app NAME]',
    "",
    "Stores one secret in a workspace vault. The value is not an argument: the",
    "command prompts for it and reads it from standard input, so it never enters",
    "this process's argv where another local user reading the process table could",
    "see it, and it never lands in your shell history. The prompt does not echo,",
    "and it ends when you press Enter — no end-of-file keystroke is required, so",
    "it works on terminals that cannot send one.",
    "",
    "An existing secret with the same key is updated rather than duplicated.",
    "",
    "Arguments:",
    "  KEY             Credential key, e.g. MY_API_TOKEN.",
    "  description     Human-readable label, shown by `vault list` and the web UI.",
    "",
    "Options:",
    "  --app <NAME>    Which connected app's vault to write to. This selects a",
    "                  credential source, not a principal and not a scope. With",
    "                  several apps connected and none selected, the command",
    "                  refuses and names them rather than guessing.",
    "  --help          Show this message.",
    "",
    "Exit codes:",
    `  ${EXIT.USAGE}  malformed invocation`,
    `  ${EXIT.NO_CREDENTIAL}  no connect bearer found on this machine`,
    `  ${EXIT.AMBIGUOUS_APP}  several connected apps, none selected`,
    `  ${EXIT.REQUEST_REFUSED}  the deployment refused the request or was unreachable`,
    `  ${EXIT.NO_VALUE}  no value came back from the prompt; nothing was stored`,
  ].join("\n");
}

export function formatVaultEnvUsage(): string {
  return [
    "Usage: agent-native vault env --key KEY [--key KEY...] [--app NAME]",
    "",
    "Leases workspace vault secrets and prints them as shell assignments on",
    "stdout, for a long-lived process you did not launch and cannot relaunch:",
    "",
    '  eval "$(agent-native vault env --key ANTHROPIC_API_KEY --app dispatch)"',
    "",
    "PREFER `agent-native vault exec`. This command is weaker than running a",
    "child process, in the way that matters: `exec` hands the values to one",
    "command and nothing else, while these assignments last as long as the shell",
    "that sourced them, are inherited by everything it starts afterwards, and are",
    "visible to anything that can read that shell. Printing them to stdout also",
    "puts them one redirect, one `set -x`, or one scrollback screenshot away from",
    "somewhere you did not intend. Reach for this only when you genuinely cannot",
    "control how the process is launched.",
    "",
    "It leases through the same path as `vault exec`, so it produces the same",
    "audit record. It is not a second way to reach a secret; it is the same lease",
    "with a different output shape.",
    "",
    "Options:",
    "  --key <KEY>     Credential key to lease. Required, repeatable, and never",
    "                  comma-split. A key that is not a valid shell variable name",
    "                  is refused here — lease it with `vault exec` instead.",
    "  --app <NAME>    Which connected app supplies the credential. This selects a",
    "                  credential source, not a principal and not a scope. With",
    "                  several apps connected and none selected, the command",
    "                  refuses and names them rather than guessing.",
    "  --help          Show this message.",
    "",
    "The lease id is printed to stderr and exported as",
    `  ${LEASE_ENV_VAR}`,
    'so "this was audited" is a claim you can go and check. Only the assignments',
    "reach stdout; every notice goes to stderr, so the output stays sourceable.",
    "",
    "Exit codes:",
    `  ${EXIT.USAGE}  malformed invocation`,
    `  ${EXIT.NO_CREDENTIAL}  no connect bearer found on this machine`,
    `  ${EXIT.AMBIGUOUS_APP}  several connected apps, none selected`,
    `  ${EXIT.LEASE_REFUSED}  the server refused the lease`,
    "",
    "WHAT THIS DOES AND DOES NOT CLAIM",
    "  This is hygiene, not containment — see `agent-native vault exec --help`.",
  ].join("\n");
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

/**
 * The action route reports failures as `{ error }`; `message` is only there for
 * hand-rolled route errors. Reading one and not the other turns "no vault
 * secret for A, B" into a bare status code.
 */
function refusalDetail(json: any, status: number): string {
  if (typeof json?.error === "string" && json.error.trim()) return json.error;
  if (typeof json?.message === "string" && json.message.trim())
    return json.message;
  return `HTTP ${status}`;
}

/**
 * One authenticated call to one action route, shared by every vault
 * subcommand. Sharing it is what keeps `USER_AGENT` and the read timeout true
 * of every request rather than of whichever one was written last.
 */
async function callVaultAction(
  app: ConnectedApp,
  action: string,
  init: { method: "GET" | "POST"; body?: string },
): Promise<{ ok: boolean; status: number; json: any }> {
  const url = `${appBaseUrl(app.url)}/_agent-native/actions/${action}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);

  let response: Response;
  try {
    response = await fetch(url, {
      method: init.method,
      headers: {
        accept: "application/json",
        authorization: `Bearer ${app.bearer}`,
        "user-agent": USER_AGENT,
        ...(init.body ? { "content-type": "application/json" } : {}),
      },
      ...(init.body ? { body: init.body } : {}),
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

  return { ok: response.ok, status: response.status, json };
}

export async function listVaultSecrets(
  app: ConnectedApp,
): Promise<VaultSecretSummary[]> {
  const { ok, status, json } = await callVaultAction(app, LIST_ACTION, {
    method: "GET",
  });

  if (!ok) {
    throw new Error(
      `Vault list refused by ${app.serverName}: ${refusalDetail(json, status)}`,
    );
  }

  // A 200 that is not a list is a deployment that does not serve this action;
  // reading it as an empty vault would report "no secrets" about a vault this
  // command never actually read.
  if (!Array.isArray(json)) {
    throw new Error(
      `Vault list from ${app.serverName} returned no secret list. Is it running a core that exposes ${LIST_ACTION}?`,
    );
  }

  return json.map((row: any, index: number) => {
    if (typeof row?.credentialKey !== "string" || !row.credentialKey) {
      throw new Error(
        `Vault list from ${app.serverName} returned a secret with no credentialKey (row ${index + 1}).`,
      );
    }
    return {
      credentialKey: row.credentialKey,
      ...(typeof row.name === "string" && row.name ? { name: row.name } : {}),
    };
  });
}

export async function createVaultSecret(
  draft: VaultSecretDraft,
  app: ConnectedApp,
): Promise<VaultSecretSummary> {
  const { ok, status, json } = await callVaultAction(app, CREATE_ACTION, {
    method: "POST",
    body: JSON.stringify(draft),
  });

  if (!ok) {
    // `refusalDetail` reads the action's own message. The create action opts
    // out of input capture and reports shape errors, so it has no value to
    // echo back at us — but nothing here forwards the response body wholesale.
    throw new Error(
      `Vault add refused by ${app.serverName}: ${refusalDetail(json, status)}`,
    );
  }

  // A 200 that names no secret cannot be reported as a write: the secret may
  // or may not be there. The message says exactly that rather than blaming a
  // missing action — a deployment that stored the row and then failed to read
  // it back answers this way too.
  const credentialKey = json?.credentialKey;
  if (typeof credentialKey !== "string" || !credentialKey) {
    throw new Error(
      `Vault add to ${app.serverName} answered without naming a stored secret, so whether it was stored is unknown. Check \`agent-native vault list\`; if the action is missing, the deployment may not expose ${CREATE_ACTION}.`,
    );
  }
  // Only the key is carried out: the response row holds the value, and a
  // summary with no field for it cannot pass one to a printer by accident.
  return { credentialKey };
}

/**
 * Reads one secret from the terminal without echoing it.
 *
 * Ends on Enter, not on end-of-file: readline resolves the line and the input
 * stream stays open, so a terminal that cannot send Ctrl-D still works. Every
 * character readline would echo goes through `_writeToOutput`, which is
 * silenced here — the prompt itself is written directly instead, so the
 * operator still sees what is being asked.
 */
export function promptForSecretValue(
  prompt: string,
  streams: {
    input?: NodeJS.ReadableStream;
    output?: NodeJS.WritableStream;
  } = {},
): Promise<string> {
  const input = (streams.input ?? process.stdin) as NodeJS.ReadableStream;
  const output = (streams.output ?? process.stderr) as NodeJS.WritableStream;

  return new Promise<string>((resolve, reject) => {
    const rl = readline.createInterface({
      input,
      output: output as NodeJS.WritableStream & { write: any },
      terminal: true,
    });
    (
      rl as unknown as { _writeToOutput: (text: string) => void }
    )._writeToOutput = () => {};

    let answered = false;
    output.write(prompt);
    rl.on("close", () => {
      // Stdin ended without a line. "Nothing was entered" must not read back
      // as an empty value the caller could store.
      if (!answered) {
        reject(new Error("Standard input closed before a value was entered."));
      }
    });
    rl.question("", (value) => {
      answered = true;
      output.write("\n");
      rl.close();
      resolve(value);
    });
  });
}

export async function leaseSecrets(
  keys: string[],
  leaseId: string,
  app: ConnectedApp,
): Promise<VaultLease> {
  const { ok, status, json } = await callVaultAction(app, LEASE_ACTION, {
    method: "POST",
    body: JSON.stringify({ keys, leaseId }),
  });

  if (!ok) {
    throw new Error(
      `Vault lease ${leaseId} refused by ${app.serverName}: ${refusalDetail(json, status)}`,
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
    listSecrets: listVaultSecrets,
    createSecret: createVaultSecret,
    promptSecret: (prompt) => promptForSecretValue(prompt),
    spawnChild,
    env: process.env,
    stderr: (line) => console.error(line),
    stdout: (line) => console.log(line),
  });
}
