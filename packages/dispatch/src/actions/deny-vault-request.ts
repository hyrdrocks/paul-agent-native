import { defineAction } from "@agent-native/core";
import { z } from "zod";

import {
  vaultAuditTarget,
  vaultRequestAuditOrgId,
} from "../server/lib/vault-audit.js";
import { denyRequest, requireVaultCtx } from "../server/lib/vault-store.js";

export default defineAction({
  description: "Deny a pending vault secret request. Admin only.",
  schema: z.object({
    id: z.string().describe("Request ID to deny"),
    reason: z.string().optional().describe("Reason for denial"),
  }),
  audit: {
    target: (args, result, meta) =>
      vaultAuditTarget(meta, {
        type: "vault-request",
        id: args.id,
        orgId: vaultRequestAuditOrgId(result),
      }),
  },
  run: async (args) => denyRequest(args.id, args.reason, requireVaultCtx()),
});
