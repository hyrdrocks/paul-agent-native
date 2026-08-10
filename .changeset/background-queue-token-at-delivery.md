---
"@agent-native/core": patch
---

Mint the durable background run's processor token when the queue delivers the
message, not when the producer enqueues it, so a long run is no longer
structurally unable to start. The token lives five minutes; a queue's delivery
latency is unbounded by construction — a message waits behind whatever run is
currently holding the consumer, and a redelivery after a failed invocation waits
for the visibility timeout on top of that. Both routinely exceed five minutes,
so the credential was expired on arrival for exactly the long runs this
transport exists to serve. The envelope now carries no credential at all, and
the generated Worker consumer signs each message immediately before it delivers
it, through a bridge onto the same signer the HTTP handoff uses rather than a
second copy of the token format in the emitted entry.

Observed in production as a run that never finishes: the processor answered
`401 Invalid or expired processor token`, the consumer acked that 401, and the
turn was deleted from the queue having never executed — while its run row still
read `running`. The stale-run sweeper then reaped it and enqueued a successor,
which landed behind the same backlog and died the same way, once every ~90
seconds until the sweeper gave up and left the run hanging forever.

A 401 or 403 from the processor is therefore no longer acknowledged. The
consumer mints the token itself, immediately before the request, so a refusal
can only mean a mismatched or absent `A2A_SECRET` on the deployment — a
deployment fault, not a decision about the message. It is retried to the
dead-letter queue, where it is visible, instead of being dropped silently while
the run row claims to be running.
