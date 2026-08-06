---
"@agent-native/creative-context": patch
"@agent-native/scheduling": patch
"@agent-native/dispatch": patch
"@agent-native/pinpoint": patch
"@agent-native/frame": patch
---

Renumber the five packages that entering changesets pre mode bumped to `1.0.0`
back onto the `0.x` line, so a Fork version is the Upstream version it forks
advanced by its own changesets, plus the `-paul.N` prerelease suffix. No
changeset ever asked for that major: it is what changesets does to a package
declaring `@agent-native/core` as a `>=` peer dependency once core's version
carries a prerelease, because a prerelease satisfies no plain `>=` range.
`@agent-native/dispatch` goes to `0.17.0-paul.0`, and `creative-context`,
`frame`, `pinpoint` and `scheduling` to a patch above their baselines. A
vendored tarball name therefore moves backwards without the build inside it
moving backwards; `docs/adr/0008` says why.
