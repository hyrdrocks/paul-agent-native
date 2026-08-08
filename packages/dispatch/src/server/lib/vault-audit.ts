import type {
  AuditCallMeta,
  AuditEvent,
  AuditStatus,
  AuditTarget,
} from "@agent-native/core/audit";
import { queryAuditEvents } from "@agent-native/core/audit";

import { requireVaultCtx } from "./vault-store.js";

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

/**
 * Every target type the vault stamps. Spelled as a full record so adding a
 * `VaultAuditTargetType` without listing it here fails to compile — an
 * unlisted type would silently drop those events out of the vault timeline.
 */
export const VAULT_AUDIT_TARGET_TYPES = Object.keys({
  "vault-app": true,
  "vault-grant": true,
  "vault-request": true,
  "vault-secret": true,
  "vault-settings": true,
} satisfies Record<VaultAuditTargetType, true>) as VaultAuditTargetType[];

export interface VaultAuditQuery {
  action?: string;
  status?: AuditStatus;
  actorEmail?: string;
  sinceMs?: number;
  limit?: number;
  offset?: number;
}

export interface VaultAuditPage {
  events: AuditEvent[];
  limit: number;
  offset: number;
  hasMore: boolean;
}

const DEFAULT_VAULT_AUDIT_LIMIT = 25;
const MAX_VAULT_AUDIT_LIMIT = 100;

/**
 * The vault activity timeline: the framework action audit log narrowed to the
 * vault's target types, so reads and mutations arrive from one query.
 *
 * It is not `vault_audit_log`. A refused vault call throws inside the store
 * *before* `recordVaultAudit` could run, so that table can only ever hold the
 * calls that succeeded; the action seam records `denied` and `error` too.
 * `vault_audit_log` is still written by its existing callers — nothing reads it
 * for this timeline.
 *
 * Vault *reads* arrive here through `reveal-vault-secret`, which stamps the
 * same `vault-secret` target type a mutation does — a revealed value is one
 * row in the same timeline as the edit that created it, and the query needed
 * no change to pick it up.
 */
export async function listVaultAuditEvents(
  query: VaultAuditQuery = {},
): Promise<VaultAuditPage> {
  // Deliberately NOT behind `assertCanManageVault`. Upstream's admin gate
  // guards `vault_audit_log`, whose rows are org-wide and unscoped by reader.
  // This timeline is a different surface: `queryAuditEvents` scopes every row
  // to the caller's identity and org, and an org member is meant to see
  // org-visible vault activity — including their own refused attempts, which
  // never reach `vault_audit_log` at all. Adding the gate here reads like
  // tightening security and instead removes a member's view of what was done
  // to them.
  const ctx = requireVaultCtx();
  const limit = Math.min(
    Math.max(1, Math.floor(query.limit ?? DEFAULT_VAULT_AUDIT_LIMIT)),
    MAX_VAULT_AUDIT_LIMIT,
  );
  const offset = Math.max(0, Math.floor(query.offset ?? 0));
  const rows = await queryAuditEvents(
    { userEmail: ctx.ownerEmail, orgId: ctx.orgId },
    {
      targetTypes: VAULT_AUDIT_TARGET_TYPES,
      ...(query.action ? { action: query.action } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.actorEmail ? { actorEmail: query.actorEmail } : {}),
      ...(typeof query.sinceMs === "number" ? { sinceMs: query.sinceMs } : {}),
      // One row past the page answers "is there a next page" without a
      // second COUNT over the same scan.
      limit: limit + 1,
      offset,
    },
  );
  return {
    events: rows.slice(0, limit),
    limit,
    offset,
    hasMore: rows.length > limit,
  };
}
