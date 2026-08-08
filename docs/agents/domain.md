# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **`CONTEXT.md`** at the repo root, or
- **`CONTEXT-MAP.md`** at the repo root if it exists — it points at one `CONTEXT.md` per context. Read each one relevant to the topic.
- **`docs/adr/`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check `src/<context>/docs/adr/` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The `/domain-modeling` skill (reached via `/grill-with-docs` and `/improve-codebase-architecture`) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (most repos):

```
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
```

Multi-context repo (presence of `CONTEXT-MAP.md` at the root):

```
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
```

**This repo is the multi-context shape**, with the context directory one level
deeper than the sketch because the framework is a package:

```
/
├── CONTEXT-MAP.md                     ← start here
├── CONTEXT.md                         ← Fork Distribution
├── docs/adr/                          ← every ADR, one sequence
└── packages/core/src/hosts/
    └── CONTEXT.md                     ← Host
```

All ADRs live in the single root sequence — `docs/adr/` — no matter which
context they belong to, because only the trunk allocates ADR numbers (ADR 0009)
and a per-context sequence would reintroduce the collision that rule exists to
stop. There is no `src/<context>/docs/adr/` here.

## Use the glossary's vocabulary

When your output names a domain concept (in an issue title, a refactor proposal, a hypothesis, a test name), use the term as defined in the `CONTEXT.md` **for that context**. Don't drift to synonyms the glossary explicitly avoids, and don't reach into the other context's glossary for a term this one already defines — read `CONTEXT-MAP.md` for which is which and where they touch.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for `/domain-modeling`).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_
