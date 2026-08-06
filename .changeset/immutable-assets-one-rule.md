---
"@agent-native/core": patch
---

Emit one `/assets/**` immutable-cache route rule instead of one per hashed asset, so the generated `_headers` stays inside Cloudflare's 100-rule limit at any asset count. Enumerating each asset produced a file `wrangler deploy` rejects outright, which `wrangler dev` only warns about. Non-hashed files under `/assets/` are now covered by that rule and are reported at build time.
