import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  signInternalToken,
  verifyInternalToken,
} from "../integrations/internal-token.js";
import { buildBackgroundQueueMessage } from "./background-queue.js";
import {
  prepareProcessRunRequest,
  signBackgroundProcessorAuthorization,
} from "./durable-background.js";

/**
 * REPRO for the production hang on design.paulsjob.ai (2026-08-10): a durable
 * background run whose processor token was minted at ENQUEUE was rejected 401
 * by the processor it was queued for, because the queue had held the message
 * longer than the token lives. The consumer acked that 401, so the turn was
 * deleted having never executed while its run row still read `running`.
 *
 * The token's life is fixed and short; a queue's delivery latency is unbounded
 * by construction. The first case below pins that mismatch as the reason the
 * credential cannot travel on the envelope — it is the assertion that fails if
 * anyone reasons "five minutes is surely enough". The rest pin the fix.
 */

const ORIGIN = "https://design.example.com";
const TASK = "run-1786333164277-qtdj11";

/** internal-token.ts: MAX_AGE_MS. */
const TOKEN_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * The observed production gap: enqueued 03:39:24, delivered 03:48:02, while a
 * preceding run held the consumer. Cloudflare's own backlog metric shows the
 * queue draining across those seconds.
 */
const OBSERVED_QUEUE_LATENCY_MS = 518_000;

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

describe("durable background queue token vs. queue delivery latency", () => {
  it("proves an enqueue-time token is dead before a backlogged queue delivers it", () => {
    // Not a tautology and not about the crypto: this is the fact that makes
    // carrying a credential on the envelope unworkable at all.
    expect(OBSERVED_QUEUE_LATENCY_MS).toBeGreaterThan(TOKEN_MAX_AGE_MS);

    const mintedAtEnqueue = signInternalToken(TASK);
    vi.advanceTimersByTime(OBSERVED_QUEUE_LATENCY_MS);

    expect(verifyInternalToken(TASK, mintedAtEnqueue)).toBe(false);
  });

  it("REGRESSION: the envelope carries no credential to go stale", () => {
    const message = buildBackgroundQueueMessage({
      taskId: TASK,
      origin: ORIGIN,
    });

    // The producer must hand the consumer nothing it would be tempted to
    // present later. Re-adding an `authorization` (or any other Bearer-shaped
    // field) puts the expiry back on the wire, so assert on the whole envelope
    // rather than on one field name.
    expect(JSON.stringify(message)).not.toContain("Bearer");
    expect(message).not.toHaveProperty("authorization");
  });

  it("REGRESSION: signing at delivery authenticates after the same latency", () => {
    const message = buildBackgroundQueueMessage({
      taskId: TASK,
      origin: ORIGIN,
    });

    vi.advanceTimersByTime(OBSERVED_QUEUE_LATENCY_MS);

    // What the generated consumer does: mint now, then hand it to the
    // processor's own auth.
    const authorization = signBackgroundProcessorAuthorization(message.taskId);
    expect(
      prepareProcessRunRequest(
        { taskId: message.taskId },
        authorization ?? undefined,
      ),
    ).toMatchObject({ ok: true, runId: TASK });
  });

  it("REGRESSION: a run may outlive the token life without being unrunnable", () => {
    // A durable background run owns a 15-minute consumer invocation, so the
    // second and third runs behind a long first one were structurally doomed.
    const message = buildBackgroundQueueMessage({
      taskId: TASK,
      origin: ORIGIN,
    });

    vi.advanceTimersByTime(15 * 60 * 1000);

    const authorization = signBackgroundProcessorAuthorization(message.taskId);
    expect(
      prepareProcessRunRequest(
        { taskId: message.taskId },
        authorization ?? undefined,
      ),
    ).toMatchObject({ ok: true, runId: TASK });
  });
});
