# Dispatch App — provisioned Cloudflare background queue

`sonhyrd/paul-dispatch-app` runs on the same `Pauls Job` account as the design
app (account id in `design-app-resources.md`). Only its background queue is
recorded here; the rest of that app's resources predate this trunk.

Provisioned and verified 2026-08-07 for ticket #30. Both queues **exist now**.

## Why they were created

The Worker is live on `dispatch.paulsjob.ai` and was deliberately not redeployed
during R3–R6. R3 (#14) made the queue emitter unconditional, so from that
release its next deploy would have failed at `wrangler deploy` against a queue
that did not exist. #30 made the emitter conditional, which removes the trap for
apps that never hand a run to the background — but this app is an agent app that
does. Turning durable background off for it would have traded a deploy failure
for every long turn silently running inline under the foreground clamp, so the
queues were created instead.

| Resource | Name | Id |
| --- | --- | --- |
| Queue | `paul-dispatch-app-agent-background` | `8a0a4d314873465280a620b40213c5a8` |
| Dead-letter queue | `paul-dispatch-app-agent-background-dlq` | `2cf21f67fc6a42af9fbb378eca4758b4` |

A queue id is an identifier, not a credential — the same reason
`design-app-resources.md` commits a database id and an account id. Nothing here
authorises anything.

Both names are derived, not chosen. `agentBackgroundQueueName()` in
`@agent-native/core` builds the first from the Worker's own name
(`paul-dispatch-app`) and `configureCloudflareModuleBackgroundQueue()` names the
second by appending `-dlq`. A Worker renamed anything else produces into a queue
that does not exist.

The DLQ exists because the emitted consumer names it: wrangler refuses a
consumer whose dead-letter queue is missing, so a missing DLQ is a deploy-time
failure exactly like a missing queue.

Producers and consumers both read `0` today. That is expected — the
registrations are written by the generated `wrangler.json` and appear on the
first deploy that carries it.

## The build must declare them

As of #30 the emit is conditional, so provisioning alone is not enough. This
app's build environment needs:

    CLOUDFLARE_BACKGROUND_QUEUE=1

Without it, a build that still wants durable background runs (the default —
`AGENT_CHAT_DURABLE_BACKGROUND` unset or truthy) is **refused at build time**,
before anything is deployed, with a message naming both queues above. That
refusal is the point: the alternative is a Worker that accepts background work
and runs it inline under the foreground clamp while looking healthy.

`AGENT_CHAT_DURABLE_BACKGROUND=false` is the other valid answer, and it is the
one for an app that genuinely never hands a run to the background. It is not the
answer for this app.
