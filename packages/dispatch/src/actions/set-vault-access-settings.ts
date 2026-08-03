import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { vaultAuditTarget } from "../server/lib/vault-audit.js";
import {
  setVaultAccessSettings,
  VAULT_ACCESS_SETTINGS_KEY,
} from "../server/lib/vault-store.js";

export default defineAction({
  description:
    "Set the Dispatch vault access mode. Use all-apps for the default workspace-wide mode or manual to require explicit per-app grants.",
  schema: z.object({
    mode: z
      .enum(["all-apps", "manual"])
      .describe(
        "all-apps shares every vault key with every app; manual requires grants",
      ),
  }),
  audit: {
    target: (_args, _result, meta) =>
      vaultAuditTarget(meta, {
        type: "vault-settings",
        id: VAULT_ACCESS_SETTINGS_KEY,
      }),
  },
  run: async (args) => setVaultAccessSettings(args),
});
