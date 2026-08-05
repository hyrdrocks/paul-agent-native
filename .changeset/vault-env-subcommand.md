---
"@agent-native/core": minor
---

Add `agent-native vault env --key KEY [--key KEY...] [--app NAME]`, which leases
workspace vault secrets and prints them as shell assignments, so a long-lived
process an operator did not launch — and cannot relaunch — can still receive
them. It leases through the same call as `vault exec`, so it produces the same
audit record: it is not a second way to reach a secret, only the same lease with
a different output shape. The lease id is exported alongside the values as
`AGENT_NATIVE_VAULT_LEASE`, and only the assignments reach stdout, so every
notice stays out of the sourced output.

The command states plainly, in `--help` and on stderr at the moment it runs,
that it is weaker than running a child process: the values last as long as the
shell that sourced them and are inherited by everything it starts. A credential
key that is not a valid shell variable name is refused before a lease is spent
rather than emitted as a line that would break whatever sources it. `vault exec`
is unchanged.
