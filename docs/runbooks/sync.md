# Sync: carrying the trunk Fork onto a new Upstream release

A **Sync** is one full pass: merge Upstream into the trunk Fork, Re-baseline the
versions onto that Upstream release, and re-Vendor every App Repo from the
resulting trunk commit. The vocabulary is `CONTEXT.md`; this file is the order of
operations and the judgement calls that cannot be scripted.

It is deliberately not a script. Two of its steps — resolving the merge and
auditing the pending changesets — are judgement, and a script that wraps
judgement in a green exit code is exactly the coercion the guards exist to stop.

## 1. Choose the Upstream baseline

Take a `chore: version packages` commit, not whatever `upstream/main` happens to
point at. Only at a release commit is every `package.json` version a real
published release, and `scripts/rebaseline-to-upstream.ts` copies those versions
verbatim. Any other commit hands you numbers that were already published against
a different tree.

Pin the SHA in the PR title. "Latest main" is not a baseline anyone can check.

## 2. Merge, never rebase

    git merge upstream/<sha>

The fork's whole value is that Upstream can be merged repeatedly, and the
merge-base is the record of what has already been reconciled. A rebase rewrites
every one of our commits and throws that record away.

The conflicts fall into two kinds, and they are resolved differently:

- **Versions, changelogs, lockfile** (`packages/*/package.json`,
  `CHANGELOG.md`, `pnpm-lock.yaml`) — take Upstream's side of the conflicting
  hunk. Step 3 is about to overwrite them anyway, so hand-resolving them means
  inventing a number with a short life.

  **"Take Upstream" is not `git checkout --theirs` on a `package.json`.** That
  takes the whole stage-3 blob and so discards our cleanly-merged, non-conflicting
  content along with it. The 0.146.6 Sync lost three fork additions to core's
  manifest that way — a `sideEffects` entry, five `exports` paths, and a
  dependency — and it surfaced two steps later as `Cannot find module
  '@cfworker/json-schema'`, which reads exactly like a bad merge and is not.
  Resolve it as a real three-way merge; it should conflict on the `version` line
  alone. For `CHANGELOG.md` the two are equivalent, which is what makes the
  `package.json` case easy to miss.
- **Source** (`server/auth.ts`, `core-routes-plugin.ts`, `db/client.ts`,
  `deploy/build.ts`, and the rest of the host seam) — read both sides. This is
  the single most likely place a `=== "cloudflare"` comes back into
  `packages/core/src`, which is why `pnpm guards` in step 5 is not optional.

## 3. Re-baseline, then version

    node scripts/rebaseline-to-upstream.ts <upstream-sha>
    pnpm changeset version

The script rewrites each package's `version` and the pre-mode baseline in
`.changeset/pre.json` together, in one commit. They are one fact; a stale
`initialVersions` is what changesets diffs against, so letting it drift produces
a wrong number that still reports success.

Keep the result a PATCH. A minor or major on `@agent-native/core` puts every
package that declares core as a peer out of range, and changesets answers that by
majoring all of them at once — the accident ADR 0008 had to undo.

## 4. Audit the pending changesets

In pre mode changesets stay listed and re-apply on every `changeset version`.
After a large merge some of them describe work Upstream now carries itself, and a
changeset for a change we no longer own inflates `-paul.N` and claims a bump for
someone else's commit.

Delete those, as their own commit, naming each one in the commit body. Do not
exit pre mode to get a clean slate — that is what produced the `1.0.0` accident.

## 5. Gate the trunk before anything vendors

`pnpm guards`, the test lanes, and typecheck, all green on the trunk PR. A
170-commit merge is not proven by typecheck. Then merge the PR.

## 6. Vendor from the merge SHA

Only now, and only from the merged commit — never from an unmerged branch tip.
In each App Repo:

    pnpm vendor:agent-native     # packs from the trunk checkout, writes vendor/packed.json

Compare the new `packed.json` against the previous one. The **package set** is a
reviewed decision, not a diff to skim: design vendors `core` +
`creative-context`, dispatch vendors `core` + `dispatch`. A set that grew means
something changed shape upstream of you.

`@agent-native/toolkit` stays a floating `^` registry dependency. Pin it only if
merged core raises its required minimum, and say so out loud if it does.

## 7. Run the Capability Probe in each App Repo

    pnpm probe

The probe asks the core this app actually loads whether it carries the newest
fork capability. It is an install gate, not a test: `pnpm install` and
`require.resolve` both pass against a tarball that resolves correctly while
carrying a stale build, and nothing else catches that.

A Sync introduces no new capability, so the probe does not move — it asserts
whatever the last real piece of fork work established. It still has to run.

`cf-smoke.mjs` is a different claim: it proves a *deploy serves*, at the HTTP
boundary, after deploying. It does not substitute for the probe, and the probe
does not substitute for it.

## Out of scope

Upstream's changes to `templates/*` are not part of a Sync. Under ADR 0007 the
App Repos own their template source, so the trunk's templates are not what they
run. Port-worthy drift becomes a ticket in the App Repo; folding it into a
version-and-vendor pass is how a Sync stops being reviewable.
