# Context Map

This repository holds two glossaries, and they are **not** two halves of one
list. Each defines the vocabulary of a different subject, for a different
reader, changing on a different schedule. Read the one your work is in.

| Context | Glossary | Subject | Audience |
| --- | --- | --- | --- |
| **Fork Distribution** | `CONTEXT.md` | How our private forks of `BuilderIO/agent-native` are built, released and consumed | Whoever is releasing, vendoring, or moving work between repositories |
| **Host** | `packages/core/src/hosts/CONTEXT.md` | How the framework runs the same application on more than one deployment platform | Whoever is writing framework code, here or Upstream |

## Why they must not be merged

**They have different lifetimes.** Fork Distribution vocabulary exists because
we maintain forks; it describes a situation we are actively trying to end. Host
vocabulary describes a seam the framework keeps whether or not a fork ever
existed, and ADR 0006 sends it Upstream. Merging them means every Upstream
reader of "Host adapter" also gets "Capability Probe", "Vendor" and "Lane" —
terms for a private release process, in a public repository, defining nothing
they can act on.

**They disagree about what a word means, and both are right.** The clearest
case is deployment. In the Host context, Cloudflare Workers is a *Host*: a
platform with a runtime, reached through a registered adapter. In the Fork
Distribution context, the same word appears inside *App Repo* and *Vendor*,
where what matters is which repository owns the source and how a package
reaches it — the runtime is not the subject at all. One merged entry would have
to be vague enough to cover both, which is how a glossary stops being usable.

**Merging is the tidy-looking move and it is the wrong one.** A single
alphabetical list of fifteen terms reads as complete and reads as flat, and a
reader who has just been told `Fork` and `Host` belong to the same vocabulary
will reasonably conclude they sit at the same level of the system. They do not.

## Where the two contexts touch

There is exactly one seam, and it is a boundary rather than a shared term:

- **ADR 0006** (`docs/adr/0006-cloudflare-lane-upstreams-vault-lane-does-not.md`)
  decides which work goes Upstream. It is written in Fork Distribution
  vocabulary and its subject is Host-context code. Read from either side, it is
  the rule that keeps the Host glossary publishable and the Fork Distribution
  glossary private to the fork.
- Consequently: **a document in the Host context may not use a Fork
  Distribution term.** If a `packages/core/src` comment, doc, or ADR needs to
  say "Lane", "App Repo", "Vendor" or "Capability Probe" to make its point, the
  point belongs on the Fork Distribution side of the boundary, not in a file
  headed Upstream.

## ADRs

All ADRs live in one sequence at `docs/adr/`, regardless of which context they
belong to. Only the trunk fork allocates ADR numbers (ADR 0009), and a
per-context sequence would reintroduce exactly the collision that rule exists to
stop. `0010` and `0011` are Host-context; `0006`–`0009` are Fork Distribution;
the rest name their own subject in their title.
