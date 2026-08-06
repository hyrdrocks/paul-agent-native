import {
  isCrossRequestPromiseUnsafe,
  keepAliveAcrossRequests,
  pollForValue,
  type InitState,
} from "../server/cross-request-init.js";

/**
 * Memoize a one-time schema-init routine so that a second caller can learn how
 * the first attempt ended without ever awaiting a promise the first caller
 * created.
 *
 * Workers ties every promise to the request that created it. An init kicked off
 * by a request that returns before its DDL settles leaves a promise that can
 * never settle for anyone else: not resolved, not rejected, just abandoned. A
 * plain `_initPromise ??= run()` memo then hands that corpse to every later
 * caller, and each one awaits forever — no error, nothing in the logs, the
 * request simply never answers. That is how one fire-and-forget
 * `ensureTables()` silently killed every agent chat turn on D1.
 *
 * The rule this encodes is the one measured in `cross-request-init.ts`: the
 * request that starts the work holds it open with its own `waitUntil`, and
 * every other caller polls a plain flag on timers it owns. The flag is what
 * makes this fit behind a `Promise<void>` memo at all — a void promise offers a
 * waiter nothing to observe, so the memo keeps an `InitState` beside it.
 *
 * Off Workers there is no such rule, so callers share the one promise, which is
 * both cheaper and exactly what Node has always done.
 */
export interface InitMemo {
  /**
   * `event` is the h3 event of the request making this call, when there is one.
   * It matters only for the caller that ends up STARTING the init: workerd
   * cancels a promise when its creating request answers, and only that
   * request's `waitUntil` can extend it. Omitting it costs the waiters a
   * timeout and a duplicate attempt, not correctness.
   */
  (event?: unknown): Promise<void>;
  /** Drop the cached result so the next call re-runs the init. */
  reset(): void;
}

export interface InitMemoOptions {
  /**
   * How long a caller watches somebody else's in-flight init before giving up
   * on it and running its own. Must stay well above a warm init and below the
   * readiness deadline above it. Cold D1/Postgres init runs into seconds.
   */
  waitMs?: number;
}

const DEFAULT_INIT_WAIT_MS = 12_000;

interface Attempt {
  state: InitState;
  promise: Promise<void>;
}

export function createInitMemo(
  init: () => Promise<void>,
  options: InitMemoOptions = {},
): InitMemo {
  const waitMs = options.waitMs ?? DEFAULT_INIT_WAIT_MS;
  let succeeded = false;
  let current: Attempt | undefined;

  const start = (event: unknown): Promise<void> => {
    const state: InitState = { settled: false };
    const promise = init().then(
      () => {
        // Settle the flag whatever happened to the memo meanwhile: a waiter
        // that joined this attempt is still polling this exact object.
        state.settled = true;
        // `reset()`, or a waiter that gave up on us, may have dropped this
        // attempt while it ran. A dropped attempt must not report the memo
        // done — that is how a reset issued mid-init gets silently undone.
        if (current?.state !== state) return;
        succeeded = true;
        current = undefined;
      },
      (err: unknown) => {
        // A waiter reads "ran and failed" off `error`, so a nullish rejection
        // must not arrive there looking like a clean finish.
        state.error =
          err ?? new Error("Schema init rejected with a nullish value");
        state.settled = true;
        // Clearing the attempt is what keeps one transient failure from being
        // replayed to every later caller for the isolate's life.
        if (current?.state === state) current = undefined;
        throw err;
      },
    );
    current = { state, promise };
    keepAliveAcrossRequests(event, promise);
    return promise;
  };

  const memo = async (event?: unknown): Promise<void> => {
    if (succeeded) return;

    const inflight = current;
    if (inflight) {
      if (!isCrossRequestPromiseUnsafe()) return inflight.promise;

      const settled = await pollForValue(
        () => (inflight.state.settled ? inflight.state : undefined),
        { timeoutMs: waitMs },
      );
      if (settled) {
        if (settled.error !== undefined) throw settled.error;
        return;
      }
      // Timeout means "unknown", never "finished": the attempt we watched may
      // have been abandoned with its request. Run our own — the routines this
      // wraps are idempotent DDL, so a duplicate costs a round trip.
      if (current === inflight) current = undefined;
    }

    return start(event);
  };

  memo.reset = () => {
    succeeded = false;
    current = undefined;
  };

  return memo;
}
