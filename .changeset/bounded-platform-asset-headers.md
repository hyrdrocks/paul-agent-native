---
"@agent-native/core": patch
---

Bound the Netlify and Vercel immutable-asset config to one entry per mount
point instead of one per content-hashed asset, so neither file grows with the
app. On a two-app workspace carrying 400 hashed assets each, the generated
`_headers` goes from 1600 blocks to 4 and the Vercel `config.json` from 800
header routes to 2.

The collapse is not the same on both platforms, because their formats do not
express the same thing. Vercel's `src` is a regex, so it carries the exact
hashed-filename test — an unhashed file sitting in the same directory is not
newly covered, which the `/assets/**` glob a `_headers` file is limited to
cannot avoid. Netlify has no regex form, so it takes `/assets/:file`: a
placeholder matches one path segment where `*` crosses `/`, which leaves a
subdirectory of hand-maintained files uncovered rather than pinned for a year.
What it still cannot exclude is an unhashed file directly in `assets/`, so the
Netlify build now names those files rather than widening the policy in silence,
and it names only the ones the rule actually pins.

`collectImmutableAssetPaths` is unchanged and still decides per-path headers at
runtime, where exactness is affordable.
