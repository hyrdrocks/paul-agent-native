# ADR 0010 — Host adapters live in-tree, one directory per host, behind registries

- Status: accepted
- Date: 2026-08-03

Moved from `sonhyrd/agent-native` ADR 0004 under the mapping in ADR 0009.

## Context

`packages/core` runs on more than one host. Before this work it ran on one host
with a second bolted on beside it: the background-dispatch resolver named
Netlify inline, then grew a Cloudflare arm, and roughly forty other core modules
had each answered "am I on Netlify?" or "is the dialect d1?" for themselves.
Every one of those inline checks was a private second copy of the host boundary,
so adding a host meant finding all of them, and a reader looking at two hosts
handled two different ways could not tell which one won when both answered.

The shape of that boundary is hard to reverse. It decides what a third host has
to implement, whether an app can supply its own adapter, and whether "the
framework does not run here" is something a maintainer can discover from the
code or has to learn by shipping. Getting it wrong once costs another sweep of
the whole package.

## Decision

Host-specific code lives in **one directory per host** under
`packages/core/src/hosts/`, and reaches core through **registries** rather than
through core reaching back for it. Each host directory self-registers at module
load — a background transport into `agent/background-transports.ts`, a file
upload provider into `file-upload/registry.ts` — and `hosts/index.ts` is a
barrel that imports each one so it registers. Registration is static: no dynamic
import, no runtime-conditional loading, no app-level configuration. Host
identity is a fact to detect, never a setting an app can contradict, so an
adapter that is not on its host reports itself unavailable and loading all of
them is always safe.

**The incumbent host is a registered adapter like any other.** Netlify's
background function is not a privileged branch in the resolver with Cloudflare
declared beside it; it is `hosts/netlify/`, registering an `http` transport at
priority 10, consulted through the same registry in the same declared order. It
kept its place at the front of the order by declaring `priority: 10`, which is a
visible number in a diff, not by being the one the resolver was written for.

**The adapters ship in this repository, not as separately published packages.**

**A guard enforces the boundary** — `scripts/guard-no-host-literals.mjs` fails
when a line this branch added names a host or a host-specific dialect from a
core module that is not on an explicit allow-list. `HOST_AWARE_MODULES` is two
entries as landed: the `hosts/` directory itself, and the one runtime-detection
module every other module asks. Each entry carries the reason it is there. The
deploy and CLI layers, which this record anticipated needing entries, are held
out by directory instead, under a separate rule: a host name that selects a
deploy target is a name, not a decision. The database client needed no entry —
it names no host in a deciding position on any line this work added.

## Considered and rejected: a published adapter package

The obvious next move is to publish `@agent-native/host-cloudflare` and
`@agent-native/host-netlify`, so a host is a dependency an app installs and a
third-party host is a package anyone can write. We considered it and declined
it, for now.

**There is no second real host yet.** Cloudflare Workers is the first host added
against the seam; Netlify was retrofitted onto shapes derived from Cloudflare's
requirements. A published package freezes those shapes into a versioned public
contract before any host we did not design them around has tried to satisfy
them, and hooks designed against a single implementation are usually wrong in
ways only the second implementation reveals. In-tree, a shape that turns out
wrong is one commit across the adapters that use it. Published, it is a breaking
change with a deprecation window, and the cheapest fix becomes the one that
preserves the wrong interface.

**Extracting later is additive, not breaking.** `registerBackgroundTransport`
and `registerFileUploadProvider` are already exported from
`@agent-native/core/server`, so an out-of-tree adapter is a supported thing to
write today — it registers through the same functions the in-tree ones use.
`registerCloudflareHost` and `registerNetlifyHost` are exported from
`hosts/index.ts` for the same reason. Moving a directory into its own package
later removes nothing an app depends on; it is the direction we can still take
after a second host tells us what the seam should look like.

## Consequences

- **Loading every adapter is unconditionally safe, and must stay that way.** The
  barrel imports all hosts on every runtime. That only works because `resolve()`
  returns `null` for "not this host" — a transport that is present but unusable
  reports that itself and still returns `null`, rather than resolving to a
  handoff nothing will claim.
- **Nothing may be inferred from whether the barrel ran.** An import that did
  not happen must not change a host's answer about itself. See ADR 0011, which
  exists because that inference has a silent failure mode.
- **Consultation order is declared, not positional.** A transport cannot
  displace an existing one by being registered, imported, or bundled ahead of
  it — only by declaring a lower `priority`. The same rule governs upload
  providers through the `app` / `platform` tier, so a host adapter registering
  itself at module load cannot silently overrule a provider an app deliberately
  registered.
- **The registry modules must never import the host barrel.** An adapter imports
  the registry it registers into; the reverse edge would be a cycle.
- **The guard scopes to added lines only.** Roughly thirty-eight core modules
  still name a host in code this work does not touch. A guard that failed on all
  of them is a guard someone turns off on day one, so the habit stops spreading
  and the backlog stays a separate, schedulable cleanup.
- **Widening the boundary is an allow-list edit, not a pragma.** It is one
  reviewed change to `HOST_AWARE_MODULES` in
  `scripts/guard-no-host-literals.mjs`, so the list stays the design artifact
  and a reviewer who reads that diff has read the decision. As landed the guard
  also carries a `guard:allow-host-literal` line pragma, matching every other
  guard in the repo; it is for a genuine one-off — a fixture, or an error
  message that has to name the host — and never for a module that decides
  something, which belongs on the list.
- **Cost accepted: a host's code is not versioned separately from core.** An
  adapter fix ships in a core release. That is the price of not freezing the
  interface, and it is paid until a second unfamiliar host makes the shapes
  worth publishing.
