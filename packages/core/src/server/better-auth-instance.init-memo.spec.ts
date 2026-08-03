/**
 * The Better Auth init memo must not survive its own failure.
 *
 * `getBetterAuth()` caches the in-flight init promise so concurrent callers
 * share one instance. When that promise REJECTED the memo stayed, so every
 * later call in the process re-awaited the same failure: one transient
 * cold-start database error locked auth out for the whole isolate's lifetime,
 * which on Cloudflare Workers is every request that instance ever serves.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getDialect: vi.fn() }));

vi.mock("../db/client.js", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getDialect: mocks.getDialect,
}));

import { getBetterAuth, resetBetterAuth } from "./better-auth-instance.js";

describe("getBetterAuth init memo", () => {
  afterEach(async () => {
    await resetBetterAuth();
    vi.clearAllMocks();
  });

  it("retries after a failed init instead of replaying the rejection", async () => {
    mocks.getDialect
      .mockImplementationOnce(() => {
        throw new Error("db unreachable (cold start)");
      })
      .mockImplementationOnce(() => {
        throw new Error("db still unreachable");
      });

    await expect(getBetterAuth()).rejects.toThrow(
      "db unreachable (cold start)",
    );
    // A replayed memo would surface the FIRST error again and never re-enter
    // instance creation.
    await expect(getBetterAuth()).rejects.toThrow("db still unreachable");
    expect(mocks.getDialect).toHaveBeenCalledTimes(2);
  });
});
