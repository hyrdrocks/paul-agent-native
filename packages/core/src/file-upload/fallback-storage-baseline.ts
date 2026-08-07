/**
 * The portable fallback-storage baseline.
 *
 * Not a host: it is what answers for every process no host adapter claims, so
 * that "we did not recognise this deployment" cannot be the reason a file body
 * reaches SQL. The rule it encodes is the one `storing-data` states — a capped
 * SQL fallback is a local development convenience, and a hosted deploy or a
 * persistent database is neither.
 *
 * It refuses on either fact alone. A persistent database is shared and grows
 * without a local file to delete; a production runtime is not somewhere anyone
 * is watching a warning scroll past. Both are places where the fallback's cost
 * is paid by someone who cannot see it happening.
 */

import { registerFallbackStoragePolicy } from "../hosts/fallback-storage.js";

/** Consulted last: any host that claims a process answers ahead of this. */
const PORTABLE_FALLBACK_STORAGE_PRIORITY = 100;

const POLICY_ID = "portable";

const SETUP =
  "Configure file storage: connect Builder.io in Settings → File uploads, or register an S3/R2/GCS provider with registerFileUploadProvider().";

function persistentDatabaseConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL?.trim());
}

function productionRuntime(): boolean {
  return process.env.NODE_ENV === "production";
}

export function registerPortableFallbackStoragePolicy(): void {
  registerFallbackStoragePolicy({
    id: POLICY_ID,
    priority: PORTABLE_FALLBACK_STORAGE_PRIORITY,
    decide() {
      if (persistentDatabaseConfigured()) {
        return {
          permitted: false,
          policy: POLICY_ID,
          reason:
            "This app runs against a persistent database (DATABASE_URL is set), where a file payload written into SQL is shared, durable, and nobody's to clean up.",
          setup: SETUP,
        };
      }
      if (productionRuntime()) {
        return {
          permitted: false,
          policy: POLICY_ID,
          reason:
            "This app runs in production (NODE_ENV=production), where the SQL fallback is not a development convenience anyone is watching.",
          setup: SETUP,
        };
      }
      // Neither fact holds: a local run against a local SQLite file, where the
      // capped fallback is the documented behaviour. Decline rather than
      // permit, so this reads as "nothing here refuses" and the registry's own
      // unclaimed-process answer stays the single place that says yes.
      return null;
    },
  });
}
