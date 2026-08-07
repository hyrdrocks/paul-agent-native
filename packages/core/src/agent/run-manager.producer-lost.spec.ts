import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./run-store.js", () => ({
  insertRun: vi.fn(() => Promise.resolve()),
  insertRunEvent: vi.fn(() => Promise.resolve()),
  updateRunStatusIfRunning: vi.fn(() => Promise.resolve(true)),
  markRunAborted: vi.fn(() => Promise.resolve()),
  getRunAbortState: vi.fn(() => Promise.resolve({ aborted: false })),
  getRunStatus: vi.fn(() => Promise.resolve("running")),
  getRunEventsSince: vi.fn(() => Promise.resolve([])),
  getRunById: vi.fn(() => Promise.resolve(null)),
  getRunByThread: vi.fn(() => Promise.resolve(null)),
  getRunTurnRef: vi.fn(() => Promise.resolve(null)),
  markTurnAborted: vi.fn(() => Promise.resolve()),
  cleanupOldRuns: vi.fn(() => Promise.resolve()),
  updateRunHeartbeat: vi.fn(() => Promise.resolve()),
  bumpRunProgress: vi.fn(() => Promise.resolve()),
  setRunInFlightMarker: vi.fn(() => Promise.resolve()),
  reapIfStale: vi.fn(() => Promise.resolve(null)),
  reapUnclaimedBackgroundRun: vi.fn(() => Promise.resolve(false)),
  shouldRedispatchUnclaimedBackgroundRun: vi.fn(() => false),
  UNCLAIMED_BACKGROUND_RUN_REDISPATCH_BOUND_MS: 5 * 60_000,
  reconcileTerminalRunFromEvents: vi.fn(() => Promise.resolve(false)),
  ensureTerminalRunEvent: vi.fn(() => Promise.resolve()),
  getLastTerminalRunEvent: vi.fn(() => Promise.resolve(null)),
  resolveErroredRunTerminalEvent: vi.fn(() => ({
    event: { type: "error", error: "failed", recoverable: true },
    shouldPersist: false,
  })),
  setRunError: vi.fn(() => Promise.resolve()),
  setRunTerminalReason: vi.fn(() => Promise.resolve()),
  persistRunCheckpointEvent: vi.fn(() => Promise.resolve()),
  terminalEventForAbortReason: vi.fn(() => ({ type: "done" })),
  tryClaimRunSlot: vi.fn(() =>
    Promise.resolve({ claimed: true, activeRunId: null }),
  ),
}));

import {
  getActiveRunForThreadAsync,
  RUN_PRODUCER_SILENT_MS,
  resolveRunProducerState,
  startRun,
  subscribeToRun,
} from "./run-manager.js";
import { getRunById, getRunByThread, getRunEventsSince } from "./run-store.js";

/**
 * Model of the failure this file exists for: on Workers the isolate-global
 * `activeRuns` entry survives the request that created it, but the run's
 * timers and promise continuations are cancelled with that request's context.
 * Clearing the timers and then advancing the clock reproduces exactly that —
 * a still-`running` entry that nothing is executing.
 */
function loseTheProducingContext(byMs = RUN_PRODUCER_SILENT_MS + 5_000) {
  vi.clearAllTimers();
  vi.advanceTimersByTime(byMs);
}

/** Read an SSE stream to completion, or give up after `maxChunks`. */
async function drain(
  stream: ReadableStream<Uint8Array>,
  maxChunks = 8,
): Promise<{ text: string; closed: boolean }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let closed = false;
  for (let i = 0; i < maxChunks; i++) {
    const next = await reader.read();
    if (next.done) {
      closed = true;
      break;
    }
    text += decoder.decode(next.value);
  }
  await reader.cancel().catch(() => {});
  return { text, closed };
}

let started = 0;

function startNeverEndingRun(threadId: string) {
  const runId = `run-producer-lost-${++started}`;
  startRun(runId, threadId, () => new Promise<void>(() => {}));
  return runId;
}

