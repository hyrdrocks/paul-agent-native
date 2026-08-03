import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSecretsByKeys: vi.fn(),
  listSecrets: vi.fn(),
  requireVaultCtx: vi.fn(),
}));

// `normalizeCredentialKey` is the real one on purpose: the action and the
// store must agree on it, so stubbing it here would hide exactly the drift the
// shared export exists to prevent.
vi.mock("../server/lib/vault-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/lib/vault-store.js")>()),
  getSecretsByKeys: mocks.getSecretsByKeys,
  listSecrets: mocks.listSecrets,
  requireVaultCtx: mocks.requireVaultCtx,
}));

const leaseVaultSecrets = (await import("./lease-vault-secrets.js")).default;

/** A vault row as `getSecretsByKeys` returns it. Values here are obviously
 * fake and exist only so the redaction assertions have something to search
 * for. */
function row(credentialKey: string, value: string, id = credentialKey) {
  return { id, credentialKey, value, name: credentialKey };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireVaultCtx.mockReturnValue({
    ownerEmail: "admin@example.test",
    orgId: "org_123",
  });
});

describe("lease-vault-secrets mounting", () => {
  it("is reachable over HTTP POST but never as an agent or tool-iframe tool", () => {
    expect(leaseVaultSecrets.http).toEqual({ method: "POST" });
    expect(leaseVaultSecrets.agentTool).toBe(false);
    expect(leaseVaultSecrets.toolCallable).toBe(false);
  });

  it("records the requested key names as audited inputs", () => {
    expect(leaseVaultSecrets.audit?.enabled).toBe(true);
    expect(leaseVaultSecrets.audit?.recordInputs).toBe(true);
  });

  it("accepts only an explicit key list and a caller-minted lease id", () => {
    const properties = leaseVaultSecrets.tool.parameters?.properties ?? {};
    expect(Object.keys(properties).sort()).toEqual(["keys", "leaseId"]);
  });
});

describe("lease-vault-secrets resolution", () => {
  it("returns every requested value under `env` and echoes the input lease id", async () => {
    mocks.getSecretsByKeys.mockResolvedValue([
      row("ALPHA_API_KEY", "alpha-placeholder-value"),
      row("BETA_API_KEY", "beta-placeholder-value"),
    ]);

    await expect(
      leaseVaultSecrets.run({
        keys: ["ALPHA_API_KEY", "BETA_API_KEY"],
        leaseId: "lease_abc",
      }),
    ).resolves.toEqual({
      leaseId: "lease_abc",
      env: {
        ALPHA_API_KEY: "alpha-placeholder-value",
        BETA_API_KEY: "beta-placeholder-value",
      },
    });
  });

  it("resolves through getSecretsByKeys, never the bulk listSecrets path", async () => {
    mocks.getSecretsByKeys.mockResolvedValue([row("ALPHA_API_KEY", "a")]);

    await leaseVaultSecrets.run({
      keys: ["ALPHA_API_KEY"],
      leaseId: "lease_abc",
    });

    expect(mocks.getSecretsByKeys).toHaveBeenCalledWith(["ALPHA_API_KEY"], {
      ownerEmail: "admin@example.test",
      orgId: "org_123",
    });
    expect(mocks.listSecrets).not.toHaveBeenCalled();
  });
});

describe("lease-vault-secrets refusal", () => {
  it("names the single missing key and returns no env", async () => {
    mocks.getSecretsByKeys.mockResolvedValue([
      row("ALPHA_API_KEY", "alpha-placeholder-value"),
    ]);

    const error = await leaseVaultSecrets
      .run({ keys: ["ALPHA_API_KEY", "GONE_API_KEY"], leaseId: "lease_abc" })
      .catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("GONE_API_KEY");
    // The refusal is all-or-nothing: the key that DID resolve must not reach
    // the caller through the error, in the message or on the error object.
    expect(error.message).not.toContain("alpha-placeholder-value");
    expect(
      JSON.stringify(error, Object.getOwnPropertyNames(error)),
    ).not.toContain("alpha-placeholder-value");
  });

  it("names every missing key in one message", async () => {
    mocks.getSecretsByKeys.mockResolvedValue([]);

    const error = await leaseVaultSecrets
      .run({
        keys: ["ONE_API_KEY", "TWO_API_KEY", "THREE_API_KEY"],
        leaseId: "lease_abc",
      })
      .catch((err: unknown) => err as Error);

    // Without an explicit client statusCode the action route classifies the
    // refusal as an uncategorized 500 and replaces this message with
    // "Internal server error", so the named keys never reach the caller.
    expect((error as { statusCode?: number }).statusCode).toBe(400);
    expect(error.message).toContain("ONE_API_KEY");
    expect(error.message).toContain("TWO_API_KEY");
    expect(error.message).toContain("THREE_API_KEY");
    expect(mocks.getSecretsByKeys).toHaveBeenCalledTimes(1);
  });

  it("refuses an ambiguous credential key instead of picking a row", async () => {
    mocks.getSecretsByKeys.mockResolvedValue([
      row("SHARED_API_KEY", "first-placeholder-value", "secret_1"),
      row("SHARED_API_KEY", "second-placeholder-value", "secret_2"),
    ]);

    const error = await leaseVaultSecrets
      .run({ keys: ["SHARED_API_KEY"], leaseId: "lease_abc" })
      .catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("SHARED_API_KEY");
    expect(error.message).toMatch(/ambiguous/i);
    expect(error.message).not.toContain("first-placeholder-value");
    expect(error.message).not.toContain("second-placeholder-value");
  });

  it("reports missing and ambiguous keys together in one refusal", async () => {
    mocks.getSecretsByKeys.mockResolvedValue([
      row("SHARED_API_KEY", "x", "secret_1"),
      row("SHARED_API_KEY", "y", "secret_2"),
    ]);

    const error = await leaseVaultSecrets
      .run({ keys: ["SHARED_API_KEY", "GONE_API_KEY"], leaseId: "lease_abc" })
      .catch((err: unknown) => err as Error);

    expect(error.message).toContain("SHARED_API_KEY");
    expect(error.message).toContain("GONE_API_KEY");
  });

  it("refuses a stored key whose value is empty rather than leasing a blank", async () => {
    mocks.getSecretsByKeys.mockResolvedValue([row("BLANK_API_KEY", "")]);

    const error = await leaseVaultSecrets
      .run({ keys: ["BLANK_API_KEY"], leaseId: "lease_abc" })
      .catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("BLANK_API_KEY");
  });

  it("treats a wildcard as an ordinary missing key name", async () => {
    mocks.getSecretsByKeys.mockResolvedValue([]);

    const error = await leaseVaultSecrets
      .run({ keys: ["*"], leaseId: "lease_abc" })
      .catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect(mocks.getSecretsByKeys).toHaveBeenCalledWith(
      ["*"],
      expect.anything(),
    );
  });
});

