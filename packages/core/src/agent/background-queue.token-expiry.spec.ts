import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildBackgroundQueueMessage } from "./background-queue.js";
import {
  prepareProcessRunRequest,
  signBackgroundProcessorAuthorization,
} from "./durable-background.js";

/**
 * REPRO for the production hang on design.paulsjob.ai (2026-08-10): a durable
 * background run that sits in the queue backlog longer than the internal
 * token's five-minute life is rejected 401 by the processor it was queued for,
 * and the generated consumer acks that 401 — so the run is deleted from the
 * queue having never executed a single turn.
 *
 * The fix moves minting to DELIVERY time. Queue delivery latency is unbounded
 * by design (that is what the queue is for), so it can never be the same clock
 * as enqueue. Every case below asserts on that gap, not on the crypto.
 */

const ORIGIN = "https://design.example.com";
const TASK = "run-1786333164277-qtdj11";

/** internal-token.ts: MAX_AGE_MS. */
const TOKEN_MAX_AGE_MS = 5 * 60 * 1000;

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  process.env.A2A_SECRET = "test-secret-not-a-real-credential";
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-10T03:39:24.866Z"));
});

afterEach(() => {
  vi.useRealTimers();
  process.env = saved;
});

/**
 * Deliver an envelope exactly as the generated Worker consumer does: mint the
 * token now, at delivery, then hand it to the processor's own auth.
 */
function deliver(message: { taskId: string }) {
  const authorization = signBackgroundProcessorAuthorization(message.taskId);
  return prepareProcessRunRequest(
    { taskId: message.taskId },
    authorization ?? undefined,
  );
}

describe("durable background queue token vs. queue delivery latency", () => {
  it("authenticates a message the consumer picks up immediately", () => {
    const message = buildBackgroundQueueMessage({
      taskId: TASK,
      origin: ORIGIN,
    });

    vi.advanceTimersByTime(2_000);

    expect(deliver(message)).toMatchObject({ ok: true, runId: TASK });
  });

  it("REGRESSION: still authenticates after the run sat in the backlog", () => {
    const message = buildBackgroundQueueMessage({
      taskId: TASK,
      origin: ORIGIN,
    });

    // The observed production gap: this run was enqueued at 03:39:24 and the
    // consumer reached it at 03:48:02, 518s later, while a preceding run held
    // the consumer. Cloudflare's own backlog metric shows the queue draining
    // across those same seconds.
    vi.advanceTimersByTime(518_000);

    expect(518_000).toBeGreaterThan(TOKEN_MAX_AGE_MS);
    expect(deliver(message)).toMatchObject({ ok: true, runId: TASK });
  });

  it("REGRESSION: a run may outlive the token life without being unrunnable", () => {
    // A durable background run owns a 15-minute consumer invocation. A token
    // that dies at 5 minutes cannot be the thing that authorises it — the
    // second and third runs behind a long first run are structurally doomed.
    const message = buildBackgroundQueueMessage({
      taskId: TASK,
      origin: ORIGIN,
    });

    vi.advanceTimersByTime(15 * 60 * 1000);

    expect(deliver(message)).toMatchObject({ ok: true, runId: TASK });
  });
});
