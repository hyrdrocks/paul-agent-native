import type { AuditCallMeta, AuditTarget } from "@agent-native/core/audit";

/** The resource kinds a vault audit event can point at. */
export type VaultAuditTargetType =
  | "vault-app"
  | "vault-grant"
  | "vault-request"
  | "vault-secret"
  | "vault-settings";

/**
 * Ownership stamp shared by every vault audit event in the framework log —
 * reads and mutations alike, with no distinction between them.
 *
 * `visibility` is never left to default. It defaults to `"private"`, and the
 * escalation to `"org"` in `recordActionAudit` is gated on
 * `getIntegrationRequestContext()`, which a CLI or HTTP vault call never has —
 * so an unstamped vault event is invisible to the rest of the org that can
 * already read the vault row it describes.
 *
 * `ownerEmail` is deliberately never set: `scopeClause` matches
 * `(visibility = 'org' AND org_id = ?)` as a standalone disjunct, so
 * `owner_email` is not consulted on that branch and setting it would be inert
 * code that reads as load-bearing.
 */
export function vaultAuditTarget(
  meta: AuditCallMeta,
  target: {
    type: VaultAuditTargetType;
    id?: string | null;
    orgId?: string | null;
  },
): AuditTarget {
  return {
    type: target.type,
    ...(target.id ? { id: target.id } : {}),
    ...(target.orgId !== undefined ? { orgId: target.orgId } : {}),
    visibility: meta.orgId ? "org" : "private",
  };
}

/** The id of the row an action just wrote, when it returned one. */
export function vaultResultId(result: unknown): string | undefined {
  const id = (result as { id?: unknown } | null | undefined)?.id;
  return typeof id === "string" ? id : undefined;
}

/**
 * The org a vault *request* audit event belongs to: the request row's own org,
 * not the reviewer's active one. A cross-org reviewer approving a request would
 * otherwise strand the row in the reviewer's org, where the requester can never
 * read it.
 *
 * Returns `undefined` when there is no row to read — an errored or no-op call.
 * That leaves `orgId` unstamped rather than guessing the reviewer's org, which
 * would be indistinguishable from a genuine same-org approval.
 */
export function vaultRequestAuditOrgId(
  result: unknown,
): string | null | undefined {
  const orgId = (result as { orgId?: unknown } | null | undefined)?.orgId;
  if (typeof orgId === "string") return orgId;
  if (orgId === null) return null;
  return undefined;
}
