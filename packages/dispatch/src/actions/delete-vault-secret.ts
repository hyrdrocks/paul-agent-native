import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { vaultAuditTarget } from "../server/lib/vault-audit.js";
import { deleteSecret } from "../server/lib/vault-store.js";

export default defineAction({
  description:
    "Delete a secret from the workspace vault. Also revokes all active grants for this secret. Admin only.",
  schema: z.object({
    id: z.string().describe("Secret ID to delete"),
  }),
  audit: {
    target: (args, _result, meta) =>
      vaultAuditTarget(meta, { type: "vault-secret", id: args.id }),
  },
  run: async (args) => deleteSecret(args.id),
});
