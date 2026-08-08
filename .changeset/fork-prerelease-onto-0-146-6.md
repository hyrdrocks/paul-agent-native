---
"@agent-native/creative-context": patch
"@agent-native/dispatch": patch
"@agent-native/skills": patch
"@agent-native/core": patch
---

Carry the fork's prerelease tag onto the Upstream 0.146.6 baseline, so no
package in the trunk ships under a number Upstream has already published.

Merging Upstream took its side of every conflicting `version` line, which is
correct — the Re-baseline owns those numbers — but it also erased the `-paul`
tag from the four packages whose trees actually differ from Upstream. Every
pending changeset was already recorded as applied in pre mode, so the version
pass had nothing to re-apply and left core sitting on exactly `0.146.6`: a
tarball name-identical to a real published release, carrying 133 files of fork
source. That is the version lying about what it contains, and it is what the
Capability Probe has to catch afterwards instead.

The four named here are precisely the packages whose `src` differs from
`5297bd478`. `frame`, `pinpoint` and `scheduling` are not named — they carry no
fork source and are already tagged from the last Sync; they move only as
dependents. `recap-cli`, `toolkit` and `agent-browser-extension` stay on
Upstream's plain numbers because they are byte-identical to Upstream, which is
the one case a reused plain version is honest.

Patch, deliberately, and not because a patch is all this is worth. A minor or
major on core is what puts every package declaring core as a `>=` peer out of
range, and changesets answers that by majoring all five at once — measured
again here, and it still lands `dispatch`, `creative-context`, `frame`,
`pinpoint` and `scheduling` on `1.0.0`. ADR 0008 had to undo that once.
