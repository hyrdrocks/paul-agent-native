/**
 * The registry of durable background transports.
 *
 * A durable background run is handed to whatever this process actually has a
 * long-budget worker on. That used to be one host hardcoded in the resolver
 * with a second host bolted on beside it, so a reader saw two hosts handled two
 * ways and could not tell which one won when both answered. Here every host
 * registers the same way and declares where it sits, and the resolver asks them
 * in that declared order.
 *
 * Two rules make the order safe to extend:
 *
 *  - **Priority is declared, not positional.** Adding a transport cannot
 *    displace an existing one by being registered (or imported, or bundled)
 *    ahead of it — only by declaring a lower `priority`, which is a visible
 *    decision in a diff.
 *  - **A transport answers only for itself.** `resolve()` returns `null` for
 *    "not available in this process", which is why loading every adapter is
 *    always safe. It must never return a target it cannot actually deliver on:
 *    a handoff into a void is the exact silent degrade this seam exists to
 *    prevent.
 *
 * Host adapters import this module to register themselves, so this module must
 * never import the host barrel back — see `hosts/index.ts`.
 */

/**
 * Where a durable background run is handed off, as ONE typed value.
 *
 * The transport and the runtime expectation travel together because they are
 * one decision: a caller that knows the transport must not have to re-derive
 * from the path string whether the receiving worker gets the long budget.
 *
 * Deliberately NOT a discriminated union over known hosts. A caller acts on the
 * declared properties below — is there a path to POST to, does the receiver
 * carry its own budget — never on recognising which host answered. That is what
 * lets a host be added without every consumer in core growing an arm for it.
 */
export interface BackgroundDispatchTarget {
  /**
   * Id of the transport that resolved this target. An opaque routing key used
   * to find the transport again (see `deliverBackgroundHandoff`), NOT something
   * a caller should branch on — the properties below are.
   */
  kind: string;
  /**
   * URL path the handoff is POSTed to, when this transport is addressed by one.
   * Absent means the transport hands the run over some other way and the caller
   * must go through `deliverBackgroundHandoff`; substituting a path here would
   * run the turn inline while reporting a durable handoff.
   */
  path?: string;
  /** True when the receiving worker carries its own long budget. */
  expectsBackgroundRuntime: boolean;
}

/** One handoff, in the terms every transport can act on. */
export interface BackgroundHandoff {
  /** Run/task id the processor claims. */
  taskId: string;
  /** Origin the receiver builds its request URL against. */
  origin: string;
  /** JSON body the processor route receives, processor-selection field and all. */
  body?: Record<string, unknown>;
}

export interface BackgroundTransport {
  /** Stable id; travels as the resolved target's `kind`. */
  id: string;
  /**
   * Declared consultation order — lower is asked first. Spread out so a host
   * can be slotted between two existing ones without renumbering them.
   */
  priority: number;
  /**
   * True when a successful handoff on this transport does NOT prove a consumer
   * claimed the run: it acknowledges receipt and the worker starts (or fails to
   * start) later, out of sight. Such a run needs a watchdog, because "accepted
   * and never claimed" is otherwise indistinguishable from "accepted and
   * running" right up until the turn is silently recovered inline.
   *
   * A transport whose handoff returns a synchronous accepted status declares
   * `false`: its failure is already visible at the call site.
   */
  acknowledgesWithoutClaim: boolean;
  /**
   * The target this transport hands a run to in THIS process, or `null` when
   * the transport is not available here. `null` means "not this host", never
   * "this host failed" — a transport that is present but unusable must report
   * that itself and still return `null`, so the caller lands on the portable
   * fallback rather than on a handoff nothing will claim.
   */
  resolve(): BackgroundDispatchTarget | null;
  /**
   * Perform a handoff that has no `path` to POST to. Throws on failure; callers
   * catch and degrade to an inline run. Required exactly when `resolve()` can
   * return a target without a `path`.
   */
  deliver?(handoff: BackgroundHandoff): Promise<void>;
}

/**
 * Id of the portable in-process route. Not a registered transport: it is what
 * the resolver terminates in when no transport is available, and it carries the
 * caller's own fallback path rather than anything a host declares.
 */
export const INLINE_ROUTE_TRANSPORT_ID = "inline-route";

// Why globalThis: in dev (Vite HMR) and in some Nitro/Rollup bundle splits this
// module can be evaluated more than once — the host adapter that registers a
// transport lands in one module instance and the resolver that reads them lands
// in another, so the resolver would see an empty registry and quietly hand
// every run to the in-process route. Same reasoning as `file-upload/registry`.
interface BackgroundTransportGlobals {
  __agentNativeBackgroundTransports?: Map<string, BackgroundTransport>;
}
const globals = globalThis as typeof globalThis & BackgroundTransportGlobals;
const transports: Map<string, BackgroundTransport> =
  (globals.__agentNativeBackgroundTransports ??= new Map());

/** Register a background transport. Idempotent per id — later calls replace. */
export function registerBackgroundTransport(
  transport: BackgroundTransport,
): void {
  transports.set(transport.id, transport);
}

export function unregisterBackgroundTransport(id: string): void {
  transports.delete(id);
}

/** Registered transports in declared priority order. */
export function listBackgroundTransports(): BackgroundTransport[] {
  return [...transports.values()].sort((a, b) => a.priority - b.priority);
}

/**
 * The first registered transport available in this process, or `null` when
 * none is. Callers terminate in the portable in-process route.
 */
export function resolveRegisteredBackgroundTarget(): BackgroundDispatchTarget | null {
  for (const transport of listBackgroundTransports()) {
    const target = transport.resolve();
    if (target) return target;
  }
  return null;
}

/**
 * Whether a run handed to this target needs the unclaimed-run watchdog.
 *
 * Reads the transport's own declaration rather than testing the target against
 * a particular transport, so a host that acknowledges without proof of a claim
 * gets the watchdog by saying so, not by being recognised here.
 *
 * The in-process route is synchronous by construction. An id no registered
 * transport claims is NOT assumed benign: we cannot tell whether that handoff
 * proved a claim, so it is reported and watched.
 */
export function backgroundTargetAcknowledgesWithoutClaim(
  target: BackgroundDispatchTarget,
): boolean {
  if (target.kind === INLINE_ROUTE_TRANSPORT_ID) return false;
  const transport = transports.get(target.kind);
  if (transport) return transport.acknowledgesWithoutClaim;
  console.error(
    `[agent-chat] no registered background transport declares the id "${target.kind}", so whether ` +
      "this handoff proved a consumer claimed the run is unknown — watching it as if it did not.",
  );
  return true;
}

/** True when the target is a durable transport rather than the in-process route. */
export function isDurableBackgroundTarget(
  target: BackgroundDispatchTarget,
): boolean {
  return target.kind !== INLINE_ROUTE_TRANSPORT_ID;
}

/**
 * Hand a run to a transport that is not addressed by a URL path.
 *
 * Throws on every failure — an unknown transport, one that declared no
 * `deliver`, or a rejected handoff. Callers already catch and degrade to an
 * inline run; a resolved-but-undeliverable target must never look like a
 * completed handoff.
 */
export async function deliverBackgroundHandoff(
  target: BackgroundDispatchTarget,
  handoff: BackgroundHandoff,
): Promise<void> {
  const transport = transports.get(target.kind);
  if (!transport?.deliver) {
    throw new Error(
      `[agent-chat] durable background resolved to the "${target.kind}" transport, which has no ` +
        "dispatch path and no registered way to deliver a handoff in this process.",
    );
  }
  await transport.deliver(handoff);
}
