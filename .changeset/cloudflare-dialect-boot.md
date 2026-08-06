---
"@agent-native/core": patch
"@agent-native/creative-context": patch
---

Boot an app on the Cloudflare SQL dialect: dialect capabilities, lazy schema
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
