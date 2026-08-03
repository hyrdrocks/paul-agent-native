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

The full ADR — the containment analysis, the lease scope findings, the
audit-visibility findings, and the two known-untested gaps — is **deliberately
not published here.**

This repository is a public fork. That analysis is a detailed security
assessment of code this fork inherits from upstream. It is not ours to publish,
and a public fork of the upstream repository is the wrong place for it
regardless.

It lives in the private `sonhyrd/paul-dispatch-app` instead:

- `docs/adr/0002-vault-leases-are-hygiene-not-containment.md`
- Spec: `sonhyrd/paul-dispatch-app` issue #11
- Ticket for this ADR: issue #18

Anyone with access to that repository should read it before changing the wrapper
or the lease action, and **before writing any sentence that describes what they
protect.** The single failure this ADR exists to prevent is a maintainer
reading `--key` and "lease" and concluding "the secret is available only to the
leased command." That sentence is false, for reasons recorded privately.

If this work is ever upstreamed, the full text should go with it — to the
maintainers who own the code it assesses, through whatever channel they prefer
for security reports.
