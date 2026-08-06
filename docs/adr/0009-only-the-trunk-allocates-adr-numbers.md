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

These files move from `sonhyrd/agent-native` to the trunk and take new numbers:

| in `sonhyrd/agent-native` | here | state |
| --- | --- | --- |
| `0002-local-workers-runtime-counts-as-hosted` | `0003` | moved |
| `0003-cloudflare-queues-for-durable-background-runs` | `0004` | reserved, moves with its code |
| `0004-one-cold-isolate-init-mechanism` | `0005` | moved |
| `0005-cloudflare-lane-upstreams-vault-lane-does-not` | `0006` | moved |
| `0006-app-repos-own-their-template-source` | `0007` | moved |
| `0007-fork-versions-are-upstream-versions-plus-a-prerelease-tag` | `0008` | moved |
| `0008-only-the-trunk-allocates-adr-numbers` | `0009` | moved |

`0004` is held empty on purpose. It belongs to the Cloudflare queues ADR, which
moves alongside the code it describes; allocating it to anything else would
reintroduce the collision this ADR exists to stop.

Three in-document cross-references shift with them: the queues ADR cites
ADR 0002 (becomes 0003), and ADRs 0006 and 0007 cite each other.

Source files stop citing ADR paths entirely. `agent/durable-background.ts`,
`agent/durable-background.spec.ts` and `agent/background-queue.ts` each carry a
`See docs/adr/…` comment; every one of them is a file ADR 0006 sends Upstream,
where `docs/adr/` does not exist, so the citation would dangle in a public PR.
Each is replaced by the one-sentence constraint it pointed at — which is what a
comment is for.
