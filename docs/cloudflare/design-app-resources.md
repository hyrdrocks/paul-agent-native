# Design App Repo — provisioned Cloudflare resources

The Cloudflare resources `hyrdrocks/paul-design-app` runs on. Provisioned and
verified 2026-08-06 for spec #5 / ticket #11, ahead of the scaffold in #12.

Everything below **exists now**. Nothing here is a plan.

## Account

|              |                                                                                   |
| ------------ | --------------------------------------------------------------------------------- |
| Account name | `Pauls Job`                                                                       |
| Account id   | `6e11e8e7c871694bd4789ce8661fe326`                                                |
| Plan         | Workers Paid (Queues, Browser Rendering and the 300 s CPU ceiling all require it) |

The same account already runs `paul-dispatch-app`. It is reused deliberately: a
second account would split billing and entitlements, and this repo's
credentials-per-organization rule makes a second identity boundary expensive for
no gain. An account id is an identifier, not a credential — the dispatch app
already commits its own.

The OAuth token that provisioned these can see two accounts, so `wrangler`
cannot infer one. Every command below needs `account_id` in the config file or
`CLOUDFLARE_ACCOUNT_ID` in the environment, or it fails non-interactively.

## Worker name

The Worker **must** be named `paul-design-app`.

This is not cosmetic. `agentBackgroundQueueName()` in `@agent-native/core`
derives the background queue name from the Worker's own name, and the build
preset writes both the producer binding and the consumer registration from it.
A Worker named anything else produces into `<name>-agent-background`, which does
not exist, and the durable background run fails at send time.

