# Design App Repo — provisioned Cloudflare resources

The Cloudflare resources `hyrdrocks/paul-design-app` runs on. Provisioned and
verified 2026-08-06 for spec #5 / ticket #11, ahead of the scaffold in #12.

Everything below **exists now**. Nothing here is a plan.

## Account

| | |
| --- | --- |
| Account name | `Pauls Job` |
| Account id | `6e11e8e7c871694bd4789ce8661fe326` |
| Plan | Workers Paid (Queues, Browser Rendering and the 300 s CPU ceiling all require it) |

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

| Binding | Kind | Resource | Name is fixed by |
| --- | --- | --- | --- |
| `DB` | D1 | `paul-design-app` (id `256288ec-77ac-4e9d-ab1b-8d415e4ee997`, region APAC) | `CLOUDFLARE_D1_BINDING_NAME`, read by `getCloudflareD1Binding()` |
| `UPLOADS` | R2 | `paul-design-app-uploads` | `CLOUDFLARE_R2_BINDING_NAME` in `file-upload/cloudflare-r2.ts` |
| `AGENT_NATIVE_BACKGROUND_QUEUE` | Queue producer | `paul-design-app-agent-background` (id `2a6089b9f4384295826f33e59369435b`) | `AGENT_BACKGROUND_QUEUE_BINDING` in `agent/background-queue.ts` |
| — | Queue consumer | same queue, DLQ `paul-design-app-agent-background-dlq` (id `8bd3355ef05f4efda0e8e35010d7a33d`) | emitted by `configureCloudflareModuleBackgroundQueue()` |
| `BROWSER` | Browser Rendering | account entitlement, no resource to create | `CLOUDFLARE_BROWSER_BINDING_NAME`, and the Design template's `server/lib/playwright-runtime.ts` |

The DLQ exists because the preset names it unconditionally
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
hand-written one for these. Three of the five bindings come from build
environment variables, and two are emitted unconditionally:

```sh
NITRO_PRESET=cloudflare_module
CLOUDFLARE_D1_DATABASE_NAME=paul-design-app
CLOUDFLARE_D1_DATABASE_ID=256288ec-77ac-4e9d-ab1b-8d415e4ee997
CLOUDFLARE_R2_BUCKET_NAME=paul-design-app-uploads
```

`resolveCloudflareD1Binding()` throws when exactly one of the two D1 variables
is set, and returns `null` when neither is — which means "this Worker uses an
external `DATABASE_URL`" and emits no binding at all. Setting neither is a
silent SQLite path, not an error, so both must be present on every build that is
meant to reach D1.

`resolveCloudflareR2Binding()` is looser: absent means "no object storage", the
`UPLOADS` binding is simply not emitted, and uploads fail closed at runtime
rather than reaching SQL. So a build that forgets `CLOUDFLARE_R2_BUCKET_NAME`
deploys clean and breaks the first upload.

The queue (producer, consumer, DLQ, `cpu_ms: 300000`) and the `BROWSER` binding
need no variables — the preset writes them from the Worker name.

See `design-app.build.env.example` and `design-app.wrangler.reference.jsonc` in
this directory.

## Runtime configuration

Non-secret, belongs in `wrangler.jsonc` `vars` (committed):

| Var | Value |
| --- | --- |
| `CLOUDFLARE_R2_PUBLIC_BASE_URL` | the r2.dev address above |
| `APP_URL` / `BETTER_AUTH_URL` | the public origin — recommended `https://design.paulsjob.ai`, mirroring `dispatch.paulsjob.ai`. **Not created yet**; a `custom_domain` route creates the DNS record on first deploy. Better Auth builds cookies and OAuth redirects from `BETTER_AUTH_URL`, so it must match the route exactly. |
| `MCP_SERVER_NAME` | optional; without it core derives `agent-native-design` from the hostname |

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

