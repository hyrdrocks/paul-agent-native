# @agent-native/creative-context

## 0.6.3-paul.0

### Patch Changes

- 8693d39: Boot an app on the Cloudflare SQL dialect: dialect capabilities, lazy schema
  initialisation, the Workers runtime counted as hosted, and the D1 binding
  emitted into the generated Worker configuration.

  The database layer now answers capability questions instead of making callers
  name a product. `supportsInteractiveTransactions()` says whether a dialect can
  hold a `BEGIN` open across round trips — read literally, because every supported
  dialect writes atomically and the one that answers `false` does so through a
  batched statement list. `runAtomicWrites` and `runCompareAndSwap` each have one
  implementation with that branch inside, so the dialects cannot drift apart, and
  no caller outside the database layer checks the dialect by name any more.
  `@agent-native/creative-context` creates a context through `runAtomicWrites`
  rather than an interactive transaction, so the sources, the context row and its
  audit entry still land together on a dialect that has no `BEGIN` to hold open. The
  human-readable database label and the platform-binding client both travel with
  the dialect, so authentication asks for a client rather than reaching for a
  host's binding — on a bound dialect with nothing bound it now names the missing
  binding instead of failing inside the fail-closed `better-sqlite3` stub.

  Schema initialisation no longer fires outside a request. The five
  fire-and-forget `ensure*Tables()` calls at plugin-init are gone and each store
  wraps its existing routine in the cold-isolate init memo; the request-scoped
  entry points thread their h3 event through so the request that starts the work
  can hold it open. The audit cleanup job ticks on a timer with no request of its
  own, so it awaits its own initialisation.

  The Workers runtime counts as hosted, including under `wrangler dev`, which runs
  the same runtime binary under the same constraints. The long-budget signal is
  carried per invocation there rather than per isolate, because one Worker isolate
  serves concurrent fetch and queue invocations and an isolate-wide marker would
  let an unrelated foreground turn lift its own clamp. Until a durable transport
  exists for this host, an enabled gate reports once per isolate that the run is
  executing inline rather than degrading in silence.

  Native packages that survive as bare specifiers in an emitted Worker bundle are
  stubbed to throw on every access, replacing a stub whose empty default and no-op
  `watch()` a caller could not tell from the capability working and finding
  nothing.

- 35958d1: Renumber the five packages that entering changesets pre mode bumped to `1.0.0`
  back onto the `0.x` line, so a Fork version is the Upstream version it forks
  advanced by its own changesets, plus the `-paul.N` prerelease suffix. No
  changeset ever asked for that major: it is what changesets does to a package
  declaring `@agent-native/core` as a `>=` peer dependency once core's version
  carries a prerelease, because a prerelease satisfies no plain `>=` range.
  `@agent-native/dispatch` goes to `0.17.0-paul.0`, and `creative-context`,
  `frame`, `pinpoint` and `scheduling` to a patch above their baselines. A
  vendored tarball name therefore moves backwards without the build inside it
  moving backwards; `docs/adr/0008` says why.
- Updated dependencies [f2fe0b3]
- Updated dependencies [1c13483]
- Updated dependencies [e6cf9fa]
- Updated dependencies [8693d39]
- Updated dependencies [5c07988]
- Updated dependencies [b9ae314]
- Updated dependencies [2c2f66d]
- Updated dependencies [e5d6c95]
- Updated dependencies [a33bb80]
- Updated dependencies [20a6b93]
- Updated dependencies [a12f7f9]
- Updated dependencies [bef7405]
- Updated dependencies [0ebd8af]
- Updated dependencies [c2b7f82]
- Updated dependencies [a1311d7]
- Updated dependencies [e517dcc]
- Updated dependencies [834ac94]
- Updated dependencies [f2fe0b3]
- Updated dependencies [d583f7d]
  - @agent-native/core@0.145.3-paul.0

## 0.5.9-paul.0

### Patch Changes

- Updated dependencies [f3a868b]
- Updated dependencies [0c17835]
- Updated dependencies [17b5fe8]
  - @agent-native/core@0.134.0-paul.0

## 0.6.2

### Patch Changes

- e177059: Restore the serverless Playwright fallback so production URL extraction can use packaged Chromium.

## 0.6.1

### Patch Changes

