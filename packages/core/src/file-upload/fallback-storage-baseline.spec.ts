import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listFallbackStoragePolicies,
  resolveFallbackStorageDecision,
  unregisterFallbackStoragePolicy,
} from "../hosts/fallback-storage.js";
import { registerPortableFallbackStoragePolicy } from "./fallback-storage-baseline.js";

describe("portable fallback storage baseline", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    for (const policy of listFallbackStoragePolicies()) {
      unregisterFallbackStoragePolicy(policy.id);
    }
    process.env = { ...originalEnv };
    delete process.env.DATABASE_URL;
    process.env.NODE_ENV = "test";
    registerPortableFallbackStoragePolicy();
  });

  afterEach(() => {
    for (const policy of listFallbackStoragePolicies()) {
      unregisterFallbackStoragePolicy(policy.id);
    }
    process.env = { ...originalEnv };
  });

  it("permits a local run against a local database", () => {
    expect(resolveFallbackStorageDecision()).toEqual({ permitted: true });
  });

  it("refuses against a persistent database", () => {
    process.env.DATABASE_URL = "postgres://example/app";

    const decision = resolveFallbackStorageDecision();
    expect(decision.permitted).toBe(false);
    if (decision.permitted) throw new Error("unreachable");
    expect(decision.reason).toContain("DATABASE_URL");
    expect(decision.setup).toContain("registerFileUploadProvider");
  });

  it("refuses in production even with a local database", () => {
    process.env.NODE_ENV = "production";

    expect(resolveFallbackStorageDecision().permitted).toBe(false);
  });

  it("is consulted after a host that claims the process", () => {
    // The baseline must never be the reason a Worker's refusal names
    // DATABASE_URL instead of the bucket it actually needs.
    process.env.DATABASE_URL = "postgres://example/app";
    const policies = listFallbackStoragePolicies();
    expect(policies.at(-1)?.id).toBe("portable");
  });
});
