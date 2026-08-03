import type { AuditCallMeta } from "@agent-native/core/audit";
import { describe, expect, it } from "vitest";

import approveVaultRequest from "./approve-vault-request.js";
import createVaultGrant from "./create-vault-grant.js";
import createVaultSecret from "./create-vault-secret.js";
import deleteVaultSecret from "./delete-vault-secret.js";
import denyVaultRequest from "./deny-vault-request.js";
import grantVaultSecretsToApp from "./grant-vault-secrets-to-app.js";
import requestVaultSecret from "./request-vault-secret.js";
import revokeVaultGrant from "./revoke-vault-grant.js";
import setVaultAccessSettings from "./set-vault-access-settings.js";
import syncVaultToApp from "./sync-vault-to-app.js";
import updateVaultSecret from "./update-vault-secret.js";

function meta(orgId: string | null): AuditCallMeta {
  return {
    status: "success",
    caller: "http",
    userEmail: "a@example.test",
    orgId,
  };
}

const VAULT_ACTIONS = {
  "approve-vault-request": approveVaultRequest,
  "create-vault-grant": createVaultGrant,
  "create-vault-secret": createVaultSecret,
  "delete-vault-secret": deleteVaultSecret,
  "deny-vault-request": denyVaultRequest,
  "grant-vault-secrets-to-app": grantVaultSecretsToApp,
  "request-vault-secret": requestVaultSecret,
  "revoke-vault-grant": revokeVaultGrant,
  "set-vault-access-settings": setVaultAccessSettings,
  "sync-vault-to-app": syncVaultToApp,
  "update-vault-secret": updateVaultSecret,
} as const;

describe("vault action audit targets", () => {
  for (const [name, action] of Object.entries(VAULT_ACTIONS)) {
    it(`${name} stamps visibility from the caller's org and never an ownerEmail`, () => {
      const target = action.audit?.target;
      expect(target, `${name} must declare audit.target`).toBeTypeOf(
        "function",
      );

      const inOrg = target!(
        { id: "x", grantId: "x", appId: "app" },
        null,
        meta("org_1"),
      );
      expect(inOrg?.visibility).toBe("org");
      expect(Object.keys(inOrg ?? {})).not.toContain("ownerEmail");

      const solo = target!(
        { id: "x", grantId: "x", appId: "app" },
        null,
        meta(null),
      );
      expect(solo?.visibility).toBe("private");
    });
  }

  it("scopes a cross-org approval to the requester's org, not the reviewer's", () => {
    const target = approveVaultRequest.audit!.target!(
      { id: "req_1", secretValue: "placeholder-value" },
      { id: "req_1", orgId: "org_requester" },
      meta("org_reviewer"),
    );
    expect(target?.orgId).toBe("org_requester");
    expect(target?.visibility).toBe("org");
  });

  it("scopes a cross-org denial to the requester's org, not the reviewer's", () => {
    const target = denyVaultRequest.audit!.target!(
      { id: "req_1" },
      { id: "req_1", orgId: "org_requester" },
      meta("org_reviewer"),
    );
    expect(target?.orgId).toBe("org_requester");
  });

  it("scopes a created request to the org it was filed in", () => {
    const target = requestVaultSecret.audit!.target!(
      { credentialKey: "EXAMPLE_API_KEY", appId: "app" },
      { id: "req_2", orgId: "org_requester" },
      meta("org_requester"),
    );
    expect(target?.orgId).toBe("org_requester");
    expect(target?.id).toBe("req_2");
  });

  it("keeps recording inputs off for the two actions that carry a secret value", () => {
    expect(createVaultSecret.audit?.recordInputs).toBe(false);
    expect(updateVaultSecret.audit?.recordInputs).toBe(false);
  });
});
