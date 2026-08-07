# ADR 0005 — The host owns fallback-storage policy, not any provider

- Status: accepted
- Date: 2026-08-03

## Context

When a file upload finds no configured provider, the framework historically fell
back to storing the payload in SQL. On hosts with a filesystem and a forgiving
database that is a survivable degrade. On Cloudflare Workers it is not: the
architecture contract says raw payloads never go into SQL, D1 rows are small,
and an app that lands there has silently traded a stored file for a corrupted
one.

So something has to answer "may this process fall back to SQL?" — and the
natural-looking place to put that answer is the file-upload registry, which is
where providers live and where the fallback branch is taken. The registry knows
which providers registered; a fallback-less host registers an object-storage
provider; so "a platform provider is registered" looks like it means "this host
requires object storage". That reading is the trap this record exists to close.

## Decision

The **host** owns the answer, through `getFallbackStoragePolicy()` in
`packages/core/src/shared/runtime.ts`. It is derived from runtime detection —
"which runtime is this process" — and never from the set of registered
providers, the registry's state, or whether the host barrel was imported. It
returns a typed value, not a boolean: either `{ fallbackPermitted: true }` or
`{ fallbackPermitted: false, setupGuidance }`, so a caller that refuses an
upload has the operator-facing setup steps in hand at the point of refusal.

The R2 constants the guidance names live in `hosts/cloudflare/storage-config.ts`
— a module of constants — precisely so the policy can name the setup steps
without importing, and therefore without registering, the adapter it is
answering independently of.

## The failure mode this record exists for

Infer the policy from registered providers and this happens:

An app is deployed to Cloudflare Workers. For any reason — a bundler that
tree-shook a side-effect-only import, an app entry that never loaded the host
barrel, an eject that dropped it, a build target that split modules so the
registry the adapter wrote into is not the one the reader reads — the Cloudflare
adapter does not register. No provider answers. The inferred policy concludes
"no platform provider is registered, so this host permits a fallback", and the
upload is written into SQL. `uploadFile` returns a url. The action reports
success. The UI shows a stored file.

Nothing throws, nothing warns, and the caller cannot distinguish this from a
real upload. The architecture contract is broken in a way that surfaces weeks
later as a bloated database or an unreadable file, with no signal pointing at
the import that did not happen. **A failure coerced into a value callers cannot
tell apart from success is a bug, not a guard** — and this one is invisible
precisely in the case where it is most wrong.

Detection cannot be switched off by an import that did not happen. That is the
whole reason the answer sits with the runtime and not with the registry.

## Why this is a separate record from ADR 0004

ADR 0004 says host knowledge lives in `hosts/`. Read alone, it argues for
putting this answer in the Cloudflare adapter next to the R2 provider, which is
exactly wrong here. This is the one host fact that must be readable *without*
the adapter, because its failure mode is the adapter being absent. A future
reader will assume the provider knows whether its host permits a fallback and be
wrong; the record has to sit where they will look, under its own number, rather
than as a caveat inside the record that points the other way.

## Consequences

- **`isObjectStorageRequired()` is the negation of the policy**, not an
  independent check. There is one resolver for this question and every path goes
  through it — `file-upload/registry.ts`, `pre-upload-attachments.ts`, and the
  agent's own attachment path all read it rather than re-deriving a host answer.
- **A fallback-less host refuses loudly.** With no provider configured,
  `uploadFile` throws `FileUploadStorageNotConfiguredError` carrying
  `policy.setupGuidance`. It does not return `null`, which is the signal callers
  read as "use your SQL fallback".
- **A host that permits a fallback is unchanged.** Node and Netlify deploys keep
  the SQL fallback and its one-time console warning; nothing about their
  behaviour moved.
- **Adding a fallback-less host is a two-line change in `runtime.ts`** plus a
  constants module for its guidance — deliberately not a registration, because a
  registration is exactly the thing that can fail to happen.
- **The policy must never grow a "did the adapter register?" leg.** That is the
  same inference in a new costume, and it re-creates the silent SQL write this
  record was written to prevent.
