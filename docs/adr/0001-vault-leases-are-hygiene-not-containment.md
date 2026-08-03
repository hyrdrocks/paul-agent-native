# 0001 — Vault leases are hygiene, not containment

- Status: accepted
- Date: 2026-08-03
- Scope: `agent-native vault exec` (`packages/core/src/cli/vault.ts`) and
  `lease-vault-secrets` (`packages/dispatch/src/actions/lease-vault-secrets.ts`)

## Decision

`agent-native vault exec --key K -- <command>` leases an explicit list of vault
credentials over the connect bearer the machine already holds, puts them in a
child process environment, and never prints them. The lease id goes to stderr
and to the child as `AGENT_NATIVE_VAULT_LEASE`.

Ship this as **hygiene**: it keeps credentials out of transcripts on the happy
path and leaves a durable audit trail. **Do not claim — in code, docs, help
text, or a commit message — that it contains a secret or bounds its blast
radius.** It does not. `agentTool: false` is hygiene, not a security control.

`agent-native vault exec --help` states this under
`WHAT THIS DOES AND DOES NOT CLAIM`, and that help text is the authoritative
copy for anyone reading this repo.

## Why the reasoning is not in this file

The full ADR — the three independent ways containment is defeated, the lease
scope analysis, the audit-visibility findings, and the two known-untested gaps —
is **deliberately not published here.**

This repository is a public fork of `BuilderIO/agent-native`. That analysis is a
specific, actionable description of unpatched weaknesses in software Builder
ships to other people. Publishing it here would disclose them ahead of any fix,
to no one's benefit.

It lives in the private `sonhyrd/paul-dispatch-app` instead:

- `docs/adr/0002-vault-leases-are-hygiene-not-containment.md`
- Spec: `sonhyrd/paul-dispatch-app` issue #11
- Ticket for this ADR: issue #18

Anyone with access to that repository should read it before changing the wrapper
or the lease action, and **before writing any sentence that describes what they
protect.** The single failure this ADR exists to prevent is a maintainer
reading `--key` and "lease" and concluding "the secret is available only to the
leased command." That sentence is false, for reasons recorded privately.

If this work is ever upstreamed to `BuilderIO/agent-native`, the full text
should go with it — at that point the weaknesses are Builder's to fix and
theirs to disclose.
