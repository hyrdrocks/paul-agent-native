---
"@agent-native/core": patch
---

Stop a background turn from minting an unclaimed recovery successor on every
`/runs/active` poll. On a dialect without interactive transactions (D1) the
stale-run reaper inserted the successor before, and independently of, the
conditional reap UPDATE, so a run that was still heartbeating — or already
terminal — accumulated one extra `agent_runs` row and queue message per poll
until the 25-run per-turn ledger cap. The reap now decides first on every
dialect, and only a run it actually terminalised is recovered; a genuinely
lost handoff is still reaped and redispatched exactly as before.
