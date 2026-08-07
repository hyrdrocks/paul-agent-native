---
"@agent-native/core": patch
---

Give the Host ownership of how a process reaches a browser, and emit this
Host's Browser Rendering binding.

Rendering a real DOM used to be decided at the call site, and a call site can
only see "the Chromium import threw". Every call site resolves that the same
way — it returns something the caller cannot tell from a render: an empty
screenshot, a blank page, an SVG with no nodes. On a Worker there is no Chromium
binary and nowhere to install one, so that is not an edge case there, it is
every render.

So the question is asked once. Hosts register a provider under
`browser-rendering` declaring their own consultation priority, exactly as
background transports and fallback-storage policies do.
`resolveBrowserRenderingDecision()` answers with a binding to render through, or
a refusal carrying the setup step that fixes it, or `null` for "no host claimed
this process" — which is the only case where launching a local browser is
correct. A refusal is deliberately a different value from `null`: answering one
with the other is what sends a Worker off to spawn a binary that is not there.

The Cloudflare provider resolves the `BROWSER` binding, and tells an absent
binding apart from a malformed one because those send an operator to opposite
repairs. `CLOUDFLARE_BROWSER_BINDING_NAME` sits next to the code that reads it
and is re-exported from `deploy/build.ts` beside the D1 and R2 names.

The build emits a `browser` binding when `CLOUDFLARE_BROWSER_RENDERING` asks for
one, and no `browser` key at all when it does not. Conditional like D1 and R2:
Browser Rendering is an entitlement rather than a resource, which makes it more
of a deploy prerequisite, not less — `wrangler deploy` rejects a binding the
account is not entitled to, so an unconditional emit would fail the deploy of
every app that never renders anything. With no resource id to derive from, the
variable declares intent; what stops it being a switch nobody flips is that a
Worker with no binding refuses by name at the first render, quoting both the
variable and the binding. An unrecognised value throws rather than being read as
either answer.

Also adds `dist/hosts/**` to this package's `sideEffects` allow-list. Host
registrations are reached through a side-effect-only import of the host barrel,
which a bundler honouring that allow-list is entitled to drop — and measurably
did: the Cloudflare background transport was absent from every emitted chunk of
a built Worker, so the seam resolved as "no host claimed this process" and a
durable background run went to the in-process route with nothing reporting it.
