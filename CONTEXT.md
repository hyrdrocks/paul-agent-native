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
There were two — the vault/dispatch lane and the Cloudflare/design lane — until
the combine merged both Forks into one trunk. Both App Repos now Vendor from the
trunk, so the word survives only to name work by its subject, not by its Fork.

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

**Re-baseline**:
To copy each package's `version` verbatim from a named Upstream release commit,
replacing the version the Fork had drifted to. changesets can only increment
what `package.json` already says, so carrying the Fork from one Upstream release
to the next is a merge resolution, not a bump.
_Avoid_: bump, upgrade

**Sync**:
One full pass of merging Upstream into the trunk Fork, Re-baselining onto that
Upstream release, and re-Vendoring every App Repo from the resulting trunk
commit. A partial pass is not a Sync: an App Repo vendored from an unmerged
trunk is the failure this term exists to name.
_Avoid_: update, upgrade, pull

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
