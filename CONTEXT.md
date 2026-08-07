# Agent Native Fork Distribution

How our private forks of `BuilderIO/agent-native` are built, released, and
consumed by the workspace apps we run on Cloudflare.

This is one of two glossaries. The framework's own Host vocabulary lives in
`packages/core/src/hosts/CONTEXT.md`; `CONTEXT-MAP.md` says which is which and
why they are not one list.

## Language

**Upstream**:
`BuilderIO/agent-native`, the public repository we forked from. Publishes
`@agent-native/*` to npm.
_Avoid_: origin, main repo

**Fork**:
A private clone of Upstream that carries our unreleased core changes. Its only
deliverable is a packed package tarball.
_Avoid_: branch, our repo

**Lane**:
One Fork plus the App Repos that consume it, tracked as a single stream of work.
Today there are two: the vault/dispatch lane and the Cloudflare/design lane.

**App Repo**:
A standalone repository holding one workspace app's own source, scaffolded from
a Template and depending on vendored packages. Source of truth for everything
that is not a package.
_Avoid_: app, project

**Template**:
Scaffoldable app source under `templates/*` in Upstream or a Fork. It is copied
into an App Repo at scaffold time and is not a package, so it cannot be
vendored.
_Avoid_: starter, boilerplate

**Vendor**:
To pack a package from a Fork checkout into a committed `.tgz` inside an App
Repo and point `package.json` at it with a `file:` specifier. Our release
mechanism; we do not publish forked packages to npm.
_Avoid_: publish, release, link

**Init Memo**:
The seam a one-time isolate initialisation is wrapped in — a callable returning
`Promise<void>` with a `reset()`. Names the wrapper only; the waiting policy
inside it is a separate decision (see ADR 0005).
_Avoid_: init cache, init promise

**Capability Probe**:
A behavioural assertion, run after vendoring, that the core actually executing
in the App Repo carries a named fork capability. Distinct from resolution
checks, which pass against a stale build.
_Avoid_: smoke test, healthcheck
