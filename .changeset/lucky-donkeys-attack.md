---
"@agent-native/core": patch
---

Stop a live background run from minting a recovery successor on every
`/runs/active` poll. On a dialect without interactive transactions (D1) the
stale-run reaper inserted the successor before, and independently of, the
conditional reap UPDATE, so a healthy heartbeating turn accumulated one extra
`agent_runs` row and queue message per poll until the 25-run ledger cap. The
reap now decides first on every dialect, and only a run it actually
terminalised is recovered.
