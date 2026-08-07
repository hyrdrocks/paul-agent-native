# Issue tracker: GitHub

**Two trackers are in play, and the number alone does not tell you which.** `sonhyrd/paul-dispatch-app`
and `hyrdrocks/paul-agent-native` both number their issues from 1, so `#12` names a real, different
ticket in each. Pick by subject:

- **Vault / dvault / CLI work** → `sonhyrd/paul-dispatch-app`.
- **Fork-combine and Cloudflare work** (spec `#5` and its tickets `#7`–`#21`) → `hyrdrocks/paul-agent-native`,
  which is origin. These are deliberately on the trunk Fork because the trunk is the only repo that
  allocates ADR numbers for that work.

Every `gh issue` call must carry an explicit `--repo`. A bare `gh issue view 12` run inside this clone
resolves against `BuilderIO/agent-native` upstream and returns an unrelated issue.

The tickets are deliberately not mirrored here: `paul-dispatch-app` is private, this fork is public,
and the vault tickets contain security analysis that is not for publication. **Do not
recreate them here.**

## Conventions

All operations use the `gh` CLI, always with an explicit `--repo`. The examples below use the vault
tracker; substitute `hyrdrocks/paul-agent-native` for fork-combine and Cloudflare tickets:

- **Create an issue**: `gh issue create --repo sonhyrd/paul-dispatch-app --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **Read an issue**: `gh issue view <number> --repo sonhyrd/paul-dispatch-app --json number,title,body,state,comments`
- **List issues**: `gh issue list --repo sonhyrd/paul-dispatch-app --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`, with `--label` and `--state` filters as needed.
- **Comment on an issue**: `gh issue comment <number> --repo sonhyrd/paul-dispatch-app --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo sonhyrd/paul-dispatch-app --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo sonhyrd/paul-dispatch-app --comment "..."`

Do **not** infer the repo from `git remote -v` here — that is the trap this file exists to close.

Reads take `--json`. A plain `gh issue view` currently returns a Projects-classic GraphQL
deprecation error *instead of* the body, and exits in a way that reads like an empty ticket;
`docs/agents/delegate-profile.md` records the measurement and the `gh api` workaround for the
PR-side equivalent.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr`
equivalents, each with the same explicit `--repo`:

- **Read a PR**: `gh pr view <number> --repo <owner>/<repo> --comments` and `gh pr diff <number> --repo <owner>/<repo>` for the diff.
- **List external PRs for triage**: `gh pr list --repo <owner>/<repo> --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with
`gh pr view 42 --repo <owner>/<repo>` and fall back to `gh issue view 42 --repo <owner>/<repo>`.
Across the two trackers here, that ambiguity doubles: `#42` may be four different things.

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `sonhyrd/paul-dispatch-app`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo sonhyrd/paul-dispatch-app --json number,title,body,state,comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets. Every command
below takes the same explicit `--repo` as the conventions above.

- **Map**: a single issue labelled `wayfinder:map`, holding the Notes / Decisions-so-far / Fog body. `gh issue create --label wayfinder:map`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`). Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/<owner>/<repo>/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children (`gh issue list --state open`, scoped to the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment <n> --body "<answer>"`, then `gh issue close <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
