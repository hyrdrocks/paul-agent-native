---
"@agent-native/core": patch
---

Apply the Cloudflare post-build patches to every emitted chunk, at any depth, so
a Worker whose framework code lands in a nested chunk can boot.

The pass walked three hardcoded directories — the server dir, `_chunks/` and
`_libs/` — with a one-level `readdirSync`, skipping any entry that did not end
`.mjs`/`.js`. Nitro names an externalised package chunk after the package, so a
scoped one lands at `_libs/@agent-native/framework.mjs`: the walk saw
`@agent-native` as a directory entry, failed the extension test, and patched
none of the files beneath it. The `node:` builtin prefixing, the
`import.meta.url` replacement and the global-scope timer shim all reached zero
of the chunks that needed them, and the pass logged the same success line it
logs when there is nothing to do. workerd then refused the Worker with
`Disallowed operation called within global scope`, naming a timer the build had
already shipped a shim for.

The walk is now recursive and every rewritten specifier is computed with
`path.relative` from the file being rewritten, replacing the two depths the
stub pass assumed (`./stub.mjs` from `_libs/`, `../_libs/stub.mjs` from
`_chunks/`) — both wrong for a chunk one level deeper. The pass returns what it
scanned, patched and stubbed, and fails outright when the output directory it
was pointed at holds no chunks at all, because "patched nothing" and "there was
nothing to patch" were previously the same log line.

`postgres` joins the modules a surviving bare specifier is rewritten to a
fail-closed stub for. It is an optional peer that core imports lazily, and an
app that correctly omits it got `No such module "_libs/postgres"` at startup
instead. The rewrite now covers the dynamic `import("x")` form as well as
`from"x"`, which is the form a lazily imported peer actually takes. The stub
still throws on use: a Worker reaching it has a live caller, and an empty
result would be indistinguishable from the capability working and finding
nothing.
