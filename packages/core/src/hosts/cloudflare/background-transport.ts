/**
 * The Cloudflare Queues durable background transport.
 *
 * This host has no url that carries its own long budget: a request-triggered
 * invocation is unbounded only while a client stays connected, and the
 * foreground returns immediately by design. A queue consumer invocation is the
 * equivalent budget (15 minutes of wall time, documented), so the handoff is a
 * queue send and the target carries no path.
 */

import {
  hasBoundBackgroundQueue,
  sendBackgroundQueueMessage,
} from "../../agent/background-queue.js";
import { registerBackgroundTransport } from "../../agent/background-transports.js";
import {
  AGENT_CHAT_DURABLE_BACKGROUND_ENV,
  isAgentChatDurableBackgroundEnabled,
  WORKERS_QUEUE_TRANSPORT_MISSING_NOTICE_KEY,
} from "../../agent/durable-background.js";
import { isCloudflareRuntime } from "../../shared/runtime.js";

/**
 * Declared behind the incumbent host's background function. Both can answer in
 * one process (a Worker build carries no Netlify env, but a test or a hybrid
 * deploy can present both), and the arrangement in which reaching this
 * transport past a live Netlify signal is correct is exactly the one where that
 * host declines for itself — under its own local emulator.
 */
const CLOUDFLARE_QUEUE_PRIORITY = 20;

/** Names the handoff mechanism: a message on a queue a consumer drains. */
const QUEUE_TRANSPORT_ID = "queue";

/**
 * The durable gate is open on this host but nothing resolves to the queue
 * transport, so the run goes to the in-process route: a real inline run on the
 * foreground clamp, not the durable budget the gate promised. That is exactly
 * the shape this whole feature exists to stop being silent about — an app can
 * otherwise lose the long budget for its entire lifetime while looking healthy.
 * Announce it once per isolate.
 */
function reportMissingQueueTransportOnce(): void {
  if (!isCloudflareRuntime()) return;
  if (!isAgentChatDurableBackgroundEnabled()) return;
  const scope = globalThis as Record<string, unknown>;
  if (scope[WORKERS_QUEUE_TRANSPORT_MISSING_NOTICE_KEY] === true) return;
  scope[WORKERS_QUEUE_TRANSPORT_MISSING_NOTICE_KEY] = true;
  console.error(
    "[agent-chat] durable background is enabled on the Cloudflare Workers runtime but no " +
      "queue transport is bound, so this run is dispatched to the in-process route and " +
      "executes inline under the foreground clamp — NOT on the durable background budget. " +
      `Bind the background queue, or set ${AGENT_CHAT_DURABLE_BACKGROUND_ENV}=false to ask ` +
      "for the inline streaming loop deliberately.",
  );
}

export function registerCloudflareBackgroundTransport(): void {
  registerBackgroundTransport({
    id: QUEUE_TRANSPORT_ID,
    priority: CLOUDFLARE_QUEUE_PRIORITY,
    // A queue send resolves once the message is written to disk — it proves the
    // producer works and says nothing about a consumer existing to claim it. A
    // missing consumer registration would otherwise be recovered inline and
    // never surface. See `reportUnclaimedQueueBackgroundRunOnce`.
    acknowledgesWithoutClaim: true,
    resolve() {
      // The binding's presence is the proof that a consumer exists to claim the
      // message, exactly as the emitted function's default url is on the other
      // host. A binding that cannot send is unusable, not present: it resolves
      // like no binding at all rather than to a queue nobody drains.
      if (hasBoundBackgroundQueue()) {
        return { kind: QUEUE_TRANSPORT_ID, expectsBackgroundRuntime: true };
      }
      reportMissingQueueTransportOnce();
      return null;
    },
    deliver: sendBackgroundQueueMessage,
  });
}
