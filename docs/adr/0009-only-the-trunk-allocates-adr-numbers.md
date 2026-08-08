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

## Consequences

`sonhyrd/agent-native` holds four ADRs in total, and all four moved here. Two of
them are reachable only from that repository's unmerged branch
`cloudflare-workers-support`, which is why an inventory taken against its `main`
finds two:

| in `sonhyrd/agent-native`                            | here   | landed in |
| ---------------------------------------------------- | ------ | --------- |
| `0002-local-workers-runtime-counts-as-hosted`        | `0003` | R1        |
| `0003-cloudflare-queues-for-durable-background-runs` | `0004` | R3        |
| `0004-host-adapters-live-in-tree-behind-registries`  | `0010` | close-out |
| `0005-the-host-owns-fallback-storage-policy`         | `0011` | close-out |

Numbers were taken in the order the documents landed. `0010` and `0011` were not
`0005` and `0006` — the numbers this table once projected for them — because
five ADRs written here during the fork-combine grilling took `0005`–`0009`
first. That is the rule working, not a mistake: a projected number is a reserved
number, and this repository does not reserve.

Cross-references shift with each move: the queues ADR cited `0002` (now `0003`),
ADRs `0006` and `0007` cite each other, and `0010` and `0011` cite each other.

Source files stop citing ADR paths entirely. Every file carrying a
`See docs/adr/…` comment in `sonhyrd/agent-native` —
`agent/durable-background.ts`, `agent/durable-background.spec.ts`,
`agent/background-queue.ts` and `hosts/cloudflare/background-transport.ts` — is
a file ADR 0006 sends Upstream, where `docs/adr/` does not exist, so the
citation would dangle in a public PR. Each was replaced by the one-sentence
constraint it pointed at, as the code moved, which is what a comment is for.
