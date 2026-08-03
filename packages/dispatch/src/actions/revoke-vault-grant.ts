import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { vaultAuditTarget } from "../server/lib/vault-audit.js";
import { revokeGrant } from "../server/lib/vault-store.js";

export default defineAction({
  description: "Revoke an app's access to a vault secret. Admin only.",
  schema: z.object({
    grantId: z.string().describe("Grant ID to revoke"),
  }),
  audit: {
    target: (args, _result, meta) =>
      vaultAuditTarget(meta, { type: "vault-grant", id: args.grantId }),
  },
  run: async (args) => revokeGrant(args.grantId),
});
