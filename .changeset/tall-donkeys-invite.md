---
"@agent-native/core": patch
---

Declare `@ai-sdk/azure` as an optional peer dependency (`>=3`) plus a dev
dependency, pinned to the v3 line that pairs with the framework's `ai@6` and
`@ai-sdk/openai@3`. Adds a spec that exercises the SDK to pin its default
Responses constructor, versioned `/openai/v1` request path, and `v1` default
API version.
