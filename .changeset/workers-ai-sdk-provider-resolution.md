---
"@agent-native/core": patch
---

Make every AI SDK provider reachable on Cloudflare Workers. The engine-usability
gate resolved optional provider packages with a CommonJS resolver; `workerd` has
none, so that throws for every specifier — including packages that are present
in the bundle. The fallback that masks this on other bundled serverless hosts
recognised only the Vercel/Netlify env markers and a bundle-path pattern, none
of which `workerd` matches, so any engine carrying an install package was
reported as "requires optional packages that are not installed" and the agent
silently fell back to the native Anthropic engine. The fallback now also keys on
`isCloudflareRuntime()`, the canonical runtime predicate from ADR-0003, rather
than introducing a second Workers marker. The dynamic `import()` remains the
real gate, so a genuinely missing package still reports its install hint on
every other runtime.

This is a fork-owned change, not a port of an Upstream fix: it depends on
`isCloudflareRuntime()` and the Host seam, neither of which Upstream carries.