- aa24c7e: Use the declared optional Playwright runtime through a literal import so Cloudflare deployments can apply their fail-closed browser stub.
- 9d8ae68: Run website brand extraction in an isolated real browser through the SSRF-safe network proxy, with serverless Chromium support and an explicit static fallback.

## 0.6.0

### Minor Changes

- abb0cf5: Add a shared browser-rendered website design-system extraction surface with computed visual tokens, component evidence, and bounded design.md summaries.

## 0.5.12

### Patch Changes

- 2765110: Avoid database migrations and recurring sweeps during durable background cold starts.

## 0.5.11

### Patch Changes

- c71d383: Include the shared creative-context and toolkit updates in the next package release.

## 0.5.10

### Patch Changes

- d6e7c5c: Stop a second Chromium from being downloaded alongside the one already on disk.

  First-party workspace packages now take Playwright from an exact catalog pin, so
  a caret cannot resolve forward to a release tied to a different Chromium
  revision. The two packages that declare Playwright as a published optional
  dependency — `@agent-native/creative-context` and `@agent-native/recap-cli` —
  deliberately keep a caret range instead: an exact range in a library stops a
  consumer who already has a different Playwright from deduping, which forces a
  nested copy and downloads exactly the second browser this change exists to
  avoid.

## 0.5.9

### Patch Changes

- f499dff: Add `@agent-native/core/vitest-config`, a base vitest config that caps a suite's
  worker pool so concurrent test runs no longer oversubscribe the CPU. Defaults to
  25% of cores; override with `VITEST_CONCURRENCY`. Every template and package
  config merges it in.

## 0.5.8

### Patch Changes

- c8a0bcf: Declare `@tanstack/react-query` as a peer/dev dependency so `tsc` can name its types under pnpm's isolated layout. Without it the package fails to build with TS2883 in a generated workspace, which breaks the root `postinstall` and therefore `pnpm install`.

## 0.5.7

### Patch Changes

- 8453025: Add manifest-driven feature ejection with dry-run planning, committed provenance, import rewrites, drift inspection, hash-gated restore, protected-runtime guidance, and complete first-party coverage guards.

## 0.5.6

### Patch Changes

- e53a34e: Extract reusable Postgres search and embedding primitives into Core while preserving Creative Context imports.
  The pgvector setup error now consistently says "Vector search" instead of the narrower "Visual search" wording.

## 0.5.5

### Patch Changes

- 6acaad0: Extract reusable Postgres search and embedding primitives into Core while preserving Creative Context imports.
  The pgvector setup error now consistently says "Vector search" instead of the narrower "Visual search" wording.

## 0.5.4

### Patch Changes

- 079e19a: Adopt focused Core client entrypoints and ship package migration metadata where applicable.

## 0.5.3

### Patch Changes

- b6d7f87: Move portable rich-editor, context presentation, and visual design controls into Toolkit while preserving Core compatibility re-exports, and add accurate side-effect metadata to capability packages.

## 0.5.2

### Patch Changes

- 915c940: Preserve stubbed optional package imports and package subpaths when bundling Cloudflare Pages workers.

## 0.5.1

### Patch Changes

- 8e0afec: Improve Creative Context sharing and connection-chip interactions.

## 0.5.0

### Minor Changes

- 149c0ee: Add bounded, app-owned native resource update checks and Library update submission controls.

### Patch Changes

- 149c0ee: Add governed creative-context sharing, host-backed native clone actions, and a reusable organization-admin permission helper.

## 0.4.0

### Minor Changes

- a485fbe: Add the Creative Context package for importing, versioning, searching, and reusing workspace decks, designs, assets, websites, and content across creative apps.

  Expose reusable ingestion, prompt-context provider, and search utility seams from core for package-driven creative context.

  Includes bounded image-region cropping for durable localized creative-context fallbacks.

## 0.3.0

### Minor Changes

- 9f2f7a7: Add the Creative Context package for importing, versioning, searching, and reusing workspace decks, designs, assets, websites, and content across creative apps.

  Expose reusable ingestion, prompt-context provider, and search utility seams from core for package-driven creative context.

  Includes bounded image-region cropping for durable localized creative-context fallbacks.

## 0.2.0

### Minor Changes

- 2625de5: Add the Creative Context package for importing, versioning, searching, and reusing workspace decks, designs, assets, websites, and content across creative apps.

  Expose reusable ingestion, prompt-context provider, and search utility seams from core for package-driven creative context.

  Includes bounded image-region cropping for durable localized creative-context fallbacks.
