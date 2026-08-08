---
"@agent-native/core": patch
---

Emit the Cloudflare background queue only when the app declares it, and refuse
at build time when it wants one and has none.

The queue emitter was the only one of the four Cloudflare emitters that was
unconditional, so from the release that added it every Cloudflare deploy needed
a queue and a `-dlq` to exist — including apps that never hand a run to the
background. They learned that from a `wrangler deploy` failure rather than from
anything they had configured.

`CLOUDFLARE_BACKGROUND_QUEUE` now declares them, the way
`CLOUDFLARE_BROWSER_RENDERING` declares the Browser Rendering entitlement: the
queue name is still derived from the Worker's own name, so the variable carries
no id, only the fact that the resources exist. Unset means no `queues` key at
all in the generated config and a deploy that needs no queue.

The two halves are not separable, and the second is the one that matters.
Simply skipping the emit for an app that still wants durable background runs
would leave a deployed Worker accepting background work and running it inline
under the foreground clamp — a silent runtime degrade traded for a loud deploy
failure, which is strictly worse. So that combination throws at build time,
before anything is deployed, naming the queue, the dead-letter queue, the two
`wrangler queues create` calls in the order wrangler accepts them, and
`AGENT_CHAT_DURABLE_BACKGROUND=false` as the other way out. "No queue
configured" and "queue configured and working" stay distinguishable states.

Whether the app wants durable background runs is read through the existing
`isDurableBackgroundDeployEnabled()` gate rather than a second parse of the
flag, so the Cloudflare and Netlify emits cannot come to disagree about what
requesting it means. The raised `cpu_ms` ceiling stays unconditional: a Worker
with no queue runs its long turns inline, where it needs the ceiling more.
`CLOUDFLARE_BROWSER_RENDERING` and the new variable now share one toggle parse,
so an unrecognised value throws for both rather than being read as either
answer.
