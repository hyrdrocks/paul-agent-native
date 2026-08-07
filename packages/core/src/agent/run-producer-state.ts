/**
 * How the run registry tells a live run from one nobody is executing.
 *
 * `activeRuns` in `run-manager.ts` is isolate-global, but a run's EXECUTION
 * belongs to the request context that started it. On Workers that context can
 * be cancelled independently of the isolate — workerd then drops the run's
 * timers and every continuation attached to its promises — and what is left
 * behind is a map entry that still reads `status: "running"` and will never
 * change again. Presence in the map is therefore not evidence of liveness, and
 * every reader that assumed it was is answering for a run nothing is producing.
 *
 * Kept in its own module, with no imports, for two reasons: the classifier is
 * pure and the registry it serves is not, and the release's capability probe
 * has to be able to ask a bare Node process this question without pulling in
 * the database client behind `run-manager.js`.
 */

/**
 * Cadence of a run's own heartbeat/abort/backstop timer, and so also the
 * cadence at which it stamps `lastProducerTickAt`. Producer liveness and the
 * durable heartbeat are written by the same timer so they cannot drift apart.
 */
export const RUN_HEARTBEAT_INTERVAL_MS = 1_500;

/**
 * How long a non-terminal run may go without a tick before its isolate stops
 * answering for it.
 *
 * Ten ticks, matching the ten-interval margin `RUN_STALE_MS` allows the same
 * timer's durable write: the in-memory view and the stale-run reaper must not
 * be able to disagree about whether a producer is still there.
 */
export const RUN_PRODUCER_SILENT_MS = 10 * RUN_HEARTBEAT_INTERVAL_MS;

/**
 * The three states an in-memory run entry can be in, kept distinct on purpose.
 *
 * `terminal` and `in-flight` are what the registry has always modelled.
 * `producer-lost` is the third. Collapsing it into either neighbour is a bug of
 * a specific shape: folded into `in-flight` the registry reports liveness it
 * does not have, folded into `terminal` it reports an outcome that never
 * happened.
 */
export type RunProducerState = "terminal" | "in-flight" | "producer-lost";

/** The part of a run entry this classification reads. */
export interface RunProducerSnapshot {
  status: string;
  /** When the run's own timer last fired, stamped from inside that timer. */
  lastProducerTickAt: number;
}

/**
 * Classify an in-memory run entry.
 *
 * Readers serving OTHER requests must call this before answering from the
 * registry. A `producer-lost` run is not that isolate's to describe: the
 * durable record is the only thing still being written for it, so callers defer
 * to SQL rather than reporting from a buffer that stopped moving — and never
 * synthesise a terminal outcome, because knowing the producer is gone is not
 * knowing how the run ended.
 */
export function resolveRunProducerState(
  run: RunProducerSnapshot,
  now: number = Date.now(),
): RunProducerState {
  if (run.status !== "running") return "terminal";
  return now - run.lastProducerTickAt > RUN_PRODUCER_SILENT_MS
    ? "producer-lost"
    : "in-flight";
}
