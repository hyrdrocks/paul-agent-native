import { defineAction } from "@agent-native/core";
import { z } from "zod";

import { vaultAuditTarget } from "../server/lib/vault-audit.js";
import { getSecret, requireVaultCtx } from "../server/lib/vault-store.js";

export default defineAction({
  description:
    "Reveal the stored value of one workspace vault secret, by id, as an audited event. `list-vault-secrets` returns a masked last-4 preview only; sweeping the vault costs one attributable call per secret.",
  schema: z.object({
    id: z
      .string()
      .trim()
      .min(1)
      .describe("Id of the single vault secret to reveal."),
  }),
  http: { method: "POST" },
  // A POST that only reads: mounted POST so a value never lands in a URL or a
  // GET-shaped cache, `readOnly` so the frontend does not refetch the world
  // after an eye click. The audit below is `enabled` rather than `onRead`
  // precisely so this flag cannot silently turn the record off.
  readOnly: true,
  // Hygiene, not a boundary. The connect bearer still authenticates this from
  // curl; hiding it from the agent and tool-iframe surfaces only keeps a model
  // turn from reaching a plaintext credential by accident.
  agentTool: false,
  toolCallable: false,
  audit: {
    enabled: true,
    // The recorded input is a secret id, which is exactly what the trail needs.
    recordInputs: true,
    // Neither this nor `summary` may read `result.value`. That is the one route
    // by which a revealed value could reach the durable log, so the rule is
    // absolute rather than a judgement about which fields happen to be safe.
    target: (args, _result, meta) =>
      vaultAuditTarget(meta, { type: "vault-secret", id: args.id }),
    summary: (args) => `Revealed the value of vault secret ${args.id}`,
  },
  run: async ({ id }) => {
    const secret = await getSecret(id, requireVaultCtx());
    if (!secret) {
      throw new Error(`No vault secret ${id} is visible to you.`);
    }
    // A stored row with no value is neither absent nor readable. Returning ""
    // would hand the caller a credential-shaped blank and let the failure
    // surface as an authentication error somewhere downstream.
    if (!secret.value) {
      throw new Error(`Vault secret ${id} has no stored value.`);
    }
    return {
      id: secret.id,
      credentialKey: secret.credentialKey,
      name: secret.name,
      value: secret.value,
    };
  },
});
