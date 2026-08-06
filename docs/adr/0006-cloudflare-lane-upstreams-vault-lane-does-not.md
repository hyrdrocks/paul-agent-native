# The Cloudflare lane is staged for Upstream; the vault lane never is

Our two fork lanes are not the same kind of change. The Cloudflare lane adds a
host Upstream does not support yet, behind a `hosts/*` seam that already
accommodates Upstream's own Netlify path and a guard rejecting new host literals
in core — the shape of a proposed contribution, not of a private patch. The
vault lane is our own credential-handling product surface, whose containment
analysis deliberately lives in a private spec repo. So the Cloudflare lane is
kept PR-shaped and proposed to `BuilderIO/agent-native`; the vault lane stays
private indefinitely, and Vendoring stays its permanent distribution channel.

## Consequences

"The Cloudflare lane" here means package code only. Template-level Cloudflare
fixes are excluded and stay in their App Repo — see ADR 0007. A reader who
finds `templates/design` Cloudflare work missing from the Upstream PRs is
looking at a decision, not an omission.

The Cloudflare lane must not entangle itself with vault-lane code: shared edits
to `server/*` need to be separable, or the Upstream PR carries changes we cannot
publish.

We rebase onto Upstream exactly once, after the combine, and propose the PRs
from that state. We are deliberately not tracking Upstream continuously. If
review takes long enough for Upstream to move, the PRs go stale and the catch-up
is a fresh, deliberate piece of work — that is accepted, not overlooked.
