---
"@agent-native/dispatch": patch
---

`lease-vault-secrets` now marks its all-or-nothing refusal as a client error, so the message naming every missing, ambiguous, or valueless key reaches the caller instead of being replaced with a generic internal-error response.