describe("lease-vault-secrets input validation", () => {
  it("rejects an empty key list", async () => {
    await expect(
      leaseVaultSecrets.run({ keys: [], leaseId: "lease_abc" }),
    ).rejects.toThrow();
    expect(mocks.getSecretsByKeys).not.toHaveBeenCalled();
  });

  it("rejects more than 50 keys", async () => {
    const keys = Array.from({ length: 51 }, (_, i) => `KEY_${i}`);

    await expect(
      leaseVaultSecrets.run({ keys, leaseId: "lease_abc" }),
    ).rejects.toThrow();
    expect(mocks.getSecretsByKeys).not.toHaveBeenCalled();
  });

  it("accepts exactly 50 keys", async () => {
    const keys = Array.from({ length: 50 }, (_, i) => `KEY_${i}`);
    mocks.getSecretsByKeys.mockResolvedValue(
      keys.map((key) => row(key, `${key}-placeholder-value`)),
    );

    const result = await leaseVaultSecrets.run({ keys, leaseId: "lease_abc" });

    expect(Object.keys(result.env)).toHaveLength(50);
  });

  it("rejects a blank lease id", async () => {
    await expect(
      leaseVaultSecrets.run({ keys: ["ALPHA_API_KEY"], leaseId: "   " }),
    ).rejects.toThrow();
  });
});

describe("lease-vault-secrets audit metadata", () => {
  // High-entropy fake so a 4-character sliding window cannot collide with
  // ordinary English in the summary line.
  const secretValue = "Zx9Qv7Fk2MpLbT4RnW8Hs3Jd";
  const result = {
    leaseId: "lease_abc",
    env: { ALPHA_API_KEY: secretValue },
  };
  const args = { keys: ["ALPHA_API_KEY"], leaseId: "lease_abc" };

  it("stamps org visibility and org id when the lease runs inside an org", () => {
    expect(
      leaseVaultSecrets.audit?.target?.(args, result, {
        status: "success",
        caller: "http",
        orgId: "org_123",
      }),
    ).toEqual({
      type: "vault-lease",
      id: "lease_abc",
      orgId: "org_123",
      visibility: "org",
    });
  });

  it("stamps private visibility when the caller has no org", () => {
    expect(
      leaseVaultSecrets.audit?.target?.(args, result, {
        status: "success",
        caller: "cli",
        orgId: null,
      }),
    ).toEqual({
      type: "vault-lease",
      id: "lease_abc",
      orgId: null,
      visibility: "private",
    });
  });

  it("never leaks a leased value through summary or target", () => {
    const summary = leaseVaultSecrets.audit?.summary?.(args, result, {
      status: "success",
      caller: "http",
      orgId: "org_123",
    });
    const target = JSON.stringify(
      leaseVaultSecrets.audit?.target?.(args, result, {
        status: "success",
        caller: "http",
        orgId: "org_123",
      }),
    );

    for (let start = 0; start + 4 <= secretValue.length; start++) {
      const fragment = secretValue.slice(start, start + 4);
      expect(summary).not.toContain(fragment);
      expect(target).not.toContain(fragment);
    }
    expect(summary).toContain("ALPHA_API_KEY");
  });

  it("builds the same summary whether or not a result exists", () => {
    const meta = { status: "success" as const, caller: "http", orgId: null };

    expect(leaseVaultSecrets.audit?.summary?.(args, result, meta)).toBe(
      leaseVaultSecrets.audit?.summary?.(args, undefined, meta),
    );
  });
});
