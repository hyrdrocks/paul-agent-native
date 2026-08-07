import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  registerFallbackStoragePolicy,
  unregisterFallbackStoragePolicy,
} from "../hosts/fallback-storage.js";
import { builderFileUploadProvider } from "./builder.js";
import {
  FileUploadProviderUnreadableError,
  FileUploadStorageNotConfiguredError,
} from "./errors.js";
import {
  getActiveFileUploadProvider,
  getActiveFileUploadProviderForRequest,
  listFileUploadProviders,
  registerFileUploadProvider,
  unregisterFileUploadProvider,
  uploadFile,
} from "./registry.js";
import type { FileUploadProvider } from "./types.js";

const resolveBuilderPrivateKeyMock = vi.hoisted(() => vi.fn());
const resolveHasBuilderPrivateKeyMock = vi.hoisted(() => vi.fn());

vi.mock("../server/credential-provider.js", () => ({
  resolveBuilderPrivateKey: resolveBuilderPrivateKeyMock,
  resolveHasBuilderPrivateKey: resolveHasBuilderPrivateKeyMock,
}));

function makeProvider(
  id: string,
  configured: boolean,
  upload?: FileUploadProvider["upload"],
): FileUploadProvider {
  return {
    id,
    name: id,
    isConfigured: () => configured,
    upload:
      upload ??
      (async () => ({ url: `https://cdn/${id}`, id: `${id}-1`, provider: id })),
  };
}

