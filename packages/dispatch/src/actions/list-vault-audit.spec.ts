import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AuditEvent } from "@agent-native/core/audit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Each test runs real migrations against a fresh SQLite file; that setup can
// far exceed the 5s default on a loaded machine.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const ownerEmail = "owner+vault-audit-tab@example.test";
const orgMateEmail = "mate+vault-audit-tab@example.test";
const outsiderEmail = "outsider+vault-audit-tab@example.test";
const orgId = "org_vault_audit_tab";

const originalEnv = {
  APP_NAME: process.env.APP_NAME,
  DATABASE_URL: process.env.DATABASE_URL,
  DATABASE_AUTH_TOKEN: process.env.DATABASE_AUTH_TOKEN,
  DISPATCH_DATABASE_URL: process.env.DISPATCH_DATABASE_URL,
  DISPATCH_DATABASE_AUTH_TOKEN: process.env.DISPATCH_DATABASE_AUTH_TOKEN,
};

let tempDir: string | null = null;
let seq = 0;

function restoreEnv() {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-vault-audit-tab-"));
  process.env.DATABASE_URL = `file:${path.join(tempDir, "app.db")}`;
  delete process.env.APP_NAME;
  delete process.env.DATABASE_AUTH_TOKEN;
  delete process.env.DISPATCH_DATABASE_URL;
  delete process.env.DISPATCH_DATABASE_AUTH_TOKEN;
  vi.resetModules();
  seq = 0;

  const [{ runMigrations }, { dispatchMigrations }] = await Promise.all([
    import("@agent-native/core/db"),
    import("../db/migrations.js"),
  ]);
  await runMigrations(dispatchMigrations, { table: "dispatch_migrations" })({});
  const { ensureAuditTables } = await import("@agent-native/core/audit");
  await ensureAuditTables();
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

async function recordEvent(over: Partial<AuditEvent> = {}) {
  const { insertAuditEvent } = await import("@agent-native/core/audit");
  seq += 1;
  const event: AuditEvent = {
    id: over.id ?? `evt-${seq}`,
    createdAt: over.createdAt ?? 1_000 + seq,
    action: over.action ?? "sync-vault-to-app",
    caller: over.caller ?? "frontend",
    actorKind: over.actorKind ?? "human",
    actorEmail: over.actorEmail ?? ownerEmail,
    orgId: over.orgId === undefined ? orgId : over.orgId,
    threadId: over.threadId ?? null,
    turnId: over.turnId ?? null,
    targetType: over.targetType ?? "vault-secret",
    targetId: over.targetId ?? "secret-1",
    status: over.status ?? "success",
    summary: over.summary ?? null,
    input: over.input ?? null,
    errorCode: over.errorCode ?? null,
    ownerEmail: over.ownerEmail ?? ownerEmail,
    visibility: over.visibility ?? "org",
  };
  await insertAuditEvent(event);
  return event;
}

async function listAs(email: string, args: Record<string, unknown> = {}) {
  const [{ runWithRequestContext }, action] = await Promise.all([
    import("@agent-native/core/server"),
    import("./list-vault-audit.js").then((m) => m.default),
  ]);
  return runWithRequestContext({ userEmail: email, orgId }, () =>
    action.run(args),
  ) as Promise<{
    events: AuditEvent[];
    limit: number;
    offset: number;
    hasMore: boolean;
  }>;
}

describe("list-vault-audit reads the framework action audit log", () => {
  it("returns vault events and ignores other features' events", async () => {
    await recordEvent({ id: "vault", targetType: "vault-grant" });
    await recordEvent({ id: "other", targetType: "recording" });

    const page = await listAs(ownerEmail);

    expect(page.events.map((e) => e.id)).toEqual(["vault"]);
  });

  it("does not read vault_audit_log", async () => {
    const { runWithRequestContext } = await import("@agent-native/core/server");
    const vaultStore = await import("../server/lib/vault-store.js");
    await runWithRequestContext({ userEmail: ownerEmail, orgId }, () =>
      vaultStore.recordVaultAudit({
        action: "vault.secret.created",
        summary: "Legacy vault-log-only row",
      }),
    );

    const page = await listAs(ownerEmail);

    expect(page.events).toEqual([]);
    const { getDbExec } = await import("@agent-native/core/db");
    const legacy = await getDbExec().execute({
      sql: "SELECT id FROM vault_audit_log",
      args: [],
    });
    expect(legacy.rows).toHaveLength(1);
  });

  it("surfaces refused access with its status and error code", async () => {
    await recordEvent({
      id: "denied",
      action: "reveal-vault-secret",
      status: "denied",
      errorCode: "forbidden",
    });

    const [event] = (await listAs(ownerEmail, { status: "denied" })).events;

    expect(event?.action).toBe("reveal-vault-secret");
    expect(event?.status).toBe("denied");
    expect(event?.errorCode).toBe("forbidden");
  });

  it("filters by action, actor, and time", async () => {
    await recordEvent({
      id: "old",
      action: "sync-vault-to-app",
      createdAt: 1_000,
    });
    await recordEvent({
      id: "recent",
      action: "create-vault-grant",
      actorEmail: orgMateEmail,
      ownerEmail: orgMateEmail,
      createdAt: 5_000,
    });

    expect(
      (await listAs(ownerEmail, { action: "create-vault-grant" })).events.map(
        (e) => e.id,
      ),
    ).toEqual(["recent"]);
    expect(
      (await listAs(ownerEmail, { actorEmail: orgMateEmail })).events.map(
        (e) => e.id,
      ),
    ).toEqual(["recent"]);
    expect(
      (await listAs(ownerEmail, { sinceMs: 2_000 })).events.map((e) => e.id),
    ).toEqual(["recent"]);
  });

  it("paginates newest-first and reports whether more remain", async () => {
    await recordEvent({ id: "a", createdAt: 1_000 });
    await recordEvent({ id: "b", createdAt: 2_000 });
    await recordEvent({ id: "c", createdAt: 3_000 });

    const first = await listAs(ownerEmail, { limit: 2 });
    expect(first.events.map((e) => e.id)).toEqual(["c", "b"]);
    expect(first.hasMore).toBe(true);

    const second = await listAs(ownerEmail, { limit: 2, offset: 2 });
    expect(second.events.map((e) => e.id)).toEqual(["a"]);
    expect(second.hasMore).toBe(false);
  });

  it("never returns the recorded input payload in the timeline", async () => {
    await recordEvent({ input: '{"credentialKey":"EXAMPLE_API_KEY"}' });

    const [event] = (await listAs(ownerEmail)).events;

    // The timeline selects `LIST_COLUMNS`, which excludes `input`; the payload
    // is only reachable one event at a time through `get-audit-event`.
    expect(event).toBeDefined();
    expect(event?.input).toBeNull();
  });

  it("lets org members read org-wide vault events but not outsiders", async () => {
    await recordEvent({ id: "org-wide", visibility: "org" });

    expect((await listAs(orgMateEmail)).events.map((e) => e.id)).toEqual([
      "org-wide",
    ]);

    const { runWithRequestContext } = await import("@agent-native/core/server");
    const action = (await import("./list-vault-audit.js")).default;
    const outside = (await runWithRequestContext(
      { userEmail: outsiderEmail, orgId: "org_other" },
      () => action.run({}),
    )) as { events: AuditEvent[] };
    expect(outside.events).toEqual([]);
  });

  it("fails loudly for an unauthenticated caller instead of returning an empty page", async () => {
    const action = (await import("./list-vault-audit.js")).default;

    await expect(action.run({})).rejects.toThrow(/authenticated/i);
  });
});
