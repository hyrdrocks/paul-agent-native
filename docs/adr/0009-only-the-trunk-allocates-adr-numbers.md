# Only the trunk Fork allocates ADR numbers

Two Forks allocated from one sequence and both minted an ADR 0002 — the vault
lane's `0002-long-lived-bearer-for-browserless-hosts` and the Cloudflare lane's
`0002-local-workers-runtime-counts-as-hosted`. From now on the trunk Fork
(`hyrdrocks/paul-agent-native`) is the only repository that assigns an ADR
number; a non-trunk lane writes the decision and takes its number when it moves.

Renumbering on move was chosen over the two schemes that would prevent the
collision structurally — a reserved number block per lane, or date-slug
filenames. Both fix it by making the number carry less information, paid
forever, to avoid a renumber done once.

A number is assigned when a document lands in the trunk, in the order documents
land. Slots are never reserved ahead of a move. Reserving was tried and failed
within hours: two slots were held for the Cloudflare ADRs known at the time, and
the host-adapter work merged two more that nobody had accounted for. A
reservation is a prediction about work not yet done, and it fails in the one
direction that hurts — silently, by being too small.

## Consequences

These documents live in `sonhyrd/agent-native` and take a trunk number when they
move, alongside the code they describe:

| in `sonhyrd/agent-native` | moves with |
| --- | --- |
| `0002-local-workers-runtime-counts-as-hosted` | the hosted-runtime classification |
| `0003-cloudflare-queues-for-durable-background-runs` | the Queues transport |
| `0004-host-adapters-live-in-tree-behind-registries` | the host seam |
| `0005-the-host-owns-fallback-storage-policy` | host-owned fallback storage |

The five process ADRs and the fork-distribution glossary are here, holding
`0005`-`0009`. The copies still in `sonhyrd/agent-native` are superseded and are
deleted in Phase 1.

Two in-document cross-references shift on any move: the queues ADR cites
ADR 0002, and the upstreaming and template-ownership ADRs cite each other.

This trunk will end up with two glossaries — the fork-distribution vocabulary
in `CONTEXT.md` here, and the framework host vocabulary that arrives with the
host seam in Phase 1. They are separate bounded contexts and should not be
merged into one list; this repo needs a context map when the second arrives.

Source files stop citing ADR paths entirely. `agent/durable-background.ts`,
`agent/durable-background.spec.ts` and `agent/background-queue.ts` each carry a
`See docs/adr/…` comment; every one of them is a file ADR 0006 sends Upstream,
where `docs/adr/` does not exist, so the citation would dangle in a public PR.
Each is replaced by the one-sentence constraint it pointed at — which is what a
comment is for.
