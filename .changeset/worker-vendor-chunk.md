---
"@agent-native/core": patch
---

Keep the `@agent-native/*` packages in one chunk for Worker and Deno output, so
an app that installs more than one of them from `node_modules` can boot.

Nitro declares one Rolldown code-splitting group per installed package and then
lets Rolldown merge those groups down to far fewer physical chunks. Two
framework packages that share a dependency land on opposite sides of a merge —
one chunk holding zod, the other drizzle-orm — and import each other across the
chunk boundary. The module linker evaluates one side of that cycle first, so a
module-scope read of the other side throws `Cannot access 'X' before
initialization` and workerd refuses to start the Worker. Nothing earlier in the
pipeline notices: install, resolution, bundling and the size check all pass.
Workspace sources never match the group's `test`, so this appears only once an
app consumes the packages from `node_modules`, and only once it consumes two.

`codeSplitting` is the option that governs this. Rolldown ignores
`advancedChunks` whenever `codeSplitting` is set, and Nitro always sets it, so
reaching for `advancedChunks` changes nothing and only logs a warning.

The group is scoped to `@agent-native/*` rather than to all of `node_modules`.
One chunk for every installed package also removes the cycle, but it drags
lazily imported third-party packages into the eagerly evaluated chunk, and their
module-scope `require("node:...")` then runs during startup — trading this
failure for `No such module` at boot.

A build that would reintroduce a cycle now fails with the names of the chunks
involved rather than producing a bundle that only fails at boot. The
`noExternals` value passed for these presets is documented as inert where it is
inert: Worker and Deno presets run with `node: false`, and Nitro only installs
its externals plugin when `node` is true, so nothing in that output is a Nitro
external and nothing reads that value.

Note for apps that post-process the Worker output: the framework packages now
land in `_libs/@agent-native/framework.mjs` instead of one file per package.