Not `paul-design`. `hyrdrocks/paul-design` is an unrelated existing repository
in the same organisation (spec #5, Out of Scope).

## Bindings

Every binding name is a framework constant, not app configuration. Renaming any
of them yields a binding nothing reads.

**All of these are emitted as of R5.** Measured on the first real deploy of
`paul-design-app` (#12) the generated `wrangler.json` carried `DB` and `ASSETS`
and nothing else. R3 (#14) added the queue emitter, R4 (#15) added
`resolveCloudflareR2Binding` and the `r2_buckets` emitter, and R5 (#16) added
`resolveCloudflareBrowserBinding` and the `browser` emitter. A build with
`CLOUDFLARE_R2_BUCKET_NAME` set binds `UPLOADS`; a build with
`CLOUDFLARE_BROWSER_RENDERING=1` binds `BROWSER`. Verified on the deploy:
`env.UPLOADS (paul-design-app-uploads)  R2 Bucket` and `env.BROWSER  Browser`.
Neither variable is inert, and the local-versus-remote R2 divergence below is
live — see the `justfile` note under Local run.

The R2 emitter is conditional, like D1: with
`CLOUDFLARE_R2_BUCKET_NAME` unset the generated config carries no `r2_buckets`
key at all, the deploy succeeds, and uploads fail closed at runtime with setup
guidance. That absent-binding deploy is what #15's AC3 negative control ran
against.

The `browser` emitter is conditional the same way, and for a reason worth
stating because Browser Rendering has no resource behind it. An entitlement is
_more_ of a deploy prerequisite than a resource, not less: `wrangler deploy`
rejects a binding the account is not entitled to, so an unconditional emit would
fail the deploy of every app that never renders anything — R3's queue mistake
(#30, since fixed: the queue emitter is conditional too, see below) in a second
place. With no id to derive from, `CLOUDFLARE_BROWSER_RENDERING`
declares intent rather than pointing at something; what stops it being a switch
nobody flips is that a Worker with no `BROWSER` bound refuses at the first render
and names both the variable and the binding. That absent-binding deploy is what
#16's AC3 negative control ran against.

| Binding                         | Kind              | Resource                                                                                       | Name is fixed by                                                                                                                                                  |
| ------------------------------- | ----------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DB`                            | D1                | `paul-design-app` (id `256288ec-77ac-4e9d-ab1b-8d415e4ee997`, region APAC)                     | `CLOUDFLARE_D1_BINDING_NAME`, read by `getCloudflareD1Binding()`                                                                                                  |
| `UPLOADS`                       | R2                | `paul-design-app-uploads`                                                                      | `CLOUDFLARE_R2_BINDING_NAME` in `file-upload/cloudflare-r2.ts`                                                                                                    |
| `AGENT_NATIVE_BACKGROUND_QUEUE` | Queue producer    | `paul-design-app-agent-background` (id `2a6089b9f4384295826f33e59369435b`)                     | `AGENT_BACKGROUND_QUEUE_BINDING` in `agent/background-queue.ts`                                                                                                   |
| —                               | Queue consumer    | same queue, DLQ `paul-design-app-agent-background-dlq` (id `8bd3355ef05f4efda0e8e35010d7a33d`) | emitted by `configureCloudflareModuleBackgroundQueue()`                                                                                                           |
| `BROWSER`                       | Browser Rendering | account entitlement, no resource to create                                                     | `CLOUDFLARE_BROWSER_BINDING_NAME` in `browser-rendering/cloudflare-browser.ts`, read through the seam by the Design template's `server/lib/playwright-runtime.ts` |

The DLQ exists because the emitted consumer names it
(`` `${queueName}-dlq` ``). A missing DLQ is a deploy-time failure, not a
runtime one, so it was created rather than left to be discovered.

### The queue consumer is currently unregistered

Queues report `consumers: 0` today. The consumer was registered during
verification and removed again when the probe Worker was deleted — a Worker
that is a queue consumer cannot be deleted while the registration stands. The
first real deploy of `paul-design-app` re-registers it from the generated
config; nothing needs doing by hand.

## R2 public access

`cloudflareR2FileUploadProvider` persists a **URL**, not an object handle, so
the bucket must be publicly readable or every upload throws
`FileUploadStorageNotConfiguredError` at the point the URL would be formed.
Public access is enabled on `paul-design-app-uploads` via the managed r2.dev
address:

    CLOUDFLARE_R2_PUBLIC_BASE_URL=https://pub-547d1dbdb13249b492798093733b130b.r2.dev

This is a public URL by construction, not a secret. What protects an object is
the key: `buildCloudflareR2ObjectKey()` uses a random UUID precisely because the
bucket is world-readable. Do not add owner-scoped or guessable keys to this
bucket on the assumption that something else is guarding it.

r2.dev is rate-limited and Cloudflare does not recommend it for production
traffic. Moving to a custom domain (`uploads.paulsjob.ai`) later is a
`CLOUDFLARE_R2_PUBLIC_BASE_URL` change plus a DNS record, and it does not
invalidate objects already stored — but URLs already persisted in SQL keep
pointing at r2.dev, so do it before real content lands, or not at all.

## Build-time configuration

The Worker preset generates `.output/server/wrangler.json`; it does not read a
hand-written one for these. Four of the five bindings come from build
environment variables, and only `ASSETS` is emitted unconditionally:

```sh
NITRO_PRESET=cloudflare_module
CLOUDFLARE_D1_DATABASE_NAME=paul-design-app
CLOUDFLARE_D1_DATABASE_ID=256288ec-77ac-4e9d-ab1b-8d415e4ee997
CLOUDFLARE_R2_BUCKET_NAME=paul-design-app-uploads
CLOUDFLARE_BROWSER_RENDERING=1
CLOUDFLARE_BACKGROUND_QUEUE=1
```

`resolveCloudflareD1Binding()` throws when exactly one of the two D1 variables
is set, and returns `null` when neither is — which means "this Worker uses an
external `DATABASE_URL`" and emits no binding at all. Setting neither is a
silent SQLite path, not an error, so both must be present on every build that is
meant to reach D1.

`resolveCloudflareR2Binding()` is looser: absent means "no object storage", the
`UPLOADS` binding is simply not emitted, and uploads fail closed at runtime
rather than reaching SQL. So a build that forgets `CLOUDFLARE_R2_BUCKET_NAME`
deploys clean and breaks the first upload — with a typed refusal naming the
variable, not silently.

`CLOUDFLARE_R2_PUBLIC_BASE_URL` is resolved at **runtime**, not build time, and
is now on `APP_PROVIDED_DEPLOY_CREDENTIAL_KEYS` so `resolveSecret` reads it on an
invocation with no request user. It is committed in `wrangler.jsonc` `vars`.

`resolveCloudflareBrowserBinding()` reads `CLOUDFLARE_BROWSER_RENDERING` and
accepts `1`/`true`/`yes`/`on` or `0`/`false`/`no`/`off`; anything else throws
rather than being read as either answer, because truthiness would make
`=maybe` mean on and a strict `=== "1"` would make it mean off, and both are a
deploy that does not match what its operator wrote down.

`CLOUDFLARE_BACKGROUND_QUEUE` declares that
`paul-design-app-agent-background` and its `-dlq` exist. Like
`CLOUDFLARE_BROWSER_RENDERING` it names nothing — the queue name is still
derived from the Worker's name — but unlike every other variable here, omitting
it is not a quiet no-binding deploy. A build that still wants durable background
runs (`AGENT_CHAT_DURABLE_BACKGROUND` unset or truthy, the default on Workers)
is REFUSED at build time, naming both queues and both ways out. That asymmetry
is deliberate: an unbound `UPLOADS` fails the first upload loudly, whereas an
unbound queue leaves every background turn running inline under the foreground
clamp on a Worker that looks healthy. The one variable that does not gate a
binding is `cpu_ms: 300000`, which the preset raises on every build — a long
turn needs the ceiling most when it has no queue to escape to.

The DLQ must exist before the queue is useful, and before either the emitted
consumer is accepted:

```sh
wrangler queues create paul-design-app-agent-background-dlq
wrangler queues create paul-design-app-agent-background
```

See `design-app.build.env.example` and `design-app.wrangler.reference.jsonc` in
this directory.

## Runtime configuration

Non-secret, belongs in `wrangler.jsonc` `vars` (committed):

| Var                             | Value                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_R2_PUBLIC_BASE_URL` | the r2.dev address above                                                                                                                                                                                                                                                                        |
| `APP_URL` / `BETTER_AUTH_URL`   | the public origin — recommended `https://design.paulsjob.ai`, mirroring `dispatch.paulsjob.ai`. **Not created yet**; a `custom_domain` route creates the DNS record on first deploy. Better Auth builds cookies and OAuth redirects from `BETTER_AUTH_URL`, so it must match the route exactly. |
| `MCP_SERVER_NAME`               | optional; without it core derives `agent-native-design` from the hostname                                                                                                                                                                                                                       |

Secret, set with `wrangler secret put` and never committed:

`BETTER_AUTH_SECRET`, `A2A_SECRET`, and the agent provider key
(`ANTHROPIC_API_KEY`, optionally `ANTHROPIC_BASE_URL`).

## Provider credentials resolve through exactly one path

The agent provider key is an **app-provided deploy credential**: it pays for the
deployment's own model usage and identifies no user.

The single resolver is `resolveSecret(key)` in
`@agent-native/core/server/credential-provider`. It checks the `app_secrets`
store first (per-user, then per-org), and only then falls back to
`readDeployCredentialEnv(key)` — the one function in the system that reads
`process.env` for a credential. `ANTHROPIC_API_KEY` is on the
`APP_PROVIDED_DEPLOY_CREDENTIAL_KEYS` allow-list, so
`canUseDeployCredentialFallbackForRequest()` permits that fallback even under a
signed-in request on a hosted deploy.

**Do not add a second read.** A direct `process.env.ANTHROPIC_API_KEY` anywhere
in the app does not leak — it splits the app in two, so Settings reports the
integration as configured while the feature fails claiming the variable is
unset, and the error names the wrong cause.

`resolveCredential(key, { userEmail, orgId })` is the wrong helper here: it
searches exactly one organization, and the queue consumer invocation that runs a
durable background turn has no request user and no org at all. `resolveSecret`
handles that case correctly — `getRequestUserEmail()` returns null,
`canUseDeployCredentialFallbackForRequest()` returns true, and the deploy key is
read. Swapping to `resolveCredential` here would look like a hardening fix and
would break every background run.

`CLOUDFLARE_R2_PUBLIC_BASE_URL` goes through the same `resolveSecret` path and
is on the same allow-list, for the same reason — it configures the app, not a
user.

### Where the value physically lives

| Runtime           | Storage                                                                                     | Reaches `process.env` via |
| ----------------- | ------------------------------------------------------------------------------------------- | ------------------------- |
| Deployed Worker   | `wrangler secret put ANTHROPIC_API_KEY`                                                     | Nitro's Cloudflare preset |
| Local Workers run | `.output/server/.dev.vars` (written from `.cf-local/dev.vars` by the template's `justfile`) | same                      |

Two storage locations, one reader. That is the distinction that matters: a
second _store_ is fine, a second _read site_ is the bug.

## Local run and deployed run take the same path

ADR 0003 records that the local Workers runtime counts as hosted. Concretely,
for this app:

- Local development for anything Cloudflare-shaped is `just cf` in the app repo
  — a real `wrangler dev` on workerd against the generated `wrangler.json`, not
  `pnpm dev` on Node and SQLite. `pnpm dev` remains available and is a genuinely
  different runtime; it is not a proof of anything on this list.
- ~~`just cf`'s build must gain `CLOUDFLARE_R2_BUCKET_NAME=…`.~~ Closed: the app
  repo's `justfile` sets it, and as of #15 a local build emits `UPLOADS` from it.
  The `justfile` also **fails the build** when that binding is missing, so the
  silent local-versus-deployed divergence cannot come back quietly.
- The local D1 id stays the placeholder in the `justfile`. Miniflare never
  contacts Cloudflare for it, and pointing local runs at the real D1 id would
  not use the real database anyway.
- Bind R2 in **remote** mode locally (`"remote": true` on the `r2_buckets`
  entry). The app repo's `justfile` now rewrites the generated config to do this
  after every build. Verified below: with a local R2, an upload succeeds and the URL the
  app persists 404s, because that URL names the real r2.dev host and the object
  went to a miniflare directory. A stored-but-dangling URL is precisely the
  "looks like success" failure this codebase forbids. Remote mode makes the
  persisted URL resolve.
- The queue works in local mode, verified below. `BROWSER` needs
  `CLOUDFLARE_BROWSER_RENDERING=1` on the local build too, or the local run has
  no browser while the deploy has one — the same divergence the `justfile`
  closes for R2.

## Verification

Not "the create command returned 0". A throwaway module Worker named
`paul-design-app` was deployed with all five bindings and driven over HTTP, then
deleted. Every step used the binding rather than inspecting it.

Deployed run, all five green:

| Step                                                                 | Result                        |
| -------------------------------------------------------------------- | ----------------------------- |
| D1 `create table` / `insert` / `select` through `env.DB`             | row read back                 |
| R2 `put` then `get` through `env.UPLOADS`                            | body matched                  |
| `GET https://pub-….r2.dev/uploads/<uuid>.txt`                        | `200`, body matched           |
| `env.AGENT_NATIVE_BACKGROUND_QUEUE.send()`                           | accepted                      |
| queue consumer wrote to D1, read back over HTTP                      | 3 of 3 messages consumed      |
| `puppeteer.launch(env.BROWSER)`, `setContent`, `$eval`, `screenshot` | text read back, 6615-byte PNG |

Local `wrangler dev` run, same code, same config, D1/queue/browser local and R2
remote: identical results, including the queue round-trip and a 5849-byte
screenshot. With R2 in _local_ mode the public-URL step returned `404` — the
divergence recorded above.

Probe artifacts were removed afterwards: the `binding_probe` table dropped, the
four probe objects deleted, the queue consumer deregistered, the Worker deleted.
The database, bucket and both queues remain.

## Known gaps for #12

- ~~**`design.paulsjob.ai` does not exist.**~~ Closed in #12: the first deploy
  created the DNS record and the certificate, as predicted.
- ~~**No secrets are set on any Worker.**~~ Partly closed in #12:
  `BETTER_AUTH_SECRET` and `A2A_SECRET` are set on `paul-design-app`.
  `ANTHROPIC_API_KEY` is still unset, so agent turns fail on that deploy.
- **The first action call of a cold isolate is slow enough to time out.**
  `POST /_agent-native/actions/create-design` exceeded 15 s on two of five e2e
  runs against the deploy and passed on immediate retry each time. Cold isolate
  plus cold D1, not a failure of the write path — the same shape as the dispatch
  app's open "sign-up and sign-in fail on cold Worker isolates".
- **The Design template carries 51 pre-existing `no-env-credentials` findings**
  (`npx agent-native doctor --only no-env-credentials` in
  `sonhyrd/agent-native`'s `templates/design`). None are provider keys or
  `CLOUDFLARE_R2_*` — they are E2E harness variables, `APP_BASE_PATH`, a fuzz
  seed, and `GITHUB_TOKEN` in a test file. The app repo inherits them when it
  takes ownership of the template source. The single-resolver criterion is met
  for credentials; this backlog is separate and is not made worse by anything
  here.
