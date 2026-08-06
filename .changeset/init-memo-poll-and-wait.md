---
"@agent-native/core": patch
---

Add the combined cold-isolate Init Memo: `createInitMemo` wraps a one-time
schema-init routine and, on Workers, lets a second caller learn how the first
attempt ended by polling an `InitState` flag rather than awaiting a promise that
belongs to another request.

This is one mechanism, not two. The seam — a callable returning `Promise<void>`
with a `reset()` — is the one the store refactor adopted; the policy inside it is
the measured one from `cross-request-init.ts`: the request that starts the work
holds it open with its own `waitUntil`, everyone else polls a flag on timers they
own, backing off toward a ceiling.

A waiter can tell "still running" from "ran and failed": a failed attempt sets
`error` on the flag, so the waiter raises that error instead of waiting out the
deadline, and the attempt is dropped rather than memoized — one transient DDL
failure is no longer replayed to every later caller for the isolate's life. The
memo takes an optional h3 event so the caller that starts the work can hand it to
its own keep-alive; existing call sites are unaffected.
