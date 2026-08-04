---
"@agent-native/core": patch
---

Serve gated routes whose mount lands after the request was dispatched.

The readiness gate releases a request on completion flags, and h3 snapshots the
middleware list immediately afterwards. On a cold Cloudflare isolate the flags
went to `bootstrap=ready pending=[] failed=[]` while mounting was still running:
a `/mcp` request measured a 0ms readiness wait and was then dispatched against a
list missing 298 of the isolate's mounts, `/mcp` among them. Concurrent bursts
put 5 of 8 `/mcp` calls into a bare 404 this way, which drops an MCP client
outright.

The framework init guard now waits — bounded by mount progress, not just the
readiness deadline — for a mount that covers the requested path, then runs the
mounts that were registered after the snapshot. It also recovers a gated path
that Nitro's asset/SSR catch-all already answered with a bare 404, which is how
`/.well-known/agent-card.json` failed without ever reaching the "no route
matched" path. A framework mount's own 404 is left alone, so an action that
legitimately finds nothing is never re-run.

`registerMiddleware` also invalidates h3's memoized dispatcher and composed
chain, which until now only h3's own `use()` did.
