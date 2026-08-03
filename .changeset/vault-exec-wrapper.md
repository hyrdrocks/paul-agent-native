---
"@agent-native/core": minor
---

Add `agent-native vault exec --key KEY [--key KEY...] [--app NAME] -- <command>`, which leases the named workspace vault secrets into a child process environment so a local agent session never has to paste a credential into a prompt. Leased values win over the existing environment and collisions are reported by key name only; the lease id goes to stderr and reaches the child as `AGENT_NATIVE_VAULT_LEASE`. Wrapper failures use private exit codes 64–68 so `vault exec` never impersonates the command it wrapped, and the child's own exit code propagates unchanged. `--help` states plainly that this is hygiene rather than containment.
