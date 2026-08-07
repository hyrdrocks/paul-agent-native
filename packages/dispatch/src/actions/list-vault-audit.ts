import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { listVaultAuditEvents } from "../server/lib/vault-audit.js";

export default defineAction({
  description:
    "View vault activity — secret access, grants, syncs, and requests — from the framework action audit log, including refused attempts. Admin only. Filter by action name, outcome, actor, and time; page with limit and offset.",
  schema: z.object({
    action: z
      .string()
      .optional()
      .describe("Filter to one action name, e.g. sync-vault-to-app."),
    status: z
      .enum(["success", "error", "denied"])
      .optional()
      .describe("Filter by outcome. A refused call is 'denied' or 'error'."),
    actorEmail: z
      .string()
      .optional()
      .describe("Filter to one actor's email address."),
    sinceMs: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Only events at or after this Unix epoch (ms)."),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe("Max entries per page (default 25)."),
    offset: z.coerce
      .number()
      .int()
      .min(0)
      .optional()
      .describe("Skip this many entries before the page (0-based)."),
  }),
  http: { method: "GET" },
  run: async (args) => listVaultAuditEvents(args),
});
