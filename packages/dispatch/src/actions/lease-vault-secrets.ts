import { defineAction } from "@agent-native/core";
import { z } from "zod";

import {
  getSecretsByKeys,
  normalizeCredentialKey,
  requireVaultCtx,
} from "../server/lib/vault-store.js";

const MAX_LEASED_KEYS = 50;

export default defineAction({
  description:
    "Lease an explicit list of workspace vault secrets to a caller that already holds a connect bearer, as one audited all-or-nothing event. Returns the values under `env` keyed by credential key. Refuses the whole lease, naming every offending key at once, if any key is missing, ambiguous, or stored without a value.",
  schema: z.object({
    keys: z
      .array(z.string().trim().min(1))
      .min(1)
      .max(MAX_LEASED_KEYS)
      .describe(
        "Exact credential keys to lease, e.g. ['GOOGLE_CLIENT_ID']. No wildcards; every key must resolve or the whole lease is refused.",
      ),
    leaseId: z
      .string()
      .trim()
      .min(1)
      .describe(
        "Caller-minted id for this lease. Arrives as an input so the audit row joins to it.",
      ),
  }),
  http: { method: "POST" },
  // Hygiene, not a boundary. Access is whatever the action HTTP route already
  // requires plus `requireVaultCtx()` — any authenticated caller, curl
  // included. Hiding it from the agent and tool-iframe surfaces only keeps a
  // model turn from reaching plaintext credentials by accident.
  agentTool: false,
  toolCallable: false,
  audit: {
    enabled: true,
    // The opposite of `create-vault-secret`: the recorded inputs here are key
    // NAMES, which is exactly what the trail needs.
    recordInputs: true,
    // `visibility` must be stamped explicitly. It defaults to "private", and
    // the auto-escalation to "org" is gated on an integration request context
    // that a CLI or HTTP vault call never has — left to default, an org-wide
    // lease would be invisible to the org that owns the secrets. `ownerEmail`
    // is deliberately unset: the org branch of `scopeClause` is a standalone
    // disjunct that never consults `owner_email`.
    //
    // Neither this nor `summary` may read `result`. That is the one route by
    // which a leased value could reach the durable log, so the rule is
    // absolute rather than a judgement about which fields happen to be safe.
    target: (args, _result, meta) => ({
      type: "vault-lease",
      id: args.leaseId,
      orgId: meta.orgId ?? null,
      visibility: meta.orgId ? "org" : "private",
    }),
    summary: (args) =>
      `Leased ${args.keys.length} vault secret(s) as ${args.leaseId}: ${args.keys.join(", ")}`,
  },
  run: async ({ keys, leaseId }) => {
    // Same normalizer the lookup uses, so a requested name and the stored
    // `credentialKey` it should match cannot drift apart.
    const requested = [...new Set(keys.map(normalizeCredentialKey))];
    const rows = await getSecretsByKeys(requested, requireVaultCtx());

    const byKey = new Map<string, typeof rows>();
    for (const row of rows) {
      const bucket = byKey.get(row.credentialKey);
      if (bucket) bucket.push(row);
      else byKey.set(row.credentialKey, [row]);
    }

    const missing = requested.filter((key) => !byKey.has(key));
    const ambiguous = requested.filter(
      (key) => (byKey.get(key)?.length ?? 0) > 1,
    );
    // A stored row with no value is neither absent nor readable. Mapping it to
    // "" would hand the caller a credential-shaped blank and let the failure
    // surface as an authentication error somewhere downstream.
    const empty = requested.filter((key) => {
      const bucket = byKey.get(key);
      return bucket?.length === 1 && !bucket[0].value;
    });

    if (missing.length || ambiguous.length || empty.length) {
      const reasons = [
        missing.length && `no vault secret for ${missing.join(", ")}`,
        ambiguous.length &&
          `ambiguous credential key(s) ${ambiguous.join(", ")} — more than one visible vault secret uses each; rename or delete the duplicates rather than relying on which one wins`,
        empty.length && `no stored value for ${empty.join(", ")}`,
      ].filter(Boolean);
      throw new Error(
        `Vault lease ${leaseId} refused (all-or-nothing): ${reasons.join("; ")}`,
      );
    }

    const env: Record<string, string> = {};
    for (const key of requested) env[key] = byKey.get(key)![0].value;

    return { leaseId, env };
  },
});
