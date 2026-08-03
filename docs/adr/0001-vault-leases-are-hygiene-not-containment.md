# 0001 — Vault leases are hygiene, not containment

- Status: accepted
- Date: 2026-08-03
- Scope: `agent-native vault exec` (`packages/core/src/cli/vault.ts`) and
  `lease-vault-secrets` (`packages/dispatch/src/actions/lease-vault-secrets.ts`)

## Context

A local coding-agent session that needs a workspace credential has, until now,
had two options: paste the value into a prompt, or `export` it into a shell the
agent shares. Both put a plaintext credential somewhere durable — a transcript,
a history file, a `.env` someone commits.

`agent-native vault exec --key K -- <command>` closes that specific hole. It
leases an explicit list of vault credentials over the connect bearer the machine
already holds, puts them in a child process environment, and never prints them.
The lease id goes to stderr and to the child as `AGENT_NATIVE_VAULT_LEASE`, so
"this was audited" is a claim a reader can go and check.

That is the entire benefit, and it is a real one. The risk this ADR exists to
manage is not that the feature is weak — it is that the sentence describing it
will drift. Six months out a maintainer reading `--key` and "lease" will be
tempted to write "the secret is available only to the leased command." That
sentence is false here, for three independent reasons, and this ADR records them
so nobody has to rediscover them as an incident.

## Decision

Ship the wrapper and the lease action as **hygiene**: they keep credentials out
of transcripts on the happy path and leave a durable audit trail. Do not claim,
in code, docs, help text, or a commit message, that they contain a secret or
bound its blast radius.

The claim is stated in plain words in all three places a reader can land:

- `agent-native vault exec --help` — under `WHAT THIS DOES AND DOES NOT CLAIM`:
  "This is hygiene, not containment," followed by each defeater in one sentence.
