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
- **Read an issue**: `gh issue view <number> --repo sonhyrd/paul-dispatch-app --comments`
- **List issues**: `gh issue list --repo sonhyrd/paul-dispatch-app --state open --json number,title,body,labels,comments`
- **Comment on an issue**: `gh issue comment <number> --repo sonhyrd/paul-dispatch-app --body "..."`
- **Apply / remove labels**: `gh issue edit <number> --repo sonhyrd/paul-dispatch-app --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close <number> --repo sonhyrd/paul-dispatch-app --comment "..."`

Do **not** infer the repo from `git remote -v` here — that is the trap this file exists to close.

## Pull requests as a triage surface

**PRs as a request surface: no.**

## When a skill says "publish to the issue tracker"

Create a GitHub issue on `sonhyrd/paul-dispatch-app`.

## When a skill says "fetch the relevant ticket"

Run `gh issue view <number> --repo sonhyrd/paul-dispatch-app --comments`.
