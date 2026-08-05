# 0002 — A long-lived bearer instead of OAuth, for hosts with no browser

- Status: accepted
- Date: 2026-08-04
- Scope: `agent-native connect --bearer` (`packages/core/src/cli/connect.ts`) and
  the device-authorization flow the deployment serves at
  `/mcp/connect/device/{start,poll}`

## Decision

`agent-native connect <url> --bearer` mints a connect token through the
device-code flow and writes it as an explicit bearer for **every** selected
client, including the OAuth-capable ones that plain `connect` hands a URL-only
entry. One browser approval — which may happen on a different machine from the
one being configured — and a headless host is authenticated with no in-agent
step.

Plain `connect` is unchanged. OAuth-capable clients still get URL-only entries
and standard MCP OAuth, which remains the better path on any host with a
browser. `--bearer` is the deliberate exception for hosts that do not have one:
a VPS, CI, a container.

**Do not claim — in code, docs, help text, or a commit message — that a bearer
written this way is contained or scoped.** It grants exactly what a connect
token has always granted. `--bearer` selects an existing credential type; it
does not introduce a narrower one.

The command says so itself: it prints one line on stderr recording that a
long-lived bearer was written and that OAuth is preferred where a browser
exists. That notice is a statement, not a gate — there is no confirmation
prompt and no required justification field, because required-and-unverified
free text manufactures boilerplate and teaches readers to skim past it (see
0001). `connect --help` carries the same claim, and that help text is the
authoritative copy for anyone reading this repo.

## Why the reasoning is not in this file

The full ADR — why a long-lived connect token is an acceptable trade for this
class of host, what it grants, for how long, and to whom — is **deliberately
not published here.**

This repository is a public fork. That reasoning only means anything alongside
the connect-token analysis that sits beside 0001's unpublished half, and that
analysis is a specific description of unpatched weaknesses. Publishing it here
would disclose them ahead of a fix.

The complete ADR lives in the private repository that owns this fork's tickets,
as `docs/adr/0003-long-lived-bearer-for-browserless-hosts.md`. Same split, same
reason as 0001.
