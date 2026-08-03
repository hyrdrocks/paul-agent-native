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

Two further cold-isolate 404 sources are closed. Request-time readiness no
longer waits only for the plugin inits whose declared `paths` match the request:
`paths` says where a plugin registers its own routes, which is a different
question from which plugin owns the route being requested — `/mcp` is mounted by
the agent-chat init while `/mcp/oauth` is mounted by core-routes, so a `/mcp`
request was released as soon as core-routes finished and 404'd a handler that was
still being mounted. On Workers every gated request now waits for every tracked
init (they all run concurrently on a cold isolate, so the wall-clock cost is
unchanged); Node keeps its existing scoped behaviour.

And a gated prefix no longer answers a bare 404 while the isolate cannot prove
its init finished: `/_agent-native/*`, `/mcp/*` and `/.well-known/*` fall through
to a guard that reports a retryable 503 naming the unfinished inits, and logs the
readiness snapshot either way. A route that genuinely does not exist still 404s.
This matters most for MCP clients, which make a handful of discovery and
handshake calls without retrying, so one 404 on `/mcp` or
`/.well-known/oauth-authorization-server` drops the connection outright.

Also: a bootstrap or Better Auth init that fails once no longer poisons the
instance for its whole lifetime (the memo is cleared and the attempt retried,
bounded), and a Better Auth init failure now surfaces as a retryable 503 on
`/_agent-native/auth` instead of a bare 404 — `autoMountAuth` still returns true
for the locked-app fallback, and the new `getAuthMountFailure(app)` reports that
the mount is incomplete.
