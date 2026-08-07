---
"@agent-native/core": patch
---

Stop the run registry answering for a run whose originating request has gone away.

`activeRuns` is isolate-global, but a run's execution belongs to the request
context that started it. On Workers that context is cancelled independently of
the isolate, taking the run's timers, its promise continuations and its terminal
persistence with it — and leaving the map entry reading `running` forever. Both
readers of that entry treated its presence as proof this isolate was still
producing it: an SSE subscriber attached to a buffer that would never be written
to again and pinged indefinitely, and `/runs/active` reported
`heartbeatAt: Date.now()` — asserted, not read — which is fresher than the
durable heartbeat and so overrode the stale-run detection that was about to
terminalise the row.

A run now stamps `lastProducerTickAt` from inside its own heartbeat timer, and
`resolveRunProducerState` classifies an entry as `terminal`, `in-flight` or
`producer-lost` — three states, because folding the third into `in-flight`
reports liveness that is not there and folding it into `terminal` reports an
outcome that never happened. A `producer-lost` entry is not answered from
memory: subscription falls through to the durable path and `/runs/active`
reports SQL's heartbeat. Nothing local is synthesised, because knowing the
producer is gone is not knowing how the run ended. `abortRun` likewise reports
`false` for such an entry — it still drops it, but nothing there was executing,
and the durable marker is what stops the run.

New export subpath `@agent-native/core/agent/run-producer-state`, carrying the
classifier and its two constants.

Cloudflare-Workers detection in the database client now calls the shared
`isCloudflareRuntime()` rather than a second, narrower copy that omitted the
`__env__` global — that copy could take the pooled Node path on a Workers
deploy and share a connection across requests.
