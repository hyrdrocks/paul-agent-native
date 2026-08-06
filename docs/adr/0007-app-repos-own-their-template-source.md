# App Repos own their template source; Forks ship packages only

A Fork's single deliverable is a packed package tarball. Once an App Repo is
scaffolded from a Template, that App Repo is the source of truth for every file
the Template produced, and the Fork reverts its copy of the Template to
Upstream. For `paul-design-app` this covers all 24 changed files under
`templates/design` — the D1 mutation fixes, the R2 uploads handler, the Browser
Rendering runtime, `vite.config.ts`, the justfile, and the e2e spec.

## Considered Options

Fork-owned templates are supported: `agent-native template` (see
`cli/template-sync.ts`) is a real 3-way merge — pristine baseline ref, template
re-materialized through `create.ts`'s own transform pipeline, app working tree —
and `templateSource: "local-checkout"` scaffolds from a Fork checkout. So this
was a choice, not a constraint.

We also considered splitting on the publishability boundary: portability fixes
stay in the Fork's Template and ride the Upstream PR, operational files
(justfile, e2e, gitignore) stay app-local. It was rejected for the cost of the
bridge — maintaining a Template and an app generated from it, kept in step by
the least-travelled of `template-sync`'s three source modes, whose own header
warns that any divergence from what `create` produced becomes phantom conflicts
on every sync.

## Consequences

The Template-level Cloudflare portability fixes are NOT upstreamable and will
not appear in the Upstream PRs described in ADR 0006. If Upstream later adds
Cloudflare support to `templates/design` itself, it will do so without these
fixes, and reconciling is a fresh piece of work.
