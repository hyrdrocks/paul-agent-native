import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listSecrets: vi.fn(),
}));

vi.mock("../server/lib/vault-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/lib/vault-store.js")>()),
  listSecrets: mocks.listSecrets,
}));

const listVaultSecrets = (await import("./list-vault-secrets.js")).default;

/** A vault row as `listSecrets` returns it. Values here are obviously fake and
 * exist only so the redaction assertions have something to search for. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "secret_1",
    credentialKey: "ALPHA_API_KEY",
    name: "Alpha",
    value: "alpha-placeholder-9zk4",
    provider: null,
    description: null,
    createdBy: "admin@example.test",
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("list-vault-secrets", () => {
  it("returns no `value` field on any row", async () => {
    mocks.listSecrets.mockResolvedValue([
      row(),
      row({ id: "secret_2", credentialKey: "BETA_API_KEY", value: "" }),
    ]);

    const secrets = await listVaultSecrets.run({});

    for (const secret of secrets) {
      expect(secret).not.toHaveProperty("value");
    }
    expect(JSON.stringify(secrets)).not.toContain("alpha-placeholder-9zk4");
  });

  it("carries a masked last4 computed on the server", async () => {
    mocks.listSecrets.mockResolvedValue([row()]);

    const [secret] = await listVaultSecrets.run({});

    expect(secret.last4).toBe("••••9zk4");
    expect(secret).toMatchObject({
      id: "secret_1",
      credentialKey: "ALPHA_API_KEY",
      name: "Alpha",
    });
  });

  it("distinguishes a row stored without a value from a short one", async () => {
    mocks.listSecrets.mockResolvedValue([
      row({ id: "secret_empty", value: "" }),
      row({ id: "secret_short", value: "abc" }),
    ]);

    const [empty, short] = await listVaultSecrets.run({});

    // Absent and unreadable are different answers: "" means there is nothing
    // stored, the mask means there is a value too short to preview.
    expect(empty.last4).toBe("");
    expect(short.last4).toBe("••••");
  });
});
