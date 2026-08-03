---
"@agent-native/dispatch": minor
---

Add `lease-vault-secrets`, an all-or-nothing bulk read of named workspace vault
credentials for callers that already hold a connect bearer. It takes an explicit
list of credential keys plus a caller-minted `leaseId` and returns
`{ leaseId, env }`, refusing the whole lease — naming every missing, ambiguous,
or valueless key in one message — rather than returning a partial result. The
action is mounted `POST`-only and kept off the agent and tool-iframe surfaces;
its audit row records the requested key names and never any value.
