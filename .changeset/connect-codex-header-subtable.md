---
"@agent-native/core": patch
"@agent-native/skills": patch
---

Fix `agent-native connect` reading a Codex config back as having no auth headers when `http_headers` is expressed as a `[mcp_servers.<name>.http_headers]` sub-table rather than an inline table. The block reader stopped at the sub-table header, so the headers were never even collected, and `connect dev`/`connect prod` silently dropped the bearer when saving and restoring the production entry. `connect.ts` now uses the shared MCP config readers in `mcp-config-writers.ts` instead of its own private near-duplicates, which read both header forms and preserve a server's whole TOML footprint (its table plus every sub-table) so a saved entry round-trips intact. As a result `connect` now reports a config file it cannot read or parse instead of treating it as a client with nothing connected.
