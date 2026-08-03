import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { vaultAuditTarget } from "../server/lib/vault-audit.js";
import { grantSecretsToApp } from "../server/lib/vault-store.js";

export default defineAction({
  description:
    "Grant multiple Dispatch vault secrets to a workspace app in manual vault access mode. Existing active grants are skipped.",
  http: { method: "POST" },
  schema: z.object({
    appId: z
      .string()
      .regex(/^[a-z][a-z0-9-]{0,63}$/)
      .describe("Workspace app id/path, e.g. customer-health"),
    secretIds: z
      .array(z.string())
      .max(100)
      .describe("Vault secret IDs to grant to the app"),
  }),
  audit: {
    target: (args, _result, meta) =>
      vaultAuditTarget(meta, { type: "vault-app", id: args.appId }),
  },
  run: async (args) => grantSecretsToApp(args.secretIds, args.appId),
});
