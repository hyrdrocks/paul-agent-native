# Issue tracker: GitHub

**Tickets for this repo live on `sonhyrd/paul-dispatch-app`, NOT on this fork and NOT on origin.**
Every `gh issue` call must carry `--repo sonhyrd/paul-dispatch-app`. A bare `gh issue view 12` run
inside this clone resolves against `BuilderIO/agent-native` upstream and returns an unrelated issue.

The tickets are deliberately not mirrored here: `paul-dispatch-app` is private, this fork is public,
and the vault tickets describe unpatched weaknesses in BuilderIO's shipped product. **Do not
recreate them here.**

## Conventions

All operations use the `gh` CLI, always with `--repo sonhyrd/paul-dispatch-app`:

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
