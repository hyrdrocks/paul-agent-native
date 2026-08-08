import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  listFallbackStoragePolicies,
  registerFallbackStoragePolicy,
  resolveFallbackStorageDecision,
  unregisterFallbackStoragePolicy,
  type FallbackStorageDecision,
} from "./fallback-storage.js";

function clearPolicies(): void {
  for (const policy of listFallbackStoragePolicies()) {
    unregisterFallbackStoragePolicy(policy.id);
  }
}

function policy(
  id: string,
  priority: number,
  decision: FallbackStorageDecision | null,
) {
  return { id, priority, decide: () => decision };
}

describe("fallback storage policy registry", () => {
  beforeEach(clearPolicies);
  afterEach(clearPolicies);

  it("permits when no policy claims the process", () => {
    expect(resolveFallbackStorageDecision()).toEqual({ permitted: true });
  });

  it("skips a policy that does not claim the process", () => {
    registerFallbackStoragePolicy(policy("absent", 10, null));
    registerFallbackStoragePolicy(
      policy("claims", 20, {
        permitted: false,
        policy: "claims",
        reason: "hosted",
        setup: "bind a bucket",
      }),
    );

    expect(resolveFallbackStorageDecision()).toMatchObject({
      permitted: false,
      policy: "claims",
    });
  });

  it("asks in declared priority order, not registration order", () => {
    registerFallbackStoragePolicy(
      policy("late", 50, {
        permitted: false,
        policy: "late",
        reason: "late",
        setup: "late",
      }),
    );
    registerFallbackStoragePolicy(policy("early", 5, { permitted: true }));

    expect(resolveFallbackStorageDecision()).toEqual({ permitted: true });
  });

  it("is idempotent per id — re-registering the same id replaces it", () => {
    registerFallbackStoragePolicy(policy("dup", 10, { permitted: true }));
    registerFallbackStoragePolicy(
      policy("dup", 10, {
        permitted: false,
        policy: "dup",
        reason: "r",
        setup: "s",
      }),
    );

    expect(
      listFallbackStoragePolicies().filter((p) => p.id === "dup"),
    ).toHaveLength(1);
    expect(resolveFallbackStorageDecision().permitted).toBe(false);
  });

  it("carries setup guidance on a refusal, so a caller can say what to do", () => {
    registerFallbackStoragePolicy(
      policy("host", 10, {
        permitted: false,
        policy: "host",
        reason: "This app runs on a host with no local disk.",
        setup: "Bind an object store.",
      }),
    );

    const decision = resolveFallbackStorageDecision();
    expect(decision.permitted).toBe(false);
    if (decision.permitted) throw new Error("unreachable");
    expect(decision.setup).toBe("Bind an object store.");
    expect(decision.reason).toContain("no local disk");
  });
});
