import { defineAction } from "@agent-native/core";
import { last4 } from "@agent-native/core/secrets";
import { z } from "zod";

import { listSecrets } from "../server/lib/vault-store.js";

export default defineAction({
  description:
    "List the secrets stored in the workspace vault: names, credential keys, and a masked last-4 preview. Admin only. Never returns secret values — one id at a time goes through `reveal-vault-secret`, which is audited.",
  schema: z.object({}),
  http: { method: "GET" },
  run: async () => {
    const secrets = await listSecrets();
    return secrets.map((s) => ({
      id: s.id,
      name: s.name,
      credentialKey: s.credentialKey,
      // Enough to tell six OPENAI_API_KEY-ish rows apart without revealing
      // any. `last4("")` is "" rather than a mask, so a row stored with no
      // value stays distinguishable from one whose value is simply short.
      last4: last4(s.value),
      provider: s.provider,
      description: s.description,
      createdBy: s.createdBy,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    }));
  },
});
