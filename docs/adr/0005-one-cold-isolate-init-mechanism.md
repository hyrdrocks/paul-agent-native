# One cold-isolate init mechanism: poll a flag, do not duplicate the attempt

Both fork lanes independently fixed the same workerd rule — a promise belongs to
the request that created it, and awaiting a foreign one is cancelled when that
request answers. The vault lane wrote `server/cross-request-init.ts`: the
creator starts the work and holds it open with its own `waitUntil`, and every
other request polls a plain boolean flag on timers it owns. The Cloudflare lane
wrote `db/init-memo.ts`: never share a pending promise across request scopes, so
a caller in a different scope immediately starts its own attempt. We keep
`cross-request-init.ts` and delete `init-memo.ts`.

This deletes a policy, not a seam. `createInitMemo`'s name, its
`() => Promise<void>` plus `reset()` shape, and the five store call sites that
wrap their DDL in it all survive; only the 64-line body is replaced, with an
`InitState` flag the waiter polls instead of a promise it awaits. Anyone reading
"we deleted init-memo" and reaching for the five stores has misread this.

## Considered Options

`init-memo.ts` is not the weaker design. Its no-poll property answers a real,
measured problem recorded in `cross-request-init.ts` itself: waiters poll inside
the isolate they are waiting on, so they lengthen the init they are waiting for
— raising the deadline moved cold-start failures from 2/12 at 25s to 7/12 at
60s. It was rejected for three reasons that are about the fork, not about
Workers. `cross-request-init.ts` is the only one of the two with recorded
workerd measurements. It already covers the case `init-memo` cannot — a waiter
that must observe isolate-local state it cannot cheaply rebuild, which is what
produced the bare-404 on a late-mounted route. And it is the incumbent in the
trunk fork, deployed and verified, so the alternative meant rewriting working
code to match unreleased code.

Keeping both, with a boundary rule (poll for isolate-local state, duplicate for
idempotent external DDL) was also rejected. The boundary would be a judgement
call invisible at each call site, which is the shape that ships the same bug
twice.

## Consequences

We accept the polling cost under a concurrent cold burst. If cold-start
failures under load reappear, the fix is to bound the number of resident waiters
or shed earlier — not to reintroduce a second init mechanism.

The policy is now written as code, and it fits behind the wrapper with one
addition the plan did not anticipate: the memo takes an optional h3 event.
Polling only works when the creator holds its own work open, and the measurement
above is unambiguous that no other context can do that for it — a memo with no
way to reach a `waitUntil` would leave every waiter to time out and duplicate
the attempt, which is the design this ADR rejected, reached by accident. The
parameter is optional, so no call site changes; the consequence is that a store
routine which never threads its event through gets the duplicate-attempt
behaviour on Workers rather than the polled one. Threading the event from the
store call sites is follow-up work, not a second mechanism.