| Runtime | Storage | Reaches `process.env` via |
| --- | --- | --- |
| Deployed Worker | `wrangler secret put ANTHROPIC_API_KEY` | Nitro's Cloudflare preset |
| Local Workers run | `.output/server/.dev.vars` (written from `.cf-local/dev.vars` by the template's `justfile`) | same |

Two storage locations, one reader. That is the distinction that matters: a
second *store* is fine, a second *read site* is the bug.

## Local run and deployed run take the same path

ADR 0003 records that the local Workers runtime counts as hosted. Concretely,
for this app:

- Local development for anything Cloudflare-shaped is `just cf` in the app repo
  — a real `wrangler dev` on workerd against the generated `wrangler.json`, not
  `pnpm dev` on Node and SQLite. `pnpm dev` remains available and is a genuinely
  different runtime; it is not a proof of anything on this list.
- `just cf`'s build must gain `CLOUDFLARE_R2_BUCKET_NAME=paul-design-app-uploads`.
  The Design template's current `justfile` sets only the two D1 variables, so a
  local build today emits **no `UPLOADS` binding** and the upload path fails
  closed locally while working deployed. That is exactly the silent divergence
  this criterion exists to prevent.
- The local D1 id stays the placeholder in the `justfile`. Miniflare never
  contacts Cloudflare for it, and pointing local runs at the real D1 id would
  not use the real database anyway.
- Bind R2 in **remote** mode locally (`"remote": true` on the `r2_buckets`
  entry). Verified below: with a local R2, an upload succeeds and the URL the
  app persists 404s, because that URL names the real r2.dev host and the object
  went to a miniflare directory. A stored-but-dangling URL is precisely the
  "looks like success" failure this codebase forbids. Remote mode makes the
  persisted URL resolve.
- The queue and `BROWSER` need nothing: both work in local mode, verified below.

## Verification

Not "the create command returned 0". A throwaway module Worker named
`paul-design-app` was deployed with all five bindings and driven over HTTP, then
deleted. Every step used the binding rather than inspecting it.

Deployed run, all five green:

| Step | Result |
| --- | --- |
| D1 `create table` / `insert` / `select` through `env.DB` | row read back |
| R2 `put` then `get` through `env.UPLOADS` | body matched |
| `GET https://pub-….r2.dev/uploads/<uuid>.txt` | `200`, body matched |
| `env.AGENT_NATIVE_BACKGROUND_QUEUE.send()` | accepted |
| queue consumer wrote to D1, read back over HTTP | 3 of 3 messages consumed |
| `puppeteer.launch(env.BROWSER)`, `setContent`, `$eval`, `screenshot` | text read back, 6615-byte PNG |

Local `wrangler dev` run, same code, same config, D1/queue/browser local and R2
remote: identical results, including the queue round-trip and a 5849-byte
screenshot. With R2 in *local* mode the public-URL step returned `404` — the
divergence recorded above.

Probe artifacts were removed afterwards: the `binding_probe` table dropped, the
four probe objects deleted, the queue consumer deregistered, the Worker deleted.
The database, bucket and both queues remain.

## Known gaps for #12

- **`design.paulsjob.ai` does not exist.** The first deploy with a
  `custom_domain` route creates it. No DNS record was created here.
- **No secrets are set on any Worker**, because no Worker exists.
  `BETTER_AUTH_SECRET`, `A2A_SECRET` and the provider key are all still to do.
- **The Design template carries 51 pre-existing `no-env-credentials` findings**
  (`npx agent-native doctor --only no-env-credentials` in
  `sonhyrd/agent-native`'s `templates/design`). None are provider keys or
  `CLOUDFLARE_R2_*` — they are E2E harness variables, `APP_BASE_PATH`, a fuzz
  seed, and `GITHUB_TOKEN` in a test file. The app repo inherits them when it
  takes ownership of the template source. The single-resolver criterion is met
  for credentials; this backlog is separate and is not made worse by anything
  here.
