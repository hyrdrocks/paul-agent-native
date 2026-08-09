# @agent-native/pinpoint

## 0.1.20-paul.1

### Patch Changes

- Updated dependencies
  - @agent-native/core@0.146.7-paul.0

## 0.1.20-paul.0

### Patch Changes

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

## 0.1.19-paul.0

### Patch Changes

- Updated dependencies [f3a868b]
- Updated dependencies [0c17835]
- Updated dependencies [17b5fe8]
  - @agent-native/core@0.134.0-paul.0

## 0.1.19

### Patch Changes

- f499dff: Add `@agent-native/core/vitest-config`, a base vitest config that caps a suite's
  worker pool so concurrent test runs no longer oversubscribe the CPU. Defaults to
  25% of cores; override with `VITEST_CONCURRENCY`. Every template and package
  config merges it in.

## 0.1.18

### Patch Changes

- 0aada94: Serve the stateless MCP 2026-07-28 protocol natively while preserving stateless
  legacy clients, automatically negotiate the newest supported protocol from
  outbound clients and stdio bridges, and harden MCP OAuth issuer, client type,
  scope, credential binding, and Client ID Metadata Document behavior. Require
  durable, single-use MCP 2026 approval elicitation before running actions marked
  `needsApproval`.

  Update the Pinpoint MCP server example to use the stable split MCP v2 packages.

## 0.1.17

### Patch Changes

- 22e9951: Test-only: the `FileStore.update()` spec now drives the clock with fake timers instead of assuming wall-clock advances between two back-to-back writes, which made it flake when both landed in the same millisecond. No runtime behavior change.

## 0.1.16

### Patch Changes

- 52cce19: Shrink the dispatch and pinpoint install footprint by removing code and
  dependencies nothing could reach. Dispatch drops the unused pre-auth routing
  helper — `rootDispatchRedirect` had no callers and was not re-exported from
  `./server` or any other published subpath — along with the `@libsql/client` and
  `h3` dependencies, which had no imports in the package but were still installed
  for every consumer. Pinpoint drops the `HistoryDropdown` and `SettingsPanel`
  overlay components, which were never rendered by the overlay and were not
  reachable from any of its `.`, `./react`, `./primitives`, `./server`, or
  `./types` entry points. No exported API changes.

## 0.1.15

### Patch Changes

- 8df32f6: Publish the latest Builder link tracking updates.

## 0.1.14

### Patch Changes

- b6d7f87: Move portable rich-editor, context presentation, and visual design controls into Toolkit while preserving Core compatibility re-exports, and add accurate side-effect metadata to capability packages.

## 0.1.13

### Patch Changes

- 38ca6fa: Make annotation badges appear from a natural scale and respect reduced-motion preferences.

## 0.1.12

### Patch Changes

- f43d34c: Stage atomic writes inside the data directory so saves work when /tmp is a different filesystem.

## 0.1.11

### Patch Changes

- 823d635: Upgrade the workspace toolchain to TypeScript 7 (`tsc`) with a side-by-side TypeScript 6 API package for tools that still need programmatic access. Replace `@typescript/native-preview` / `tsgo` with the stable `typescript` 7 release.

## 0.1.10

### Patch Changes

- 2a03c35: Adopt the native TypeScript and oxfmt package build baselines.

## 0.1.9

### Patch Changes

- a784d3c: Update user-facing `npx` guidance to recommend explicit `@latest` package invocations.

## 0.1.8

### Patch Changes

- a56d93d: Remove unused imports, dead state, no-op plugin hooks, and debug logging from package internals.

## 0.1.7

### Patch Changes

- d4013f0: Remove unused imports, dead state, no-op plugin hooks, and debug logging from package internals.

## 0.1.6

### Patch Changes

- 3107f96: Preserve MCP tool error and read-only metadata through action execution, and allow Pinpoint's empty test suite to pass intentionally.

## 0.1.5

### Patch Changes

- 1ba9738: Keep the pinpoint toolbar inside the viewport when the agent sidebar is open by tracking the visible sidebar width via MutationObserver + ResizeObserver and clamping toolbar position + drag bounds.

## 0.1.4

### Patch Changes

- Updated dependencies [bcb2069]
- Updated dependencies [e375642]
  - @agent-native/core@0.8.0

## 0.1.3

### Patch Changes

- 4e3631b: Add `publishConfig.provenance: true` so `pnpm publish` (called by `changeset publish` from the auto-publish workflow) requests an OIDC token from GitHub Actions and publishes via npm trusted publisher. Without this, `pnpm publish` looked for token-based auth and failed with `ENEEDAUTH`.
- Updated dependencies [4e3631b]
  - @agent-native/core@0.7.85
