---
"@agent-native/core": patch
---

Fix cold-isolate 404s and 503s on Cloudflare Workers deploys.

Framework bootstrap and plugin inits started at isolate scope and were memoized
as isolate-global promises that every concurrent request awaited. On Workers a
promise belongs to the request context that created it, so once the request that
warmed the isolate answered, workerd canceled the continuations the other
in-flight requests were parked on. A concurrent burst against a cold isolate came
back as a mix of 200s, no-match 404s (routes the canceled init never registered)
and 503s at the readiness deadline; `/_agent-native/*` and `/mcp` were affected
alike.

On Workers, bootstrap and tracked plugin inits now start inside a real request
context under that request's `waitUntil`, and waiting requests observe completion
flags they poll in their own context instead of awaiting a foreign promise. Node
keeps the existing shared-promise path.

`trackPluginInit(nitroApp, init, …)` now accepts a thunk (`() => Promise<void>`)
as well as a promise, and plugin authors should pass a thunk — that is what lets
the framework choose where the init runs and re-run it after a failure. Passing a
promise still works.

Also: a bootstrap or Better Auth init that fails once no longer poisons the
instance for its whole lifetime (the memo is cleared and the attempt retried,
bounded), and a Better Auth init failure now surfaces as a retryable 503 on
`/_agent-native/auth` instead of a bare 404 — `autoMountAuth` still returns true
for the locked-app fallback, and the new `getAuthMountFailure(app)` reports that
the mount is incomplete.
