/**
 * Cross-request-safe waiting for isolate-wide, one-time initialization.
 *
 * On Cloudflare Workers a promise belongs to the request context that created
 * it. When that request completes, workerd cancels every continuation attached
 * to its promises — including the continuations of OTHER in-flight requests
 * that were awaiting the same isolate-global init promise:
 *
 *   "A promise was resolved or rejected from a different request context than
 *    the one it was created in. However, the creating request has already been
 *    completed or canceled. Continuations for that request are unlikely to run
 *    safely and have been canceled."
 *
 * Those requests then never observe the result: they wait out whatever deadline
 * is above them (503) or are killed as hung, and any route the init was meant to
 * register is missing, so the router answers its no-match 404. A cold isolate
 * that takes a concurrent burst fails in exactly that mixed way.
 *
 * Node has no such rule — one shared promise awaited by many callers is correct
 * there, and it stays the Node path. The Workers-safe shape has two halves, and
 * both are required:
 *
 *   1. the work is STARTED inside a request context and handed to that same
 *      request's `waitUntil`, so the creating context outlives its own response
 *      and the work's own continuations stay legal;
 *   2. every other request polls a plain boolean flag with timers it created
 *      itself, and never touches the foreign promise.
 *
 * Measured on workerd (wrangler dev), 800ms of "boot" started by one request and
 * observed by three later ones:
 *
 *   await the foreign promise                    3/3 hit the deadline
 *   poll a flag, no waitUntil on the creator     3/3 hit the deadline
 *   poll a flag, creator called waitUntil        3/3 saw it at ~765ms
 *   another request lends its waitUntil          does NOT rescue it
 *   start the work at module scope               throws "Disallowed operation
 *                                                called within global scope"
 *
 * So the keep-alive belongs to whoever creates the promise, and only there.
 */
import { isCloudflareRuntime } from "../shared/runtime.js";

/**
 * Completion flag for one init attempt. Deliberately a plain mutable object
 * rather than a promise: a flag can be read from any request context, a promise
 * cannot be awaited from one.
 *
 * `settled` says the attempt finished, not that it succeeded — `error` is what
 * distinguishes them, so a caller can tell "still running" from "ran and
 * failed" instead of treating both as not-ready.
 */
export interface InitState {
  settled: boolean;
  error?: unknown;
}

/** How often a waiting request re-reads an init flag. */
export const INIT_POLL_INTERVAL_MS = 10;

/**
 * True on runtimes where awaiting a promise created by another request is
 * unsafe (Cloudflare Workers/Pages). Node, Bun, Deno and the Node-based
 * serverless hosts all share promises across requests without complaint.
 */
export function isCrossRequestPromiseUnsafe(): boolean {
  return isCloudflareRuntime();
}

/** Sleep on a timer owned by the CURRENT request context. */
export function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

const KEEP_ALIVE_KEY = "_agentNativeKeepAlivePromises";

/**
 * Extend `promise`'s lifetime past this request's response via the platform's
 * `waitUntil`.
 *
 * Only meaningful for a promise THIS request created: workerd cancels a promise
 * when its creating context ends, and no other context can take that over — a
 * second request handing a foreign promise to its own waitUntil was measured to
 * change nothing.
 *
 * Nitro's Cloudflare preset puts `waitUntil` on the raw request and h3 exposes
 * it as `event.waitUntil`; hosts without it (Node) simply get a no-op, since
 * nothing cancels their promises. Registering the same promise twice for one
 * request is pointless, so each event remembers what it already handed over.
 */
export function keepAliveAcrossRequests(
  event: unknown,
  promise: Promise<unknown> | undefined,
): void {
  if (!promise || !event || typeof event !== "object") return;
  const eventAny = event as any;
  const target =
    typeof eventAny.waitUntil === "function"
      ? eventAny
      : typeof eventAny.req?.waitUntil === "function"
        ? eventAny.req
        : undefined;
  if (!target) return;

  const context = (eventAny.context ??= {});
  const registered: WeakSet<object> = (context[KEEP_ALIVE_KEY] ??=
    new WeakSet<object>());
  if (registered.has(promise)) return;
  registered.add(promise);

  try {
    target.waitUntil(promise);
  } catch (err) {
    // The runtime refused to extend this context (already closed, or a host
    // whose waitUntil rejects late registration). The caller still polls its
    // own flag, so this costs lifetime, not correctness — but it is a real
    // reason for a slow cold start, so say so rather than hiding it.
    console.warn(
      "[agent-native] waitUntil refused an init keep-alive:",
      (err as Error)?.message || err,
    );
  }
}

/**
 * Poll `read` in the caller's own context until it returns a value, or the
 * timeout expires. Returns `undefined` on timeout — callers must treat that as
 * "unknown", never as "absent".
 */
export async function pollForValue<T>(
  read: () => T | undefined,
  options: { timeoutMs: number; intervalMs?: number },
): Promise<T | undefined> {
  const interval = options.intervalMs ?? INIT_POLL_INTERVAL_MS;
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const value = read();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) return undefined;
    await sleep(interval);
  }
}
