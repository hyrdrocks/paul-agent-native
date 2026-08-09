---
"@agent-native/core": patch
---

Fix durable background agent runs failing with `401 Unauthenticated`. The
background worker recovered a run's owner by joining `agent_runs` to
`chat_threads`, but a first turn in a new conversation carries no `threadId`, so
there is no thread row to join at dispatch time. The owner is now recorded on
the run row itself (`agent_runs.owner_email` / `owner_anonymous`, both additive)
by the entrypoint that already resolved the caller, and the thread join is kept
only as a fallback for rows written before those columns existed. The
stale-run-recovery successor and the continuation successor inherit the owner
from the row they continue, rather than re-deriving it from a request context
they no longer run inside.

`seedBackgroundAgentRunOwnerContext` no longer swallows a failed owner lookup
into a bare 401 — an unreadable run store and a run with no recorded owner each
report themselves, and the route claims the run before rethrowing so the failure
terminalizes instead of being redispatched by the unclaimed sweep.

`agent_runs` is pinned fail-closed in the db-query/db-exec scoping layer: that
layer derives its views from live columns, so the new `owner_email` would
otherwise have turned a table the raw SQL tools could never read into a
user-scoped view over persisted request bodies.
