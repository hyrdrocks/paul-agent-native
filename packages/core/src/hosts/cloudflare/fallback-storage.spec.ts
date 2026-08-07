import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Imported through the public package surface on purpose. This host's policy
// used to be pulled in by a side-effect-only `import "../hosts/index.js"`, and
// this package's `sideEffects` allow-list does not name that module — so a
// bundler dropped it, and the deployed Worker resolved as though no host
// claimed the process. Nothing failed; a payload just went to the wrong store.
// Reaching the policy from here is what pins that it cannot be dropped again.
import {
  FileUploadStorageNotConfiguredError,
  uploadFile,
} from "../../file-upload/index.js";
import { resolveFallbackStorageDecision } from "../fallback-storage.js";

const resolveBuilderPrivateKeyMock = vi.hoisted(() => vi.fn());
const resolveHasBuilderPrivateKeyMock = vi.hoisted(() => vi.fn());
const resolveSecretMock = vi.hoisted(() => vi.fn());

vi.mock("../../server/credential-provider.js", () => ({
  resolveBuilderPrivateKey: resolveBuilderPrivateKeyMock,
  resolveHasBuilderPrivateKey: resolveHasBuilderPrivateKeyMock,
  resolveSecret: resolveSecretMock,
}));

const scope = globalThis as { __cf_env?: Record<string, unknown> };

describe("Cloudflare fallback storage", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete scope.__cf_env;
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
    delete process.env.BUILDER_PRIVATE_KEY;
    process.env.NODE_ENV = "test";
    vi.clearAllMocks();
    resolveBuilderPrivateKeyMock.mockResolvedValue(null);
    resolveHasBuilderPrivateKeyMock.mockResolvedValue(false);
    resolveSecretMock.mockResolvedValue("https://pub-test.r2.dev");
  });

  afterEach(() => {
    delete scope.__cf_env;
    process.env = { ...originalEnv };
  });

  it("refuses the fallback on this host, naming the bucket to bind", () => {
    scope.__cf_env = {};

    const decision = resolveFallbackStorageDecision();
    expect(decision.permitted).toBe(false);
    if (decision.permitted) throw new Error("unreachable");
    expect(decision.policy).toBe("cloudflare");
    expect(decision.setup).toContain("UPLOADS");
    expect(decision.setup).toContain("CLOUDFLARE_R2_BUCKET_NAME");
  });

  it("fails an upload closed with setup guidance when no bucket is bound", async () => {
    scope.__cf_env = {};

    // This is the behaviour R4 exists to produce. Before it, the same call
    // returned null and every caller answered that by writing the file body
    // into D1.
    await expect(uploadFile({ data: new Uint8Array([1]) })).rejects.toThrow(
      FileUploadStorageNotConfiguredError,
    );
    await expect(uploadFile({ data: new Uint8Array([1]) })).rejects.toThrow(
      /CLOUDFLARE_R2_BUCKET_NAME/,
    );
  });

  it("stores through the bound bucket, and the record holds the url not the body", async () => {
    const put = vi.fn(async () => {});
    scope.__cf_env = { UPLOADS: { put } };

    const result = await uploadFile({
      data: new Uint8Array([1, 2, 3]),
      filename: "a.png",
      mimeType: "image/png",
    });

    expect(put).toHaveBeenCalledTimes(1);
    expect(result?.provider).toBe("cloudflare-r2");
    expect(result?.url).toMatch(/^https:\/\/pub-test\.r2\.dev\/uploads\//);
    // What a caller persists is a url, and it is nowhere near the size of a
    // payload — the point of the whole rung.
    expect(result?.url).not.toContain("base64");
  });

  it("negative control: off this host the same call still permits a fallback", () => {
    expect(resolveFallbackStorageDecision()).toEqual({ permitted: true });
  });
});
