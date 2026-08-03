import { filterAgentTools } from "@agent-native/core/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  getSecret: vi.fn(),
  listSecrets: vi.fn(),
  requireVaultCtx: vi.fn(),
}));

vi.mock("../server/lib/vault-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../server/lib/vault-store.js")>()),
  getSecret: mocks.getSecret,
  listSecrets: mocks.listSecrets,
  requireVaultCtx: mocks.requireVaultCtx,
}));

const revealVaultSecret = (await import("./reveal-vault-secret.js")).default;
const { dispatchActions } = await import("./index.js");

/** A vault row as `getSecret` returns it. The value is obviously fake and
 * exists only so the redaction assertions have something to search for. */
function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "secret_1",
    credentialKey: "ALPHA_API_KEY",
    name: "Alpha",
    value: "alpha-placeholder-value",
    provider: null,
    description: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.requireVaultCtx.mockReturnValue({
    ownerEmail: "admin@example.test",
    orgId: "org_123",
  });
});

describe("reveal-vault-secret mounting", () => {
  it("is reachable over HTTP POST but never as an agent or tool-iframe tool", () => {
    expect(revealVaultSecret.http).toEqual({ method: "POST" });
    expect(revealVaultSecret.agentTool).toBe(false);
    expect(revealVaultSecret.toolCallable).toBe(false);
  });

  it("is absent from the agent tool list the chat plugin builds", () => {
    const agentTools = Object.keys(filterAgentTools(dispatchActions));
    expect(agentTools).not.toContain("reveal-vault-secret");
    // The bulk list stays: it is the value-free surface that replaces it.
    expect(agentTools).toContain("list-vault-secrets");
  });

  it("takes a single secret id and nothing else", () => {
    const properties = revealVaultSecret.tool.parameters?.properties ?? {};
    expect(Object.keys(properties)).toEqual(["id"]);
  });

  it("audits every call, recording the id it revealed", () => {
    // `enabled` rather than `onRead`: this is a read, and `readOnly` must not
    // be able to turn the record off.
    expect(revealVaultSecret.readOnly).toBe(true);
    expect(revealVaultSecret.audit?.enabled).toBe(true);
    expect(revealVaultSecret.audit?.recordInputs).toBe(true);
  });
});

describe("reveal-vault-secret audit metadata", () => {
  const meta = {
    status: "success" as const,
    caller: "frontend",
    userEmail: "admin@example.test",
    orgId: "org_123",
  };

  it("stamps a vault-secret target visible to the org that owns the row", () => {
    const target = revealVaultSecret.audit?.target?.(
      { id: "secret_1" },
      row(),
      meta,
    );
    expect(target).toMatchObject({
      type: "vault-secret",
      id: "secret_1",
      visibility: "org",
    });
  });

  it("still attributes a refused reveal, which has no result to read", () => {
    // The refusal path is the one #15's Vault Audit tab needs: `run` throws
    // before there is a row, so a target that consulted `result` would leave
    // the denied read unattributed.
    const target = revealVaultSecret.audit?.target?.(
      { id: "secret_missing" },
      undefined,
      { ...meta, status: "error" },
    );
    expect(target).toMatchObject({
      type: "vault-secret",
      id: "secret_missing",
      visibility: "org",
    });
  });

  it("never lets the revealed value reach the target or the summary", () => {
    const result = row();
    const target = revealVaultSecret.audit?.target?.(
      { id: "secret_1" },
      result,
      meta,
    );
    const summary = revealVaultSecret.audit?.summary?.(
      { id: "secret_1" },
      result,
      meta,
    );
    expect(JSON.stringify(target)).not.toContain("alpha-placeholder-value");
    expect(summary).not.toContain("alpha-placeholder-value");
  });
});

describe("reveal-vault-secret resolution", () => {
  it("returns the one requested value, scoped to the caller's vault ctx", async () => {
    mocks.getSecret.mockResolvedValue(row());

    await expect(revealVaultSecret.run({ id: "secret_1" })).resolves.toEqual({
      id: "secret_1",
      credentialKey: "ALPHA_API_KEY",
      name: "Alpha",
      value: "alpha-placeholder-value",
    });
    expect(mocks.getSecret).toHaveBeenCalledWith("secret_1", {
      ownerEmail: "admin@example.test",
      orgId: "org_123",
    });
    expect(mocks.listSecrets).not.toHaveBeenCalled();
  });

  it("refuses an id the caller cannot see rather than returning an empty value", async () => {
    mocks.getSecret.mockResolvedValue(null);

    const error = await revealVaultSecret
      .run({ id: "secret_missing" })
      .catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("secret_missing");
  });

  it("refuses a row stored without a value instead of revealing a blank", async () => {
    mocks.getSecret.mockResolvedValue(row({ value: "" }));

    const error = await revealVaultSecret
      .run({ id: "secret_1" })
      .catch((err: unknown) => err as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toMatch(/no stored value/i);
  });
});

describe("reveal-vault-secret input validation", () => {
  it("rejects an empty id", async () => {
    await expect(revealVaultSecret.run({ id: "" })).rejects.toThrow();
    expect(mocks.getSecret).not.toHaveBeenCalled();
  });

  it("rejects a bulk request shaped as a list of ids", async () => {
    await expect(
      revealVaultSecret.run({ ids: ["secret_1", "secret_2"] } as never),
    ).rejects.toThrow();
    expect(mocks.getSecret).not.toHaveBeenCalled();
  });
});