describe("file-upload registry", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Drop any providers a prior test (or import side effect) left on the
    // globalThis-pinned map so each case starts clean.
    for (const p of listFileUploadProviders()) {
      unregisterFileUploadProvider(p.id);
    }
    process.env = { ...originalEnv };
    delete process.env.BUILDER_PRIVATE_KEY;
    // The portable baseline policy refuses the fallback on either of these, so
    // clear both: these cases are about the registry, not about the baseline.
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = "test";
    vi.clearAllMocks();
  });

  afterEach(() => {
    for (const p of listFileUploadProviders()) {
      unregisterFileUploadProvider(p.id);
    }
    process.env = { ...originalEnv };
  });

  describe("registration and lookup", () => {
    it("registers, lists, and unregisters providers", () => {
      const p = makeProvider("s3", true);
      registerFileUploadProvider(p);
      expect(listFileUploadProviders()).toContain(p);

      unregisterFileUploadProvider("s3");
      expect(listFileUploadProviders()).not.toContain(p);
    });

    it("is idempotent per id — re-registering the same id replaces it", () => {
      const first = makeProvider("dup", false);
      const second = makeProvider("dup", true);
      registerFileUploadProvider(first);
      registerFileUploadProvider(second);

      const matches = listFileUploadProviders().filter((p) => p.id === "dup");
      expect(matches).toHaveLength(1);
      expect(matches[0]).toBe(second);
    });
  });

  describe("getActiveFileUploadProvider", () => {
    it("returns the first configured user provider", () => {
      registerFileUploadProvider(makeProvider("unconfigured", false));
      const configured = makeProvider("configured", true);
      registerFileUploadProvider(configured);

      expect(getActiveFileUploadProvider()).toBe(configured);
    });

    it("falls back to the builder builtin when its env is set", () => {
      registerFileUploadProvider(makeProvider("unconfigured", false));
      process.env.BUILDER_PRIVATE_KEY = "bpk-123";

      expect(getActiveFileUploadProvider()).toBe(builderFileUploadProvider);
    });

    it("returns null when nothing is configured", () => {
      registerFileUploadProvider(makeProvider("unconfigured", false));
      expect(getActiveFileUploadProvider()).toBeNull();
    });

    it("prefers a configured user provider over the builder builtin", () => {
      process.env.BUILDER_PRIVATE_KEY = "bpk-123";
      const s3 = makeProvider("s3", true);
      registerFileUploadProvider(s3);
      expect(getActiveFileUploadProvider()).toBe(s3);
    });

    it("resolves request-scoped async provider configuration", async () => {
      const s3 = {
        ...makeProvider("s3", false),
        isConfiguredForRequest: vi.fn(async () => true),
      };
      registerFileUploadProvider(s3);

      expect(getActiveFileUploadProvider()).toBeNull();
      await expect(getActiveFileUploadProviderForRequest()).resolves.toBe(s3);
      expect(s3.isConfiguredForRequest).toHaveBeenCalled();
    });

    it("resolves a request-scoped Builder connection", async () => {
      resolveHasBuilderPrivateKeyMock.mockResolvedValue(true);

      await expect(getActiveFileUploadProviderForRequest()).resolves.toBe(
        builderFileUploadProvider,
      );
      expect(resolveHasBuilderPrivateKeyMock).toHaveBeenCalled();
    });
  });

  describe("uploadFile dispatch", () => {
    it("uses a configured user provider directly without resolving builder creds", async () => {
      const upload = vi.fn(async () => ({
        url: "https://cdn/s3/x",
        provider: "s3",
      }));
      registerFileUploadProvider(makeProvider("s3", true, upload));

      const input = { data: new Uint8Array([1, 2, 3]), filename: "x.png" };
      const result = await uploadFile(input);

      expect(result).toEqual({ url: "https://cdn/s3/x", provider: "s3" });
      expect(upload).toHaveBeenCalledWith(input);
      // The builder credential path must not be touched for user providers.
      expect(resolveBuilderPrivateKeyMock).not.toHaveBeenCalled();
    });

    it("uses a request-scoped user provider before resolving builder creds", async () => {
      const upload = vi.fn(async () => ({
        url: "https://cdn/s3/scoped",
        provider: "s3",
      }));
      registerFileUploadProvider({
        ...makeProvider("s3", false, upload),
        isConfiguredForRequest: vi.fn(async () => true),
      });

      const input = { data: new Uint8Array([1]), filename: "x.png" };
      const result = await uploadFile(input);

      expect(result).toEqual({
        url: "https://cdn/s3/scoped",
        provider: "s3",
      });
      expect(upload).toHaveBeenCalledWith(input);
      expect(resolveBuilderPrivateKeyMock).not.toHaveBeenCalled();
    });

    it("resolves builder credentials async and uploads via the builtin", async () => {
      resolveBuilderPrivateKeyMock.mockResolvedValue("bpk-runtime");
      const uploadSpy = vi
        .spyOn(builderFileUploadProvider, "upload")
        .mockResolvedValue({
          url: "https://cdn.builder.io/abc",
          id: "abc",
          provider: "builder",
        });

      const input = { data: new Uint8Array([9]), mimeType: "image/png" };
      const result = await uploadFile(input);

      expect(result).toEqual({
        url: "https://cdn.builder.io/abc",
        id: "abc",
        provider: "builder",
      });
      expect(uploadSpy).toHaveBeenCalledWith(input);
      uploadSpy.mockRestore();
    });

    it("returns null when no creds resolve and this host permits a fallback", async () => {
      resolveBuilderPrivateKeyMock.mockResolvedValue(null);
      const result = await uploadFile({ data: new Uint8Array([1]) });
      expect(result).toBeNull();
    });

    it("throws rather than reporting 'unconfigured' when the credential store is unreadable", async () => {
      // Negative control for the coercion this release removes: a database
      // blip used to return the same null a missing provider does, and every
      // caller answered that null by writing the payload into SQL.
      resolveBuilderPrivateKeyMock.mockRejectedValue(new Error("db down"));

      await expect(uploadFile({ data: new Uint8Array([1]) })).rejects.toThrow(
        FileUploadProviderUnreadableError,
      );
      await expect(uploadFile({ data: new Uint8Array([1]) })).rejects.toThrow(
        /db down/,
      );
    });

    it("throws rather than reporting 'unconfigured' when a scoped provider check is unreadable", async () => {
      resolveBuilderPrivateKeyMock.mockResolvedValue(null);
      resolveHasBuilderPrivateKeyMock.mockResolvedValue(false);
      registerFileUploadProvider({
        ...makeProvider("s3", false),
        isConfiguredForRequest: vi.fn(async () => {
          throw new Error("secrets table missing");
        }),
      });

      await expect(uploadFile({ data: new Uint8Array([1]) })).rejects.toThrow(
        /secrets table missing/,
      );
    });

    it("does NOT swallow a real upload failure as a fallback", async () => {
      // Creds resolve fine, so an upload error must propagate to the caller
      // rather than being treated as a missing-provider null.
      resolveBuilderPrivateKeyMock.mockResolvedValue("bpk-runtime");
      const uploadSpy = vi
        .spyOn(builderFileUploadProvider, "upload")
        .mockRejectedValue(new Error("network blip"));

      await expect(uploadFile({ data: new Uint8Array([1]) })).rejects.toThrow(
        /network blip/,
      );
      uploadSpy.mockRestore();
    });
  });

  describe("host-owned fallback storage policy", () => {
    const refusing = {
      id: "test-host",
      priority: 1,
      decide: () => ({
        permitted: false as const,
        policy: "test-host",
        reason: "This app runs on a host with no store for a file body.",
        setup: "Bind an object store as UPLOADS.",
      }),
    };

    afterEach(() => {
      unregisterFallbackStoragePolicy(refusing.id);
    });

    it("fails closed with setup guidance where the host refuses a fallback", async () => {
      resolveBuilderPrivateKeyMock.mockResolvedValue(null);
      registerFallbackStoragePolicy(refusing);

      const call = uploadFile({ data: new Uint8Array([1]) });
      await expect(call).rejects.toThrow(FileUploadStorageNotConfiguredError);
      await expect(uploadFile({ data: new Uint8Array([1]) })).rejects.toThrow(
        /Bind an object store as UPLOADS/,
      );
    });

    it("negative control: the same call returns null once the host permits it", async () => {
      // Same providers, same credentials, same input — only the host's policy
      // differs. That is what proves the decision moved off the call site.
      resolveBuilderPrivateKeyMock.mockResolvedValue(null);
      await expect(
        uploadFile({ data: new Uint8Array([1]) }),
      ).resolves.toBeNull();
    });

    it("does not consult the policy when a provider is configured", async () => {
      registerFallbackStoragePolicy(refusing);
      registerFileUploadProvider(makeProvider("s3", true));

      await expect(
        uploadFile({ data: new Uint8Array([1]) }),
      ).resolves.toMatchObject({ provider: "s3" });
    });
  });
});
