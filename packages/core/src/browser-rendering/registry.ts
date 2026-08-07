/**
 * The registry of browser-rendering providers.
 *
 * How a process reaches a real DOM is a property of the HOST, not of the
 * action that wants one. A call site that decides for itself sees only "the
 * Chromium import threw", and every call site resolves that the same way — it
 * returns a result the caller cannot tell from a render: an empty screenshot,
 * a blank page, an SVG with no nodes. That is the failure this seam exists to
 * make impossible.
 *
 * So the question is asked once, here, and the answer is a typed decision.
 * `null` from a provider means "not this host", never "this host cannot
 * render"; nothing resolving at all means no host claimed the process, which
 * is the local Chromium path and the only case where a caller may launch one
 * itself.
 *
 * Two rules make the order safe to extend, matching `hosts/fallback-storage`:
 *
 *  - **Priority is declared, not positional.** Registering (or importing, or
 *    bundling) earlier cannot displace an existing provider.
 *  - **A provider answers only for itself**, so loading every adapter is safe.
 *
 * Host adapters import this module to register themselves, so this module must
 * never import a host adapter back — see `browser-rendering/index.ts`, which
 * is where the by-value import lives.
 */

/** Why a host cannot render, and what the operator does about it. */
export interface BrowserRenderingRefusal {
  /** Id of the provider that refused. Diagnostic; never branched on. */
  provider: string;
  /** What this host is, in terms that explain the refusal. */
  reason: string;
  /** The concrete configuration that would make rendering available. */
  setup: string;
}

export type BrowserRenderingDecision =
  /**
   * This host renders through a platform binding. The binding is opaque here:
   * core owns which binding and whether it is usable, the caller owns the
   * client that speaks to it, so no browser client is a dependency of core.
   */
  | { available: true; provider: string; binding: unknown }
  | ({ available: false } & BrowserRenderingRefusal);

export interface BrowserRenderingProvider {
  /** Stable id; travels on a decision as `provider`. */
  id: string;
  /**
   * Declared consultation order — lower is asked first. Spread out so a host
   * can be slotted between two existing ones without renumbering them.
   */
  priority: number;
  /**
   * This host's answer in THIS process, or `null` when it does not apply here.
   * `null` means "not this host" and never "no browser" — a provider that
   * cannot tell must refuse, because a wrong "available" ends in a caller
   * waiting on a browser that does not exist, and a wrong "not this host"
   * ends in a Worker trying to spawn a Chromium binary.
   */
  resolve(): BrowserRenderingDecision | null;
}

// Why globalThis: same reasoning as `hosts/fallback-storage` — a bundle split
// that evaluates this module twice would otherwise leave the resolver reading
// an empty registry and reporting that no host claimed a process this host
// very much claims.
interface BrowserRenderingGlobals {
  __agentNativeBrowserRenderingProviders?: Map<
    string,
    BrowserRenderingProvider
  >;
}
const globals = globalThis as typeof globalThis & BrowserRenderingGlobals;
const providers: Map<string, BrowserRenderingProvider> =
  (globals.__agentNativeBrowserRenderingProviders ??= new Map());

/** Register a provider. Idempotent per id — later calls with the same id replace. */
export function registerBrowserRenderingProvider(
  provider: BrowserRenderingProvider,
): void {
  providers.set(provider.id, provider);
}

export function unregisterBrowserRenderingProvider(id: string): void {
  providers.delete(id);
}

/** Registered providers in declared priority order. */
export function listBrowserRenderingProviders(): BrowserRenderingProvider[] {
  return [...providers.values()].sort((a, b) => a.priority - b.priority);
}

/**
 * The first provider that claims this process, or `null` when none does.
 *
 * `null` is "no host claimed this process", which is a plain Node run where
 * launching a local Chromium is correct. It is deliberately a different value
 * from `{ available: false }`: a host that claims the process and cannot
 * render must never be answered by the caller reaching for a browser binary
 * that is not there.
 */
export function resolveBrowserRenderingDecision(): BrowserRenderingDecision | null {
  for (const provider of listBrowserRenderingProviders()) {
    const decision = provider.resolve();
    if (decision) return decision;
  }
  return null;
}
