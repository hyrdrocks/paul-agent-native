import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test runs real migrations against a fresh SQLite file; that setup can
// far exceed the 5s default on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ownerEmail = "owner+vault-audit@example.test";
const orgId = "org_vault_audit";
const reviewerEmail = "reviewer+vault-audit@example.test";
const reviewerOrgId = "org_vault_audit_reviewer";

const originalEnv = {
  APP_NAME: process.env.APP_NAME,
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_AUTH_TOKEN: process.env.DATABASE_AUTH_TOKEN,
  DISPATCH_DATABASE_URL: process.env.DISPATCH_DATABASE_URL,
  DISPATCH_DATABASE_AUTH_TOKEN: process.env.DISPATCH_DATABASE_AUTH_TOKEN,
};

let tempDir: string | null = null;

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-vault-audit-"));
  process.env.DATABASE_URL = `file:${path.join(tempDir, "app.db")}`;
  delete process.env.APP_NAME;
  delete process.env.DATABASE_AUTH_TOKEN;
  delete process.env.DISPATCH_DATABASE_URL;
  delete process.env.DISPATCH_DATABASE_AUTH_TOKEN;
  vi.resetModules();

  const [{ runMigrations }, { dispatchMigrations }] = await Promise.all([
    import("@agent-native/core/db"),
    import("../../db/migrations.js"),
  ]);
  await runMigrations(dispatchMigrations, { table: "dispatch_migrations" })({});
});

afterEach(async () => {
  try {
    const { closeDbExec } = await import("@agent-native/core/db");
    await closeDbExec();
  } catch {}
  restoreEnv();
  if (tempDir) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

async function auditRows(action: string) {
  const { getDbExec } = await import("@agent-native/core/db");
  const result = await getDbExec().execute({
    sql: "SELECT action, target_type, target_id, owner_email, org_id, summary FROM dispatch_audit_events WHERE action = ?",
    args: [action],
  });
  return result.rows as unknown as Array<{
    action: string;
    target_type: string;
    target_id: string | null;
    owner_email: string;
    org_id: string | null;
    summary: string;
  }>;
}

describe("vault request events reach the dispatch audit log", () => {
  it("records creation, approval, and denial alongside the vault log", async () => {
    const [{ runWithRequestContext }, vaultStore] = await Promise.all([
      import("@agent-native/core/server"),
      import("./vault-store.js"),
    ]);

    await runWithRequestContext({ userEmail: ownerEmail, orgId }, async () => {
      const approved = await vaultStore.createRequest({
        credentialKey: "EXAMPLE_API_KEY",
        appId: "test-app",
        reason: "needed for tests",
      });
      const denied = await vaultStore.createRequest({
        credentialKey: "OTHER_EXAMPLE_API_KEY",
        appId: "test-app",
      });

      await vaultStore.approveRequest(
        (approved as any).id,
        "placeholder-secret-value",
        "Example Secret",
      );
      await vaultStore.denyRequest((denied as any).id, "not approved");

      const created = await auditRows("vault.request.created");
      expect(created).toHaveLength(2);
      expect(created[0].target_type).toBe("vault-request");
      expect(created[0].org_id).toBe(orgId);

      const approvals = await auditRows("vault.request.approved");
      expect(approvals).toHaveLength(1);
      expect(approvals[0].target_id).toBe((approved as any).id);

      const denials = await auditRows("vault.request.denied");
      expect(denials).toHaveLength(1);
      expect(denials[0].target_id).toBe((denied as any).id);
    });
  });

  it("never writes the secret value into the audit summary", async () => {
    const [{ runWithRequestContext }, vaultStore] = await Promise.all([
      import("@agent-native/core/server"),
      import("./vault-store.js"),
    ]);

    await runWithRequestContext({ userEmail: ownerEmail, orgId }, async () => {
      const created = await vaultStore.createRequest({
        credentialKey: "EXAMPLE_API_KEY",
        appId: "test-app",
      });
      await vaultStore.approveRequest(
        (created as any).id,
        "placeholder-secret-value",
        "Example Secret",
      );

      const { getDbExec } = await import("@agent-native/core/db");
      const all = await getDbExec().execute({
        sql: "SELECT summary, metadata FROM dispatch_audit_events",
        args: [],
      });
      for (const row of all.rows as any[]) {
        expect(String(row.summary)).not.toContain("placeholder-secret-value");
        expect(String(row.metadata ?? "")).not.toContain(
          "placeholder-secret-value",
        );
      }
    });
  });

  it("stamps a cross-org approval with the requester's org, not the reviewer's", async () => {
    const [{ runWithRequestContext }, vaultStore] = await Promise.all([
      import("@agent-native/core/server"),
      import("./vault-store.js"),
    ]);

    const requestId = await runWithRequestContext(
      { userEmail: ownerEmail, orgId },
      async () => {
        const created = await vaultStore.createRequest({
          credentialKey: "CROSS_ORG_EXAMPLE_KEY",
          appId: "test-app",
        });
        return (created as any).id as string;
      },
    );

    await runWithRequestContext(
      { userEmail: reviewerEmail, orgId: reviewerOrgId },
      async () => {
        await vaultStore.approveRequest(
          requestId,
          "placeholder-secret-value",
          "Cross Org Secret",
          { ownerEmail: reviewerEmail, orgId },
        );
      },
    );

    const approvals = await auditRows("vault.request.approved");
    expect(approvals).toHaveLength(1);
    // The reviewer's active org is reviewerOrgId; the row must carry the
    // request's owner and org, not the reviewer's.
    expect(approvals[0].org_id).toBe(orgId);
    expect(approvals[0].owner_email).toBe(ownerEmail);

    // The criterion that matters: the requester can actually read it back.
    const dispatchStore = await import("./dispatch-store.js");
    const visible = await runWithRequestContext(
      { userEmail: ownerEmail, orgId },
      async () => dispatchStore.listAuditEvents(),
    );
    expect(
      (visible as Array<{ action: string }>).map((row) => row.action),
    ).toContain("vault.request.approved");
  });
});
