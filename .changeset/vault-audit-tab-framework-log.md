---
"@agent-native/core": minor
"@agent-native/dispatch": minor
---

Read the Vault Audit tab from the framework action audit log, so reads,
mutations, and refused attempts arrive in one timeline with their status and
error code. The tab now filters by action, outcome, actor, and time, and pages
through results; the list surface still omits each event's recorded input.
`vault_audit_log` keeps its existing writers and rows — nothing reads it for
the tab. Audit queries gain a `targetTypes` filter for features whose events
span more than one target type.