describe("a run whose originating request has gone away", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("is a third state, distinct from in-flight and from terminal", () => {
    const now = 100_000;
    expect(
      resolveRunProducerState(
        { status: "running", lastProducerTickAt: now - 1_000 },
        now,
      ),
    ).toBe("in-flight");
    expect(
      resolveRunProducerState(
        {
          status: "running",
          lastProducerTickAt: now - RUN_PRODUCER_SILENT_MS - 1,
        },
        now,
      ),
    ).toBe("producer-lost");
    expect(
      resolveRunProducerState(
        {
          status: "completed",
          lastProducerTickAt: now - RUN_PRODUCER_SILENT_MS - 1,
        },
        now,
      ),
    ).toBe("terminal");
  });

  it("does not leave a subscriber attached to a buffer nothing will ever write to", async () => {
    const runId = startNeverEndingRun("thread-lost-subscribe");
    loseTheProducingContext();

    vi.mocked(getRunById).mockResolvedValue({
      id: runId,
      threadId: "thread-lost-subscribe",
      status: "aborted",
      startedAt: Date.now(),
      errorCode: null,
      errorDetail: null,
    } as never);
    vi.mocked(getRunEventsSince).mockResolvedValue([]);

    const stream = subscribeToRun(runId, 0);
    expect(stream).not.toBeNull();

    // The durable record is the thing still being written for this run, so it
    // is the thing the subscription must read. An in-memory subscription never
    // calls this at all — that is the hang.
    const drained = await vi.waitFor(async () => {
      const result = await drain(stream!);
      expect(result.closed).toBe(true);
      return result;
    });
    expect(getRunEventsSince).toHaveBeenCalledWith(runId, 0);
    expect(drained.text).toContain('"type":"done"');
  });

  it("still answers a live run from memory", async () => {
    const runId = startNeverEndingRun("thread-live-subscribe");
    // Well past the silence threshold, with the run's own timers left running.
    // Elapsed time alone must never make a healthy run look producer-lost.
    await vi.advanceTimersByTimeAsync(RUN_PRODUCER_SILENT_MS * 2);

    const stream = subscribeToRun(runId, 0);
    expect(stream).not.toBeNull();
    const reader = stream!.getReader();
    await reader.read(); // the in-memory stream opens with a ping
    await reader.cancel();

    expect(getRunEventsSince).not.toHaveBeenCalled();
    expect(getRunById).not.toHaveBeenCalled();
  });

  it("reports the durable heartbeat, never a synthesized fresh one", async () => {
    const threadId = "thread-lost-active";
    const runId = startNeverEndingRun(threadId);
    loseTheProducingContext();

    const durableHeartbeatAt = Date.now() - RUN_PRODUCER_SILENT_MS;
    vi.mocked(getRunByThread).mockResolvedValue({
      id: runId,
      threadId,
      turnId: runId,
      status: "running",
      startedAt: durableHeartbeatAt,
      heartbeatAt: durableHeartbeatAt,
      lastProgressAt: durableHeartbeatAt,
      dispatchMode: "foreground",
      terminalReason: null,
      diagStage: null,
      inFlightSince: null,
      errorCode: null,
      errorDetail: null,
    } as never);

    const active = await getActiveRunForThreadAsync(threadId);
    expect(active).not.toBeNull();
    // Not `Date.now()`. A heartbeat this isolate asserts rather than reads is
    // fresher than the durable one and disarms the stale-run detection above
    // it — the false success this AC excludes.
    expect(active!.heartbeatAt).toBe(durableHeartbeatAt);
    expect(active!.heartbeatAt).not.toBe(Date.now());
  });

  it("keeps the fresh in-memory heartbeat while the producer is still ticking", async () => {
    const threadId = "thread-live-active";
    const runId = startNeverEndingRun(threadId);
    await vi.advanceTimersByTimeAsync(RUN_PRODUCER_SILENT_MS * 2);

    vi.mocked(getRunByThread).mockResolvedValue({
      id: runId,
      threadId,
      turnId: runId,
      status: "running",
      startedAt: Date.now() - RUN_PRODUCER_SILENT_MS * 2,
      heartbeatAt: Date.now() - 1_000,
      lastProgressAt: null,
      dispatchMode: "foreground",
      terminalReason: null,
      diagStage: null,
      inFlightSince: null,
      errorCode: null,
      errorDetail: null,
    } as never);

    const active = await getActiveRunForThreadAsync(threadId);
    expect(active).not.toBeNull();
    expect(active!.status).toBe("running");
    expect(active!.heartbeatAt).toBe(Date.now());
  });
});
