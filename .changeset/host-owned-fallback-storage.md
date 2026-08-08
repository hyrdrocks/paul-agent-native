---
"@agent-native/core": patch
---

Give the Host ownership of fallback-storage policy, and add this Host's object
storage provider behind that seam.

`uploadFile()` used to return `null` for three different facts — no provider is
configured, the credential store could not be read, and this deployment permits
no alternative store at all — and every caller resolved all three the same way,
by keeping the file body and writing it into SQL. A call site cannot answer that
question: whether a payload may be stored somewhere other than the store it was
meant for is a property of the Host.

So it is asked once. Hosts register a policy under `hosts/fallback-storage`
declaring their own consultation priority, exactly as background transports do,
and a refusal carries the setup step that fixes it rather than only a "no".
Cloudflare Workers refuse — the database there is D1 — and a portable baseline
refuses for any unrecognised process running against a persistent `DATABASE_URL`
or in production, so an unrecognised deployment is never the reason a payload
reaches SQL. A local run against a local database still gets the documented
capped fallback.

`uploadFile()` now returns `null` for exactly one condition: no provider is
configured AND this host permits the caller to store the payload elsewhere. The
other two are typed throws — `FileUploadStorageNotConfiguredError`, carrying
`.setup`, and `FileUploadProviderUnreadableError`, which is raised instead of
reporting "not configured" when a credential lookup failed. The two `catch {}`
blocks that coerced a failed lookup into "unavailable" are gone;
`resolveFileUploadProviderForRequest()` reports `provider` / `absent` /
`unreadable` as distinct results. Chat attachment pre-upload no longer recovers
a refusal by keeping the base64 payload on a message that is about to be
persisted, and the resource upload, file-upload and upload-image surfaces report
the store's own setup guidance instead of a hardcoded connect-Builder line.

Adds `cloudflareR2FileUploadProvider`, registered by the Cloudflare host adapter
and reporting itself unconfigured anywhere else. It writes through the `UPLOADS`
binding and resolves the bucket's public origin through `resolveSecret`, the
single reader for app-provided deploy configuration. It resolves that origin
_before_ the put: an object stored under a URL that resolves to nothing is a
dangling upload every layer above reads as a success. Object keys are a random
UUID plus the extension, never the filename or owner, because the bucket is
world-readable by construction and the key is what protects the object.

The build emits an `r2_buckets` binding when `CLOUDFLARE_R2_BUCKET_NAME` is set,
and nothing at all when it is not — modelled on the D1 emitter. An
unconditional binding would make a bucket a prerequisite for every Cloudflare
deploy, discovered from a `wrangler deploy` failure rather than from anything
the app configured. Uploads fail closed at runtime with setup guidance instead.
