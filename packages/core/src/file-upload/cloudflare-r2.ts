/**
 * The Cloudflare R2 file-upload provider.
 *
 * This host has no filesystem and its database is the one place a file payload
 * must never go, so object storage is the only durable store a Worker has. The
 * provider is the producer half only: it writes the object through the bound
 * bucket and returns the URL that reads it back.
 *
 * Every failure mode is a DISTINCT typed value rather than a coerced success:
 * an unbound bucket, a binding that is not a bucket, and a bucket with no
 * readable public base URL are three different conditions with three different
 * repairs. None of them may resolve to "stored".
 */

import { isCloudflareRuntime } from "../shared/runtime.js";
import { FileUploadStorageNotConfiguredError } from "./errors.js";
import type {
  FileUploadInput,
  FileUploadProvider,
  FileUploadResult,
} from "./types.js";

/**
 * The R2 binding name this provider reads, and the one the build emits. Fixed
 * rather than configurable for the same reason as `CLOUDFLARE_D1_BINDING_NAME`
 * — a renameable binding is configuration no reader honours.
 */
export const CLOUDFLARE_R2_BINDING_NAME = "UPLOADS";

/**
 * Public origin objects in the bucket are read back from: the managed r2.dev
 * address or a custom domain. Resolved through `resolveSecret`, which is the
 * single reader for app-provided deploy configuration — a direct
 * `process.env` read here would split the app in two, so Settings would report
 * uploads as configured while every upload failed naming the wrong cause.
 */
export const CLOUDFLARE_R2_PUBLIC_BASE_URL_KEY =
  "CLOUDFLARE_R2_PUBLIC_BASE_URL";

export const CLOUDFLARE_R2_PROVIDER_ID = "cloudflare-r2";

/** Prefix every object this provider writes shares, so the bucket stays legible. */
const OBJECT_KEY_PREFIX = "uploads";

/** Minimal shape of an R2 bucket binding. */
interface R2BucketLike {
  put(
    key: string,
    value: ArrayBuffer | ArrayBufferView,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
}

function readCloudflareEnv(): Record<string, unknown> | null {
  const scope = globalThis as {
    __cf_env?: Record<string, unknown>;
    __env__?: Record<string, unknown>;
  };
  return scope.__cf_env ?? scope.__env__ ?? null;
}

/**
 * The bound bucket, or null when nothing is bound. Null is "absent", not
 * "unusable": a binding that exists but cannot `put` is a configuration error
 * and resolves to null here too — but it is reported, because a named binding
 * that cannot store is not the same fact as no binding at all.
 */
export function resolveCloudflareR2Bucket(): R2BucketLike | null {
  const env = readCloudflareEnv();
  if (!env) return null;
  const binding = env[CLOUDFLARE_R2_BINDING_NAME];
  if (binding == null) return null;
  if (
    typeof binding !== "object" ||
    typeof (binding as R2BucketLike).put !== "function"
  ) {
    console.error(
      `[agent-native] the ${CLOUDFLARE_R2_BINDING_NAME} binding exists but is not an R2 bucket ` +
        "(no put()) — object storage is unavailable on this Worker.",
    );
    return null;
  }
  return binding as R2BucketLike;
}

/** True when this Worker can actually write an object. */
export function hasBoundCloudflareR2Bucket(): boolean {
  if (!isCloudflareRuntime()) return false;
  return resolveCloudflareR2Bucket() !== null;
}

function extensionOf(filename: string | undefined): string {
  if (!filename) return "";
  const dot = filename.lastIndexOf(".");
  if (dot <= 0 || dot === filename.length - 1) return "";
  const ext = filename.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,12}$/.test(ext) ? `.${ext}` : "";
}

/**
 * The key an object is stored under.
 *
 * A random UUID, never the caller's filename or owner: the bucket is world
 * readable by construction, so the key IS the capability that protects the
 * object. Anything guessable or enumerable here hands every upload to whoever
 * can guess a name.
 */
export function buildCloudflareR2ObjectKey(filename?: string): string {
  return `${OBJECT_KEY_PREFIX}/${crypto.randomUUID()}${extensionOf(filename)}`;
}

function joinPublicUrl(baseUrl: string, key: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${key}`;
}

async function resolvePublicBaseUrl(): Promise<string | null> {
  const { resolveSecret } = await import("../server/credential-provider.js");
  const value = await resolveSecret(CLOUDFLARE_R2_PUBLIC_BASE_URL_KEY);
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function notConfigured(reason: string, setup: string): never {
  throw new FileUploadStorageNotConfiguredError({
    policy: CLOUDFLARE_R2_PROVIDER_ID,
    reason,
    setup,
  });
}

export const cloudflareR2FileUploadProvider: FileUploadProvider = {
  id: CLOUDFLARE_R2_PROVIDER_ID,
  name: "Cloudflare R2",
  isConfigured: hasBoundCloudflareR2Bucket,
  async upload(input: FileUploadInput): Promise<FileUploadResult> {
    const bucket = resolveCloudflareR2Bucket();
    if (!bucket) {
      notConfigured(
        "Object storage is not available on this Worker.",
        `Bind an R2 bucket as ${CLOUDFLARE_R2_BINDING_NAME} by building with CLOUDFLARE_R2_BUCKET_NAME set to the bucket's name.`,
      );
    }

    // Resolved BEFORE the put. An object written under a URL that resolves to
    // nothing is a dangling upload every layer above reports as a success —
    // exactly the shape this path exists to stop producing.
    const baseUrl = await resolvePublicBaseUrl();
    if (!baseUrl) {
      notConfigured(
        "Object storage is bound but has no public base URL, so a stored object could not be read back.",
        `Set ${CLOUDFLARE_R2_PUBLIC_BASE_URL_KEY} to the bucket's public origin (its r2.dev address or a custom domain).`,
      );
    }

    const key = buildCloudflareR2ObjectKey(input.filename);
    // Copy element-wise into a fresh buffer: a Buffer or a subarray is a
    // window onto a larger pool, so passing its `.buffer` stores the pool.
    // Buffer's own `slice()` is the deprecated alias for `subarray` and copies
    // nothing, which is why this does not use it.
    const body = new Uint8Array(input.data).buffer;
    await bucket.put(key, body, {
      httpMetadata: input.mimeType
        ? { contentType: input.mimeType }
        : undefined,
    });

    return {
      url: joinPublicUrl(baseUrl, key),
      id: key,
      provider: CLOUDFLARE_R2_PROVIDER_ID,
    };
  },
};
