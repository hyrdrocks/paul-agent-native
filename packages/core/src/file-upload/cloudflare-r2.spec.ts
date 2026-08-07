import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildCloudflareR2ObjectKey,
  cloudflareR2FileUploadProvider,
  CLOUDFLARE_R2_BINDING_NAME,
  hasBoundCloudflareR2Bucket,
  resolveCloudflareR2Bucket,
} from "./cloudflare-r2.js";
import { FileUploadStorageNotConfiguredError } from "./errors.js";

const resolveSecretMock = vi.hoisted(() => vi.fn());
vi.mock("../server/credential-provider.js", () => ({
  resolveSecret: resolveSecretMock,
}));

const scope = globalThis as { __cf_env?: Record<string, unknown> };

function bindBucket(bucket: unknown): void {
  scope.__cf_env = { [CLOUDFLARE_R2_BINDING_NAME]: bucket };
}

function makeBucket() {
  const puts: { key: string; body: ArrayBuffer; options?: unknown }[] = [];
  return {
    puts,
    put: vi.fn(async (key: string, body: ArrayBuffer, options?: unknown) => {
      puts.push({ key, body, options });
    }),
  };
}

describe("cloudflare r2 file upload provider", () => {
  beforeEach(() => {
    delete scope.__cf_env;
    resolveSecretMock.mockReset();
    resolveSecretMock.mockResolvedValue("https://pub-test.r2.dev");
  });

  afterEach(() => {
    delete scope.__cf_env;
  });

  describe("binding resolution", () => {
    it("reports no bucket off the Cloudflare runtime", () => {
      expect(resolveCloudflareR2Bucket()).toBeNull();
      expect(hasBoundCloudflareR2Bucket()).toBe(false);
      expect(cloudflareR2FileUploadProvider.isConfigured()).toBe(false);
    });

    it("resolves a bound bucket", () => {
      const bucket = makeBucket();
      bindBucket(bucket);
      expect(resolveCloudflareR2Bucket()).toBe(bucket);
      expect(hasBoundCloudflareR2Bucket()).toBe(true);
    });

    it("reports a binding that is not a bucket rather than treating it as one", () => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      bindBucket({ notABucket: true });

      expect(resolveCloudflareR2Bucket()).toBeNull();
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining("is not an R2 bucket"),
      );
      error.mockRestore();
    });
  });

  describe("object keys", () => {
    it("keeps the extension and nothing else from the filename", () => {
      const key = buildCloudflareR2ObjectKey("holiday-photo.PNG");
      expect(key).toMatch(/^uploads\/[0-9a-f-]{36}\.png$/);
      expect(key).not.toContain("holiday");
    });

    it("never repeats a key for the same filename", () => {
      const a = buildCloudflareR2ObjectKey("x.png");
      const b = buildCloudflareR2ObjectKey("x.png");
      expect(a).not.toBe(b);
    });

    it("drops an extension that is not a plain extension", () => {
      expect(buildCloudflareR2ObjectKey("evil.../../etc/passwd")).toMatch(
        /^uploads\/[0-9a-f-]{36}$/,
      );
      expect(buildCloudflareR2ObjectKey(undefined)).toMatch(
        /^uploads\/[0-9a-f-]{36}$/,
      );
    });
  });

  describe("upload", () => {
    it("stores the bytes and returns the url they read back from", async () => {
      const bucket = makeBucket();
      bindBucket(bucket);

      const result = await cloudflareR2FileUploadProvider.upload({
        data: new Uint8Array([1, 2, 3]),
        filename: "a.png",
        mimeType: "image/png",
      });

      expect(bucket.put).toHaveBeenCalledTimes(1);
      const [key, body, options] = bucket.put.mock.calls[0];
      expect(new Uint8Array(body as ArrayBuffer)).toEqual(
        new Uint8Array([1, 2, 3]),
      );
      expect(options).toEqual({ httpMetadata: { contentType: "image/png" } });
      expect(result).toEqual({
        url: `https://pub-test.r2.dev/${key}`,
        id: key,
        provider: "cloudflare-r2",
      });
    });

    it("stores only the caller's bytes, not the pool a Buffer view sits in", async () => {
      const bucket = makeBucket();
      bindBucket(bucket);
      const pool = Buffer.alloc(64, 7);
      const view = pool.subarray(8, 11);

      await cloudflareR2FileUploadProvider.upload({ data: view });

      const stored = new Uint8Array(bucket.put.mock.calls[0][1] as ArrayBuffer);
      expect(stored.byteLength).toBe(3);
    });

    it("fails closed with setup guidance when no bucket is bound", async () => {
      await expect(
        cloudflareR2FileUploadProvider.upload({ data: new Uint8Array([1]) }),
      ).rejects.toThrow(FileUploadStorageNotConfiguredError);
      await expect(
        cloudflareR2FileUploadProvider.upload({ data: new Uint8Array([1]) }),
      ).rejects.toThrow(/CLOUDFLARE_R2_BUCKET_NAME/);
    });

    it("refuses to store an object it could not form a url for", async () => {
      const bucket = makeBucket();
      bindBucket(bucket);
      resolveSecretMock.mockResolvedValue(null);

      await expect(
        cloudflareR2FileUploadProvider.upload({ data: new Uint8Array([1]) }),
      ).rejects.toThrow(/CLOUDFLARE_R2_PUBLIC_BASE_URL/);
      // The refusal comes BEFORE the put: a stored object under a url that
      // resolves to nothing is a dangling upload every caller reads as success.
      expect(bucket.put).not.toHaveBeenCalled();
    });

    it("does not swallow a failed put as a missing store", async () => {
      const bucket = makeBucket();
      bucket.put.mockRejectedValue(new Error("r2 unavailable"));
      bindBucket(bucket);

      await expect(
        cloudflareR2FileUploadProvider.upload({ data: new Uint8Array([1]) }),
      ).rejects.toThrow(/r2 unavailable/);
    });
  });
});
