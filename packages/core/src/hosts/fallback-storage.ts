/**
 * The registry of fallback-storage policies.
 *
 * Whether a payload may be stored somewhere other than the store it was meant
 * for is a property of the HOST, not a decision made at the call site. A call
 * site that decides for itself has to answer it from whatever it can see
 * locally — "the provider returned nothing" — and every call site answers it
 * the same wrong way, by writing the body into SQL. That is how a base64 blob
 * reaches a production database while every layer above reports a clean
 * upload.
 *
 * So the question is asked once, here, and the answer is a typed decision the
 * caller cannot mistake for a result. A host that refuses names the setup step
 * that would make it permitted, because a refusal a user cannot act on is only
 * a different kind of dead end.
 *
 * Two rules make the order safe to extend, matching `background-transports`:
 *
 *  - **Priority is declared, not positional.** Registering (or importing, or
 *    bundling) earlier cannot displace an existing policy.
 *  - **A policy answers only for itself.** `decide()` returns `null` for "not
 *    this host", which is why loading every adapter is always safe.
 *
 * Host adapters import this module to register themselves, so this module must
 * never import the host barrel back — see `hosts/index.ts`.
 */

/** Why a host refuses, and what the operator does about it. */
export interface FallbackStorageRefusal {
  /** Id of the policy that refused. Diagnostic; never branched on. */
  policy: string;
  /** What this host is, in terms that explain the refusal. */
  reason: string;
  /** The concrete configuration that makes the intended store available. */
  setup: string;
}

export type FallbackStorageDecision =
  | { permitted: true }
  | ({ permitted: false } & FallbackStorageRefusal);

export interface FallbackStoragePolicy {
  /** Stable id; travels on a refusal as `policy`. */
  id: string;
  /**
   * Declared consultation order — lower is asked first. Spread out so a host
   * can be slotted between two existing ones without renumbering them.
   */
  priority: number;
  /**
   * This host's answer in THIS process, or `null` when the policy does not
   * apply here. `null` means "not this host", never "this host permits it" —
   * a policy that cannot tell must refuse, because the cost of a wrong
   * "permitted" is a payload in a store that will never be looked at again.
   */
  decide(): FallbackStorageDecision | null;
}

/**
 * Nothing answered, so no host claims this process. Permitting is correct
 * here and only here: an unrecognised process is a plain Node dev run against
 * a local SQLite file, where a capped SQL fallback is the documented
 * behaviour. Every host that is NOT that registers a policy.
 */
const UNCLAIMED_PROCESS_DECISION: FallbackStorageDecision = { permitted: true };

// Why globalThis: same reasoning as `file-upload/registry` and
// `agent/background-transports` — a bundle split that evaluates this module
// twice would otherwise leave the resolver reading an empty registry and
// silently permitting a fallback the host refuses.
interface FallbackStorageGlobals {
  __agentNativeFallbackStoragePolicies?: Map<string, FallbackStoragePolicy>;
}
const globals = globalThis as typeof globalThis & FallbackStorageGlobals;
const policies: Map<string, FallbackStoragePolicy> =
  (globals.__agentNativeFallbackStoragePolicies ??= new Map());

/** Register a policy. Idempotent per id — later calls with the same id replace. */
export function registerFallbackStoragePolicy(
  policy: FallbackStoragePolicy,
): void {
  policies.set(policy.id, policy);
}

export function unregisterFallbackStoragePolicy(id: string): void {
  policies.delete(id);
}

/** Registered policies in declared priority order. */
export function listFallbackStoragePolicies(): FallbackStoragePolicy[] {
  return [...policies.values()].sort((a, b) => a.priority - b.priority);
}

/**
 * The first policy that claims this process, or the unclaimed-process
 * decision. Callers act on `permitted`; a refusal carries the setup guidance
 * they surface.
 */
export function resolveFallbackStorageDecision(): FallbackStorageDecision {
  for (const policy of listFallbackStoragePolicies()) {
    const decision = policy.decide();
    if (decision) return decision;
  }
  return UNCLAIMED_PROCESS_DECISION;
}
