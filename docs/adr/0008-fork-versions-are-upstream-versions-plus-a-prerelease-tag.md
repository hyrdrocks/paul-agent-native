# A Fork version is an Upstream version plus `-paul.N`, and the probe asserts only the newest capability

Every package in the trunk Fork carries the version of the Upstream release it
forks, with changesets' pre-mode `-paul.N` suffix. `@agent-native/dispatch` is
renumbered off `1.0.0-paul.0` back onto the `0.x` line before the post-combine
rebase, because `1.0.0` was a `major` changeset taken against a `0.16.6`
baseline rather than a stability commitment, and it leaves the Fork numerically
ahead of an Upstream major that does not exist.

The invariant is what keeps the rest of the plan cheap: "how far behind Upstream
is this Fork?" is answerable by comparing two numbers, and each post-rebase
re-baseline is mechanical rather than a judgement call.

Separately, the Capability Probe in each App Repo asserts exactly ONE
capability — the newest one in the release being vendored — and is rewritten at
each release rather than appended to. The probe is a recency test, not a
coverage test: a `file:vendor/*.tgz` can resolve perfectly while carrying a
stale `dist/`, and if the newest capability is present then every older one came
with it. A probe that accumulates assertions costs a run per feature to
re-prove what one assertion proves, and eventually gets commented out.

## Consequences

`paul-dispatch-app`'s vendored tarball name goes backwards, from
`agent-native-dispatch-1.0.0-paul.0.tgz` to a `0.x` name. Nothing resolves by
range under a `file:` specifier, so this is cosmetic — but it will look like a
downgrade in that repo's history, and it is not.
