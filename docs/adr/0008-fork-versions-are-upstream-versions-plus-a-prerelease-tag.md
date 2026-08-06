# A Fork version is an Upstream version plus `-paul.N`, and the probe asserts only the newest capability

Every package in the trunk Fork carries the version the changesets pre-release
baseline in `.changeset/pre.json` names — the Upstream release the Fork forks —
advanced by whatever its own changesets ask for, with changesets' pre-mode
`-paul.N` suffix. `@agent-native/dispatch` is renumbered off `1.0.0-paul.0`
back onto the `0.x` line before the post-combine rebase, because `1.0.0` was
never a stability commitment and it leaves the Fork numerically ahead of an
Upstream major that does not exist.

No changeset ever asked for that major. It is what changesets does to a package
that declares `@agent-native/core` as a `>=` peer dependency when core's version
gains a prerelease: a prerelease satisfies no plain `>=` range, so every peer
dependent is out of range and every out-of-range peer dependent is bumped major.
Entering pre mode did this to five packages at once — `dispatch`,
`creative-context`, `frame`, `pinpoint` and `scheduling` — and all five are
renumbered here to the version their own changesets earn against the baseline:

| package | baseline | earns | was | is |
| --- | --- | --- | --- | --- |
| `@agent-native/dispatch` | `0.16.6` | minor | `1.0.0-paul.0` | `0.17.0-paul.0` |
| `@agent-native/creative-context` | `0.5.8` | patch (dependencies) | `1.0.0-paul.0` | `0.5.9-paul.0` |
| `@agent-native/frame` | `0.1.154` | patch (dependencies) | `1.0.0-paul.0` | `0.1.155-paul.0` |
| `@agent-native/pinpoint` | `0.1.18` | patch (dependencies) | `1.0.0-paul.0` | `0.1.19-paul.0` |
| `@agent-native/scheduling` | `0.1.34` | patch (dependencies) | `1.0.0-paul.0` | `0.1.35-paul.0` |

The baselines are Upstream's, not the Fork's: the Fork branches from Upstream at
`dcc028cb7` — Upstream's own `chore: version packages (#2580)` — where
`packages/dispatch/package.json` reads `0.16.6`, which is the number
`.changeset/pre.json` pinned when pre mode was entered.

Nothing self-corrects this, which is why it is worth a correction commit rather
than a note. Changesets in pre mode increments from the version in
`package.json`, and consults the pinned baseline only on `pre exit` — so left
alone, all five exit pre mode at a released `1.0.0`. Renumbered, each exits at
its own base: `dispatch` at `0.17.0`, `creative-context` at `0.5.9`, `frame` at
`0.1.155`, `pinpoint` at `0.1.19`, `scheduling` at `0.1.35`. That is the test
for whether a Fork version is right — `X-paul.N` is correct exactly when `X` is
what `pre exit` produces.

This will recur. The peer ranges now read `>=0.134.0-paul.0`, which core's own
`-paul.N` iterations satisfy, so the next few version runs are quiet — but the
first run that moves core's base off `0.134.0` puts all five out of range again
and majors them again. There is no range that fixes it: semver only lets a
prerelease satisfy a comparator carrying a prerelease on the same
`major.minor.patch`, so no `>=` range can admit an unknown future core
prerelease. Expect the renumber as part of each re-baseline, and read a `1.0.0`
or `2.0.0` on any of these five as this bug rather than as a decision.

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
`agent-native-dispatch-1.0.0-paul.0.tgz` to
`agent-native-dispatch-0.17.0-paul.0.tgz`. Nothing resolves by range under a
`file:` specifier, so this is cosmetic — but it will look like a downgrade in
that repo's history, and it is not. The build inside the `0.17.0-paul.0`
tarball is newer than the build inside the `1.0.0-paul.0` one; only the name
moved. A re-vendor commit there should say so, because the commit is the only
place a reader of that repo will look.

The one version literal that repo pins by hand — the core version and sha256 in
its `scripts/install-agent-native.sh`, for the global CLI install — is not
affected. `@agent-native/core` is not renumbered here, so that pin stays
correct; it goes stale when core is repacked, which is a different event.

`0.17.0-paul.0` also sorts below Upstream's own released `0.17.0`, and below the
`0.17.6` Upstream ships today. That is correct and is the point: the Fork forks
`0.16.6` and has earned a minor since, so it is a prerelease of `0.17.0` that
Upstream will never issue. `pnpm list` now reads as "somewhat behind Upstream"
rather than as "a major ahead of one Upstream has not shipped".