- The spec for this work (ticket #11 in `paul-dispatch-app`).
- This ADR.

Three surfaces saying the same thing is deliberate. A claim recorded in one
place is a claim that survives exactly until someone reads a different place.

## Findings

These are findings, not decisions. Each is a property of the system as built.
They are recorded because each one is the kind of fact that gets rediscovered
as a bug.

### 1. Containment is defeated three independent ways

Any one of these alone is sufficient. Fixing one changes nothing.

**a. The connect bearer already grants the whole action surface.**
`agent-native connect` mints a token with `DEFAULT_TOKEN_TTL_DAYS = 365`
(`packages/core/src/mcp/connect-store.ts`) and writes it in plaintext into each
client's MCP config — the same file `discoverConnectedApps()` reads it back out
of. An agent with Bash can read that file and `curl` any action, including
`lease-vault-secrets` and `reveal-vault-secret`, with no wrapper involved. The
wrapper does not gate access to vault secrets; it is a convenience over an
endpoint the caller could already reach.

**b. Node cannot `execve`, so a parent survives holding the values.**
`spawnChild` is `spawn(cmd, args, { stdio: "inherit", env })`. The wrapper
process stays alive for the child's whole lifetime with the leased values in its
own memory and in the env it constructed. An `execve` design would leave the
values in exactly one process; this leaves them in two. A non-node wrapper
(execve-capable) was considered and rejected: it costs a second toolchain and a
second distribution channel to remove one of several equally-sufficient
defeaters, so it would buy a nicer sentence and no change in threat model.

**c. `agentTool: false` removes a tool from a list, not an endpoint from the
network.** `lease-vault-secrets` and `reveal-vault-secret` are declared
`agentTool: false, toolCallable: false`, and `filterAgentTools` keeps them out
of the agent's advertised tools. That stops a model turn from reaching plaintext
credentials by *accident*. The HTTP route is unchanged and still answers any
authenticated caller. Treat `agentTool: false` as hygiene, never as a control.

**Never write here:** "the value exists only in the child."

### 2. Lease scope is org-wide and unbounded

- A lease made inside an organization resolves **org-wide** secrets, not just
  the caller's own. `ctxScope` (`vault-store.ts`) is
  `or(eq(ownerEmail), eq(orgId))` when an org is active — a standalone
  disjunct, so org membership alone is enough.
- `credentialKey` carries **no uniqueness constraint**, and `createSecret`
  already resolves a collision silently by updating the most-recently-updated
  matching row. This is why the lease **refuses on ambiguity** by name rather
  than relying on a constraint that does not exist: any "pick one" rule here
  would be picking which credential the caller unknowingly spends.
- **Nothing bounds a CLI lease.** Vault grants and the vault access mode govern
  pushes of secrets *into apps*; they are not consulted on this path. There is
  no per-lease TTL, no key allow-list, and no revocation of a lease already
  taken — the lease id is a receipt, not a boundary.

This is the already-true state of the world for anyone holding a connect bearer.
It is written down because it is not what "lease" implies.

### 3. The audit audience is peer-wide, with no admin role

`scopeClause` in `packages/core/src/audit/store.ts` is
`(owner's rows) OR (visibility = 'org' AND org_id = ?)`. There is no admin
branch and no elevated reader: every org member sees the same org-visible rows,
and no one sees more. That symmetry is deliberate — the trail is readable by the
same people who can read the vault rows it describes — but a reader will
otherwise assume oversight where there is only symmetry.

The accepted cost: a *personal* secret leased inside an org publishes its **key
names** to every colleague in that org. Splitting audit visibility by the leased
secret's scope was rejected. Key names alone cannot tell you a secret's scope, so
the split would have to consult the resolved rows — which means reopening the
absolute rule below. An absolute rule defended only by a judgement call about
which fields happen to be safe is not a rule.

### 4. `audit.summary` and `audit.target` never read `result`

This is an **invariant**, not a style preference. The audit row is durable and
org-readable; `result` is the only object in scope that holds a secret value. As
long as neither callback reads it, no code path exists by which a leased value
reaches the log. It is stated in the code at both sites that could break it — the
`audit` blocks of `lease-vault-secrets` and `reveal-vault-secret`, the only two
actions whose `result` carries a plaintext value. Any future change that wants
"just one field" from `result` is reopening the only route by which this feature
can leak.

### 5. `reason` is optional, forever

The lease takes no required justification field, and must not grow one.
Required-and-unverified free text manufactures `"leasing secrets for task"` on
every call and teaches readers to skim past it.

The load-bearing distinction, which must survive the next feature: this design
accepts an unverified caller assertion as **annotation** and refuses it as
**authorization**. An optional `reason` that a human may find useful later is
fine. A `reason` that any code branches on is not.

### 6. Two gaps, stated as untested

Both are honest gaps, not known-good behaviour:

- **Signal propagation and inherited stdio on a *long-lived* child.** Tested
  behaviour covers exit-code fidelity, including the shell's `128 + n` mapping
  for a signalled child. Not tested: Ctrl-C, `SIGTERM`, and terminal-resize
  handling against a child that runs for minutes, nor the interactive stdio it
  inherits. This compounds finding 1b — the parent that survives holding the
  values is also the parent that must forward signals, so a wrapper that mishandles
  a signal is one holding credentials longer than anyone expects.
- **The bearer-over-network path.** `leaseSecrets()` posting to a remote
  `/_agent-native/actions/lease-vault-secrets` is exercised only against a local
  server. TLS termination, redirects, and proxies on that path are unverified.

### 7. Two implementation facts worth carrying forward

- `vault_audit_log` still has every writer and every row it had before, but
  nothing reads it any more — the Vault Audit tab now reads the framework action
  audit log. That is intended, not drift. Do not "fix" the orphaned reads back
  in, and do not delete the writers on the assumption the table is dead.
- The all-or-nothing refusal **never worked end to end** until the CLI wrapper
  landed. The action threw a plain `Error`; `isUserFacing` in `action-routes.ts`
  classifies an uncategorized throw as a 500 and replaces the message with
  `"Internal server error"`, so the list of offending key names reached only the
  server console. The original acceptance criterion passed **against a stubbed
  dependency**. The fix is `statusCode: 400` on the throw plus reading the
  route's `json.error` in the client. This is the clearest instance of this
  ADR's own theme: a green check that measured the stub rather than the system.

## Consequences

- Anyone with the connect bearer has everything the wrapper has. The wrapper's
  value is that the happy path stops writing credentials into transcripts, and
  that every lease leaves a row someone can read. Threat models that assume more
  are wrong.
- `filterAgentTools` is now exported from `@agent-native/core/server` — a new
  public API on core, added so an app can assert that an `agentTool: false`
  action really is absent from the agent tool list. It widens this fork's
  divergence from upstream beyond the vault files and is a real upstreaming cost.
- A cross-package core change fails typecheck against a stale
  `packages/core/dist` with errors that read like the field was never added. The
  fix is `node scripts/prebuild-workspace-packages.ts postinstall`, not a hunt
  for missing code.

## The release seam is the vendored tarball, not a publish

This fork carries a changeset, and the reason is **not** "no changeset means no
version to consume." The `@agent-native` npm scope is owned upstream; this fork
cannot publish to it, and a changeset publishes nothing here.

What the changeset is for: it bumps the fork's package versions and writes its
CHANGELOG. That CHANGELOG entry is the only durable record of what the vault
work changed in core — a tarball with no note is what dropping the changeset
would leave behind — and the version it mints is what names the vendored
tarball.

The minted version must be one upstream will never issue: `0.134.0-paul.0`,
not a reused `0.133.3`. A tarball declaring a bare `0.133.3` is distinguishable
from the registry copy by lockfile path and nothing else; a `-paul` prerelease
identifies itself in `pnpm list` and in error stacks. The cost is that upstream's
real `0.134.0` sorts *after* this prerelease, so the version has to be re-minted
on every upgrade rather than inherited.

### The prerelease tag bumps more than core, and that is mechanical

`changeset pre enter paul` + `changeset version` mints `@agent-native/core`
`0.134.0-paul.0` as intended, and also takes `dispatch`, `frame`, `pinpoint`,
`scheduling`, and `creative-context` from `0.x` to `1.0.0-paul.0`. None of them
has a breaking change. Each declares `@agent-native/core` as a **peerDependency**
with a `>=` range, and a semver range never matches a prerelease of a different
`major.minor.patch` — so `0.134.0-paul.0` reads as out of range, and changesets
bumps an out-of-range peer dependent by major. Their peer ranges are rewritten to
`>=0.134.0-paul.0` for the same reason.

Do not hand-correct these back. They are the documented output of the mode this
fork was told to use, nothing publishes, and hand-editing a version is how the
lockfile and the CHANGELOG stop agreeing. Do note the consequence, which is worse
than core's: upstream's real `0.17.x` dispatch will sort *below* `1.0.0`
permanently, so every upgrade must re-mint from upstream's versions rather than
inherit these.

**The actual release seam is `pnpm vendor:agent-native` in
`paul-dispatch-app`** — build, pack, commit the tarball, bump the `file:` specs.
That procedure and the ADR explaining why that app consumes a vendored fork build
live in `paul-dispatch-app`, not here. This ADR does not own it and the changeset
is not it.

## Numbering

Upstream `BuilderIO/agent-native` has no `docs/adr/` directory, and this fork was
clean when this ADR was written, so `0001` is unambiguous. Note for later: if the
Cloudflare work in the separate `sonhyrd/agent-native` fork is ever merged here,
its ADRs collide in the `0002`–`0005` range — but not with `0001`.
