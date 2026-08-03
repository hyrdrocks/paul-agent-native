---
"@agent-native/dispatch": minor
"@agent-native/core": minor
---

Split the vault read surface: `list-vault-secrets` no longer returns secret
values at all, carrying a server-computed masked `last4` preview instead, and a
new `reveal-vault-secret` returns one value for one id. Reveal is mounted
`POST`-only, kept off the agent and tool-iframe surfaces, and audited on every
call — the audit row records the id and never the value. The vault UI's eye
toggle now fetches on demand and the edit dialog no longer prefills the stored
value, so a reveal in the timeline means a real reveal.

Core: vault action names join the auto-authenticated-read exclusion patterns, so
a value-returning vault action is never auto-advertised to external agents;
`filterAgentTools` is exported from `@agent-native/core/server` so apps can
assert an `agentTool: false` action really is absent from the agent tool list.
