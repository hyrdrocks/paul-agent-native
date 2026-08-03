import type { AuditCallMeta } from "@agent-native/core/audit";
import { describe, expect, it } from "vitest";

import {
  vaultAuditTarget,
  vaultRequestAuditOrgId,
  vaultResultId,
} from "./vault-audit.js";

function meta(orgId: string | null): AuditCallMeta {
  return {
    status: "success",
    caller: "http",
    userEmail: "owner@example.test",
    orgId,
  };
}

describe("vaultAuditTarget", () => {
  it("stamps org visibility when the caller has an org", () => {
    expect(
      vaultAuditTarget(meta("org_1"), { type: "vault-secret", id: "sec_1" }),
    ).toEqual({ type: "vault-secret", id: "sec_1", visibility: "org" });
  });

  it("stamps private visibility when the caller has no org", () => {
    expect(
      vaultAuditTarget(meta(null), { type: "vault-secret", id: "sec_1" }),
    ).toEqual({ type: "vault-secret", id: "sec_1", visibility: "private" });
  });

  it("never sets ownerEmail", () => {
    const target = vaultAuditTarget(meta("org_1"), { type: "vault-grant" });
    expect(Object.keys(target)).not.toContain("ownerEmail");
  });

  it("passes an explicit orgId through, including null", () => {
    expect(
      vaultAuditTarget(meta("org_reviewer"), {
        type: "vault-request",
        id: "req_1",
        orgId: "org_requester",
      }).orgId,
    ).toBe("org_requester");
    expect(
      vaultAuditTarget(meta("org_reviewer"), {
        type: "vault-request",
        orgId: null,
      }).orgId,
    ).toBeNull();
  });

  it("leaves orgId unset when the caller does not supply one", () => {
    const target = vaultAuditTarget(meta("org_1"), { type: "vault-app" });
    expect(Object.keys(target)).not.toContain("orgId");
  });
});

describe("vaultRequestAuditOrgId", () => {
  it("uses the request row's org", () => {
    expect(vaultRequestAuditOrgId({ orgId: "org_requester" })).toBe(
      "org_requester",
    );
  });

  it("keeps a solo request's null org", () => {
    expect(vaultRequestAuditOrgId({ orgId: null })).toBeNull();
  });

  it("leaves the org unstamped when there is no row to scope to", () => {
    expect(vaultRequestAuditOrgId(undefined)).toBeUndefined();
    expect(vaultRequestAuditOrgId(null)).toBeUndefined();
  });
});

describe("vaultResultId", () => {
  it("reads the id of the row an action returned", () => {
    expect(vaultResultId({ id: "sec_1" })).toBe("sec_1");
  });

  it("returns undefined when the action returned no row", () => {
    expect(vaultResultId(null)).toBeUndefined();
    expect(vaultResultId(undefined)).toBeUndefined();
    expect(vaultResultId({ synced: 2 })).toBeUndefined();
  });
});
