---
"@agent-native/core": patch
---

Make the read-only docs lookup tools — `docs-search`, `framework-search` and
`source-search` — answer the request that was actually made. Each declared
`list` as a one-value `enum: ["true"]` and checked it before `slug`, `path`,
`pattern` or `query`. A model that fills every optional parameter a schema
offers has no way to decline a one-value enum, so it sends `list` alongside the
page it asked for, gets the index back, re-asks for the same page, and the agent
loop's duplicate-read-only guard aborts the turn with
`duplicate_read_only_tool`. Claude leaves the parameter out and never sees this;
other engines cannot complete a turn that reads a doc.

Selectors now take precedence over `list`, and `list` advertises both `"true"`
and `"false"` so filling the enum is no longer the same as requesting the index.
Listing when nothing more specific was asked for is unchanged. The precedence
rule and the parameter shape live in one module, shared by the three scripts and
by both places that declare their tool schemas, so the next tool to offer a
listing cannot reintroduce the trap by copying an old declaration.
