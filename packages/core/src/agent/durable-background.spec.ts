import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { signInternalToken } from "../integrations/internal-token.js";
import { AGENT_BACKGROUND_QUEUE_BINDING } from "./background-queue.js";
import type { BackgroundDispatchTarget } from "./durable-background.js";
import {
  AGENT_BACKGROUND_FUNCTION_NAME,
  AGENT_BACKGROUND_FUNCTION_URL_PATH,
  AGENT_CHAT_PROCESS_RUN_PATH,
  AGENT_CHAT_BACKGROUND_RUN_FIELD,
  BACKGROUND_FUNCTION_UNREACHABLE_NOTICE_KEY,
  BACKGROUND_INVOCATION_SCOPE_BRIDGE_KEY,
  backgroundRuntimeDiagnosticDetail,
  backgroundRunMarkerExpectsBackgroundRuntime,
  dispatchPathTargetsNetlifyBackgroundFunction,
  extractProcessRunId,
  isAgentChatDurableBackgroundEnabled,
  isAgentChatForegroundSelfChainEnabled,
  isHostedRuntimeForDurableBackground,
  isNetlifyHostedRuntimeForDurableBackground,
  isInBackgroundFunctionRuntime,
  isInBackgroundInvocationScope,
  runInBackgroundInvocationScope,
  prepareProcessRunRequest,
  resolveAgentChatProcessRunDispatchPath,
  reportUnclaimedQueueBackgroundRunOnce,
  resolveBackgroundDispatchTarget,
  resolveDurableBackgroundDispatchPath,
  shouldUseBackgroundFunctionTimeoutForWorker,
  WORKERS_QUEUE_TRANSPORT_MISSING_NOTICE_KEY,
  WORKERS_QUEUE_UNCLAIMED_NOTICE_KEY,
} from "./durable-background.js";

/**
 * The single gate that decides whether a long agent-chat turn is routed through
 * the server-driven background worker. On deployed Netlify it is enabled by
 * default unless explicitly disabled; on other hosts it remains opt-in. These
 * tests pin the host, secret, and opt-out legs of that gate.
 */

// Env keys the gate reads, snapshotted/cleared so each case is isolated.
const ENV_KEYS = [
  "AGENT_CHAT_DURABLE_BACKGROUND",
  "AGENT_CHAT_FOREGROUND_SELF_CHAIN",
  "AGENT_CHAT_FORCE_BACKGROUND_RUNTIME",
  "A2A_SECRET",
  "NETLIFY",
  "NETLIFY_LOCAL",
  "SITE_ID",
  "AWS_LAMBDA_FUNCTION_NAME",
  "CF_PAGES",
  "VERCEL",
  "VERCEL_ENV",
  "RENDER",
  "FLY_APP_NAME",
  "K_SERVICE",
  "AGENT_NATIVE_WORKSPACE_APP_ID",
] as const;

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  // Snapshot the whole env, then clear the keys the gate reads so each case is
  // isolated. Spread + Reflect.deleteProperty avoid dynamic `process.env[key]`
  // access (which guard:no-env-credentials forbids even in tests).
  saved = { ...process.env };
  for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
});

afterEach(() => {
  process.env = saved;
  Reflect.deleteProperty(
    globalThis as Record<string, unknown>,
    "__AGENT_NATIVE_BACKGROUND_RUNTIME__",
  );
  Reflect.deleteProperty(
    globalThis as Record<string, unknown>,
    BACKGROUND_FUNCTION_UNREACHABLE_NOTICE_KEY,
  );
  Reflect.deleteProperty(globalThis as Record<string, unknown>, "__cf_env");
  Reflect.deleteProperty(
    globalThis as Record<string, unknown>,
    WORKERS_QUEUE_TRANSPORT_MISSING_NOTICE_KEY,
  );
  Reflect.deleteProperty(
    globalThis as Record<string, unknown>,
    WORKERS_QUEUE_UNCLAIMED_NOTICE_KEY,
  );
});

/** Mark the runtime as hosted (Netlify, not local). */
function makeHosted() {
  process.env.NETLIFY = "true";
}

/**
 * Stand in for the Cloudflare Workers runtime the same way the generated Worker
 * entry does: it assigns the platform env onto `globalThis.__cf_env`, which is
 * the signal `isCloudflareRuntime()` (shared/runtime.ts) reads. Nothing here
 * distinguishes `wrangler dev` from a deployed Worker — that is the point.
 */
function makeCloudflareWorkersRuntime(options?: {
  withQueue?: boolean;
  binding?: unknown;
}) {
  if (options && "binding" in options) {
    (globalThis as Record<string, unknown>).__cf_env = {
      [AGENT_BACKGROUND_QUEUE_BINDING]: options.binding,
    };
    return;
  }
  (globalThis as Record<string, unknown>).__cf_env = options?.withQueue
    ? { [AGENT_BACKGROUND_QUEUE_BINDING]: { send: async () => {} } }
    : {};
}

describe("durable-background constants", () => {
  it("exposes the process-run route + marker field used by both sides", () => {
    expect(AGENT_CHAT_PROCESS_RUN_PATH).toBe(
      "/_agent-native/agent-chat/_process-run",
    );
    expect(AGENT_CHAT_BACKGROUND_RUN_FIELD).toBe("__backgroundRun");
  });
});

describe("isAgentChatDurableBackgroundEnabled (Netlify default-on gate)", () => {
  it("is OFF with nothing configured (not hosted, no secret — gates compose)", () => {
    expect(isAgentChatDurableBackgroundEnabled()).toBe(false);
  });

  it("is ON BY DEFAULT when deployed on Netlify with a secret", () => {
    makeHosted();
    process.env.A2A_SECRET = "shhh";
    delete process.env.AGENT_CHAT_DURABLE_BACKGROUND;
    expect(isAgentChatDurableBackgroundEnabled()).toBe(true);
  });

  it("does not require an app plugin opt-in on deployed Netlify", () => {
    makeHosted();
    process.env.A2A_SECRET = "shhh";
    delete process.env.AGENT_CHAT_DURABLE_BACKGROUND;
    expect(isAgentChatDurableBackgroundEnabled({ appOptIn: true })).toBe(true);
  });

  it("is ON when a workspace app opts in through plugin options (hosted + secret)", () => {
    makeHosted();
    process.env.A2A_SECRET = "shhh";
    process.env.AGENT_NATIVE_WORKSPACE_APP_ID = "design";
    delete process.env.AGENT_CHAT_DURABLE_BACKGROUND;
    expect(isAgentChatDurableBackgroundEnabled({ appOptIn: true })).toBe(true);
  });

  it("stays ON for truthy flag values (hosted + secret)", () => {
    makeHosted();
    process.env.A2A_SECRET = "shhh";
    for (const val of ["1", "true", "yes", "on", " TRUE "]) {
      process.env.AGENT_CHAT_DURABLE_BACKGROUND = val;
      expect(isAgentChatDurableBackgroundEnabled()).toBe(true);
    }
  });

  it("lets an explicit app opt-out override a stale deploy-wide flag", () => {
    makeHosted();
    process.env.A2A_SECRET = "shhh";
    process.env.AGENT_CHAT_DURABLE_BACKGROUND = "true";
    expect(isAgentChatDurableBackgroundEnabled({ appOptIn: false })).toBe(
      false,
    );
  });

  it("is OFF for explicit falsy flag values", () => {
    makeHosted();
    process.env.A2A_SECRET = "shhh";
    for (const val of ["0", "false", "no", "off", "FALSE", " Off "]) {
      process.env.AGENT_CHAT_DURABLE_BACKGROUND = val;
      expect(isAgentChatDurableBackgroundEnabled()).toBe(false);
    }
  });

  it("stays ON for empty or unrecognized values because only explicit false opts out", () => {
    makeHosted();
    process.env.A2A_SECRET = "shhh";
    for (const val of ["", "maybe"]) {
      process.env.AGENT_CHAT_DURABLE_BACKGROUND = val;
      expect(isAgentChatDurableBackgroundEnabled()).toBe(true);
    }
  });

  it("is OFF by default on other hosted runtimes", () => {
    process.env.VERCEL = "1";
    process.env.A2A_SECRET = "shhh";
    expect(isNetlifyHostedRuntimeForDurableBackground()).toBe(false);
    expect(isAgentChatDurableBackgroundEnabled()).toBe(false);
  });

  it("lets an explicit false env flag disable workspace app opt-in", () => {
    makeHosted();
    process.env.A2A_SECRET = "shhh";
    process.env.AGENT_NATIVE_WORKSPACE_APP_ID = "design";
    process.env.AGENT_CHAT_DURABLE_BACKGROUND = "false";
    expect(isAgentChatDurableBackgroundEnabled({ appOptIn: true })).toBe(false);
  });

  it("stays OFF when opted in but NOT hosted (local dev keeps inline path)", () => {
    process.env.AGENT_CHAT_DURABLE_BACKGROUND = "true";
    process.env.A2A_SECRET = "shhh";
    expect(isHostedRuntimeForDurableBackground()).toBe(false);
    expect(isAgentChatDurableBackgroundEnabled()).toBe(false);
    expect(isAgentChatDurableBackgroundEnabled({ appOptIn: true })).toBe(false);
  });

  it("stays OFF when opted in + hosted but A2A_SECRET is missing", () => {
    process.env.AGENT_CHAT_DURABLE_BACKGROUND = "true";
    makeHosted();
    expect(isAgentChatDurableBackgroundEnabled()).toBe(false);
    expect(isAgentChatDurableBackgroundEnabled({ appOptIn: true })).toBe(false);
  });

  it("treats NETLIFY_LOCAL=true as NOT hosted (netlify dev), even when opted in", () => {
    process.env.AGENT_CHAT_DURABLE_BACKGROUND = "true";
    process.env.A2A_SECRET = "shhh";
    process.env.NETLIFY = "true";
    process.env.NETLIFY_LOCAL = "true";
    expect(isHostedRuntimeForDurableBackground()).toBe(false);
    expect(isAgentChatDurableBackgroundEnabled()).toBe(false);
  });

  it("treats Netlify's runtime-only SITE_ID as hosted", () => {
    process.env.AGENT_CHAT_DURABLE_BACKGROUND = "true";
    process.env.A2A_SECRET = "shhh";
    process.env.SITE_ID = "00000000-0000-0000-0000-000000000000"; // guard:allow-env-credential -- fake value exercises Netlify's public runtime host marker.
    expect(isHostedRuntimeForDurableBackground()).toBe(true);
    expect(isAgentChatDurableBackgroundEnabled()).toBe(true);
  });

  it("keeps SITE_ID local under netlify dev", () => {
    process.env.AGENT_CHAT_DURABLE_BACKGROUND = "true";
    process.env.A2A_SECRET = "shhh";
    process.env.SITE_ID = "00000000-0000-0000-0000-000000000000"; // guard:allow-env-credential -- fake value exercises Netlify's public runtime host marker.
    process.env.NETLIFY_LOCAL = "true";
    expect(isHostedRuntimeForDurableBackground()).toBe(false);
    expect(isAgentChatDurableBackgroundEnabled()).toBe(false);
  });

  it("lets NETLIFY=false roll back SITE_ID hosted detection", () => {
    process.env.AGENT_CHAT_DURABLE_BACKGROUND = "true";
    process.env.A2A_SECRET = "shhh";
    process.env.SITE_ID = "00000000-0000-0000-0000-000000000000"; // guard:allow-env-credential -- fake value exercises Netlify's public runtime host marker.
    process.env.NETLIFY = "false";
    expect(isHostedRuntimeForDurableBackground()).toBe(false);
    expect(isAgentChatDurableBackgroundEnabled()).toBe(false);
  });
});

describe("Cloudflare Workers counts as a hosted runtime", () => {
  it("is hosted on the Workers runtime with no Netlify/AWS env at all", () => {
    makeCloudflareWorkersRuntime();
    expect(isHostedRuntimeForDurableBackground()).toBe(true);
  });

  it("is hosted in the LOCAL Worker runtime — there is no local carve-out here", () => {
    // `wrangler dev` runs the real Worker runtime under the same constraints,
    // so unlike NETLIFY_LOCAL (a Node server) there is nothing to carve out.
    makeCloudflareWorkersRuntime();
    process.env.A2A_SECRET = "shhh";
    expect(isHostedRuntimeForDurableBackground()).toBe(true);
    expect(isAgentChatDurableBackgroundEnabled()).toBe(true);
  });

  it("opens the durable gate by default on Workers, like deployed Netlify", () => {
    makeCloudflareWorkersRuntime();
    process.env.A2A_SECRET = "shhh";
    Reflect.deleteProperty(process.env, "AGENT_CHAT_DURABLE_BACKGROUND");
    expect(isAgentChatDurableBackgroundEnabled()).toBe(true);
  });

  it("restores the inline streaming loop for the explicit env opt-out", () => {
    makeCloudflareWorkersRuntime();
    process.env.A2A_SECRET = "shhh";
    for (const val of ["0", "false", "no", "off", " Off "]) {
      process.env.AGENT_CHAT_DURABLE_BACKGROUND = val;
      expect(isAgentChatDurableBackgroundEnabled()).toBe(false);
    }
  });

  it("still needs A2A_SECRET on Workers (the HMAC handoff is not optional)", () => {
    makeCloudflareWorkersRuntime();
    Reflect.deleteProperty(process.env, "A2A_SECRET");
    expect(isAgentChatDurableBackgroundEnabled()).toBe(false);
  });

  it("leaves the Netlify-only default-on predicate alone", () => {
    makeCloudflareWorkersRuntime();
    expect(isNetlifyHostedRuntimeForDurableBackground()).toBe(false);
  });

  it("reports ONCE per isolate that the durable gate is open with nothing to hand off to", () => {
    // Nothing on this trunk resolves to a durable transport yet, so an enabled
    // gate on Workers hands the run to the in-process route: a real inline run,
    // on the foreground clamp, not the budget the gate promised. Netlify's own
    // notice keys off its function url and can never fire here, so a silent
    // degrade is exactly what this replaces.
    makeCloudflareWorkersRuntime();
    process.env.A2A_SECRET = "shhh";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(resolveAgentChatProcessRunDispatchPath()).toBe(
      AGENT_CHAT_PROCESS_RUN_PATH,
    );
    resolveDurableBackgroundDispatchPath("/whatever");

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("executes inline");
    errorSpy.mockRestore();
  });

  it("stays quiet when the gate is closed on Workers (an inline run was asked for)", () => {
    makeCloudflareWorkersRuntime();
    process.env.A2A_SECRET = "shhh";
    process.env.AGENT_CHAT_DURABLE_BACKGROUND = "false";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    resolveAgentChatProcessRunDispatchPath();

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("resolves the queue transport once the producer binding is bound", () => {
    makeCloudflareWorkersRuntime({ withQueue: true });
    process.env.A2A_SECRET = "shhh";
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(resolveBackgroundDispatchTarget()).toEqual({
        kind: "queue",
        expectsBackgroundRuntime: true,
      });
      // Nothing to report: the transport this notice exists for now exists.
      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("keeps the in-process route when the caller opted out, binding or not", () => {
    makeCloudflareWorkersRuntime({ withQueue: true });
    process.env.A2A_SECRET = "shhh";
    expect(
      resolveBackgroundDispatchTarget({ durableBackground: false }),
    ).toEqual({
      kind: "inline-route",
      path: AGENT_CHAT_PROCESS_RUN_PATH,
      expectsBackgroundRuntime: false,
    });
  });

  it("leaves hosted Netlify on its http transport even with a queue bound", () => {
    // Criterion: the Netlify path does not change when Cloudflare gains one.
    makeHosted();
    makeCloudflareWorkersRuntime({ withQueue: true });
    process.env.A2A_SECRET = "shhh";
    expect(resolveBackgroundDispatchTarget()).toEqual({
      kind: "http",
      path: AGENT_BACKGROUND_FUNCTION_URL_PATH,
      expectsBackgroundRuntime: true,
    });
  });

  it("reports a queue run no consumer claimed ONCE per isolate", () => {
    // NOT the same condition as a failed send: this one succeeded into a void,
    // which nothing else would ever surface because the circuit breaker
    // recovers the run inline and the user sees a working turn.
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      reportUnclaimedQueueBackgroundRunOnce("runId=run_1");
      reportUnclaimedQueueBackgroundRunOnce("runId=run_2");

      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain("consumer");
      expect(String(errors.mock.calls[0]?.[0])).toContain("run_1");
    } finally {
      errors.mockRestore();
    }
  });

  it("publishes the invocation-scope entry point the generated consumer needs", async () => {
    // The emitted Worker entry lives outside this module graph and must enter
    // THIS AsyncLocalStorage instance, or the run silently takes the clamp it
    // was queued to escape.
    const enter = (globalThis as Record<string, unknown>)[
      BACKGROUND_INVOCATION_SCOPE_BRIDGE_KEY
    ] as (callback: () => Promise<boolean>) => Promise<boolean>;
    expect(typeof enter).toBe("function");
    expect(await enter(async () => isInBackgroundInvocationScope())).toBe(true);
  });

  it("stays quiet off the Workers runtime", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    resolveAgentChatProcessRunDispatchPath();

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

describe("per-invocation background budget scope (Cloudflare Workers)", () => {
  it("is out of scope by default", () => {
    expect(isInBackgroundInvocationScope()).toBe(false);
  });

  it("lifts the long budget for the invocation that entered the scope", async () => {
    makeCloudflareWorkersRuntime();
    const inside = await runInBackgroundInvocationScope(async () => {
      await Promise.resolve();
      return shouldUseBackgroundFunctionTimeoutForWorker(null);
    });
    expect(inside).toBe(true);
    expect(shouldUseBackgroundFunctionTimeoutForWorker(null)).toBe(false);
  });

  it("hides the long budget from a CONCURRENT foreground invocation in the same isolate", async () => {
    // THE case an isolate-level marker gets wrong. One Worker isolate serves a
    // queue invocation and a fetch invocation at once; a global set by the queue
    // invocation would let this foreground turn take the 15-minute budget and
    // then be killed when its client disconnects. Sequential tests never see it,
    // so construct the overlap explicitly: the background invocation parks
    // mid-await while the foreground invocation asks the same question.
    makeCloudflareWorkersRuntime();
    let backgroundIsParked!: () => void;
    const parked = new Promise<void>((resolve) => {
      backgroundIsParked = resolve;
    });
    let resumeBackground!: () => void;
    const resume = new Promise<void>((resolve) => {
      resumeBackground = resolve;
    });

    const background = runInBackgroundInvocationScope(async () => {
      const beforePark = shouldUseBackgroundFunctionTimeoutForWorker(null);
      backgroundIsParked();
      await resume;
      return {
        beforePark,
        afterResume: shouldUseBackgroundFunctionTimeoutForWorker(null),
      };
    });

    await parked;
    const foregroundSaw = {
      inScope: isInBackgroundInvocationScope(),
      longBudget: shouldUseBackgroundFunctionTimeoutForWorker(null),
      runtime: isInBackgroundFunctionRuntime(),
    };
    resumeBackground();

    expect(await background).toEqual({ beforePark: true, afterResume: true });
    expect(foregroundSaw).toEqual({
      inScope: false,
      longBudget: false,
      runtime: false,
    });
  });

  it("ignores isolate-wide background signals on the Workers runtime", () => {
    // The globalThis marker and the Lambda function name are per-isolate facts.
    // On a host where one isolate serves concurrent invocations they cannot
    // prove anything about THIS invocation, so on Workers the scope is the only
    // signal that may lift the clamp.
    makeCloudflareWorkersRuntime();
    (
      globalThis as Record<string, unknown>
    ).__AGENT_NATIVE_BACKGROUND_RUNTIME__ = true;
    process.env.AWS_LAMBDA_FUNCTION_NAME = "server-agent-background";
    process.env.AGENT_CHAT_FORCE_BACKGROUND_RUNTIME = "true";
    expect(isInBackgroundFunctionRuntime()).toBe(false);
    expect(shouldUseBackgroundFunctionTimeoutForWorker(null)).toBe(false);
  });

  it("leaves the isolate-level marker intact for the host it was written for", () => {
    // No Workers runtime: Netlify's emitted background entry still marks its own
    // isolate at cold start and that marker still lifts the clamp, unchanged.
    (
      globalThis as Record<string, unknown>
    ).__AGENT_NATIVE_BACKGROUND_RUNTIME__ = true;
    expect(isInBackgroundInvocationScope()).toBe(false);
    expect(isInBackgroundFunctionRuntime()).toBe(true);
    expect(shouldUseBackgroundFunctionTimeoutForWorker(null)).toBe(true);
  });

  it("reports the scope in the runtime diagnostic detail", () => {
    makeCloudflareWorkersRuntime();
    const detail = runInBackgroundInvocationScope(() =>
      backgroundRuntimeDiagnosticDetail(null),
    );
    expect(detail).toContain("invocationScope=true");
    expect(detail).toContain("runtimeDetected=true");
    expect(backgroundRuntimeDiagnosticDetail(null)).toContain(
      "invocationScope=false",
    );
  });
});

describe("isAgentChatForegroundSelfChainEnabled (default-off opt-in gate)", () => {
  it("is OFF with nothing configured", () => {
    expect(isAgentChatForegroundSelfChainEnabled()).toBe(false);
  });

  it("stays OFF by default when hosted + secret are present", () => {
    makeHosted();
    process.env.A2A_SECRET = "shhh";
    delete process.env.AGENT_CHAT_FOREGROUND_SELF_CHAIN;
    expect(isAgentChatForegroundSelfChainEnabled()).toBe(false);
  });

  it("is ON for explicit truthy flag values (hosted + secret)", () => {
    makeHosted();
    process.env.A2A_SECRET = "shhh";
    for (const val of ["1", "true", "yes", "on", " TRUE "]) {
      process.env.AGENT_CHAT_FOREGROUND_SELF_CHAIN = val;
      expect(isAgentChatForegroundSelfChainEnabled()).toBe(true);
    }
  });

  it("is OFF for falsy, empty, or unrecognized flag values", () => {
    makeHosted();
    process.env.A2A_SECRET = "shhh";
    for (const val of [
      "0",
      "false",
      "no",
      "off",
      "FALSE",
      " Off ",
      "",
      "maybe",
    ]) {
      process.env.AGENT_CHAT_FOREGROUND_SELF_CHAIN = val;
      expect(isAgentChatForegroundSelfChainEnabled()).toBe(false);
    }
  });

  it("stays OFF when opted in but NOT hosted (local dev keeps the inline path)", () => {
    process.env.AGENT_CHAT_FOREGROUND_SELF_CHAIN = "true";
    process.env.A2A_SECRET = "shhh";
    expect(isAgentChatForegroundSelfChainEnabled()).toBe(false);
  });

  it("stays OFF when opted in + hosted but A2A_SECRET is missing (HMAC required)", () => {
    process.env.AGENT_CHAT_FOREGROUND_SELF_CHAIN = "true";
    makeHosted();
    expect(isAgentChatForegroundSelfChainEnabled()).toBe(false);
  });

  it("can be explicitly disabled independently of AGENT_CHAT_DURABLE_BACKGROUND", () => {
    makeHosted();
    process.env.A2A_SECRET = "shhh";
    process.env.AGENT_CHAT_FOREGROUND_SELF_CHAIN = "true";
    process.env.AGENT_CHAT_DURABLE_BACKGROUND = "false";
    expect(isAgentChatForegroundSelfChainEnabled()).toBe(true);
    expect(isAgentChatDurableBackgroundEnabled()).toBe(false);

    process.env.AGENT_CHAT_DURABLE_BACKGROUND = "true";
    process.env.AGENT_CHAT_FOREGROUND_SELF_CHAIN = "false";
    expect(isAgentChatForegroundSelfChainEnabled()).toBe(false);
    expect(isAgentChatDurableBackgroundEnabled()).toBe(true);
  });
});

describe("isInBackgroundFunctionRuntime (real -background function guard)", () => {
  it("is false with nothing set (a plain synchronous function)", () => {
    expect(isInBackgroundFunctionRuntime()).toBe(false);
  });

  it("is false for a normal synchronous Netlify/Lambda function name", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "server";
    expect(isInBackgroundFunctionRuntime()).toBe(false);
    process.env.AWS_LAMBDA_FUNCTION_NAME = "plan-server";
    expect(isInBackgroundFunctionRuntime()).toBe(false);
  });

  it("is TRUE when the Lambda function name ends in -background (15-min budget)", () => {
    // Matches the emitted names: "server-agent-background" (single template)
    // and "<app>-agent-background" (workspace deploy).
    for (const name of [
      "server-agent-background",
      "plan-agent-background",
      "SERVER-AGENT-BACKGROUND",
    ]) {
      process.env.AWS_LAMBDA_FUNCTION_NAME = name;
      expect(isInBackgroundFunctionRuntime()).toBe(true);
    }
  });

  it("honors an explicit AGENT_CHAT_FORCE_BACKGROUND_RUNTIME override", () => {
    delete process.env.AWS_LAMBDA_FUNCTION_NAME;
    for (const v of ["1", "true", "yes", "on", " TRUE "]) {
      process.env.AGENT_CHAT_FORCE_BACKGROUND_RUNTIME = v;
      expect(isInBackgroundFunctionRuntime()).toBe(true);
    }
    for (const v of ["0", "false", "no", "off", ""]) {
      process.env.AGENT_CHAT_FORCE_BACKGROUND_RUNTIME = v;
      expect(isInBackgroundFunctionRuntime()).toBe(false);
    }
  });
});

describe("background runtime marker diagnostics", () => {
  it("derives marker expectation from the concrete dispatch path", () => {
    expect(
      dispatchPathTargetsNetlifyBackgroundFunction(
        "/.netlify/functions/design-agent-background",
      ),
    ).toBe(true);
    expect(
      dispatchPathTargetsNetlifyBackgroundFunction(
        "/_agent-native/agent-chat/_process-run",
      ),
    ).toBe(false);
  });

  it("does not use the long background timeout from the dispatch marker alone", () => {
    const marker = { backgroundFunctionRuntimeExpected: true };

    expect(isInBackgroundFunctionRuntime()).toBe(false);
    expect(backgroundRunMarkerExpectsBackgroundRuntime(marker)).toBe(true);
    expect(shouldUseBackgroundFunctionTimeoutForWorker(marker)).toBe(false);
    expect(backgroundRuntimeDiagnosticDetail(marker)).toContain(
      "markerExpected=true",
    );
    expect(backgroundRuntimeDiagnosticDetail(marker)).toContain(
      "runtimeDetected=false",
    );
  });

  it("reports a missing background function ONCE per isolate", () => {
    const marker = { backgroundFunctionRuntimeExpected: true };
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      backgroundRuntimeDiagnosticDetail(marker);
      backgroundRuntimeDiagnosticDetail(marker);

      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain(
        AGENT_BACKGROUND_FUNCTION_NAME,
      );
    } finally {
      errors.mockRestore();
    }
  });

  it("stays quiet when the worker really is in the background function", () => {
    (
      globalThis as Record<string, unknown>
    ).__AGENT_NATIVE_BACKGROUND_RUNTIME__ = true;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      backgroundRuntimeDiagnosticDetail({
        backgroundFunctionRuntimeExpected: true,
      });

      expect(errors).not.toHaveBeenCalled();
    } finally {
      errors.mockRestore();
    }
  });

  it("uses the long background timeout when the background function entry marked the runtime", () => {
    (
      globalThis as Record<string, unknown>
    ).__AGENT_NATIVE_BACKGROUND_RUNTIME__ = true;

    expect(isInBackgroundFunctionRuntime()).toBe(true);
    expect(shouldUseBackgroundFunctionTimeoutForWorker(null)).toBe(true);
    expect(backgroundRuntimeDiagnosticDetail(null)).toContain(
      "runtimeDetected=true",
    );
    expect(backgroundRuntimeDiagnosticDetail(null)).toContain(
      "globalMarker=true",
    );
  });

  it("does not use the long background timeout for unmarked synchronous re-entry", () => {
    expect(shouldUseBackgroundFunctionTimeoutForWorker(null)).toBe(false);
    expect(backgroundRuntimeDiagnosticDetail(null)).toContain(
      "markerExpected=false",
    );
  });
});

describe("resolveAgentChatProcessRunDispatchPath (default function url on hosted Netlify)", () => {
  it("exposes the background function name + its default function url constant", () => {
    expect(AGENT_BACKGROUND_FUNCTION_NAME).toBe("server-agent-background");
    expect(AGENT_BACKGROUND_FUNCTION_URL_PATH).toBe(
      "/.netlify/functions/server-agent-background",
    );
    // Name MUST end in -background (Netlify async convention + runtime guard).
    expect(AGENT_BACKGROUND_FUNCTION_NAME.endsWith("-background")).toBe(true);
  });

  it("dispatches to the function's DEFAULT url on hosted Netlify (single template)", () => {
    // DOC-CORRECT: the background function declares NO custom config.path, so it
    // keeps its default url /.netlify/functions/<name>. The `server` /* catch-all
    // already excludes /.netlify/*, so a POST to that default url matches ONLY the
    // async function (202, 15-min) — it is never shadowed by the sync function.
    process.env.NETLIFY = "true";
    expect(resolveAgentChatProcessRunDispatchPath()).toBe(
      AGENT_BACKGROUND_FUNCTION_URL_PATH,
    );
    expect(resolveAgentChatProcessRunDispatchPath()).toBe(
      "/.netlify/functions/server-agent-background",
    );
  });

  it("dispatches to the function's DEFAULT url in deployed Netlify Lambda runtime even when NETLIFY is absent", () => {
    // Production Functions do not always preserve the build-time NETLIFY env
    // flag, but they do expose AWS_LAMBDA_FUNCTION_NAME. The durable dispatcher
    // must still target the emitted Netlify background function; the worker
    // entry's runtime marker unlocks the 15-minute budget after dispatch lands.
    process.env.AWS_LAMBDA_FUNCTION_NAME = "agent-native-design-server";
    expect(resolveAgentChatProcessRunDispatchPath()).toBe(
      AGENT_BACKGROUND_FUNCTION_URL_PATH,
    );
  });

  it("dispatches to the function's DEFAULT url in the modern Netlify runtime", () => {
    // NETLIFY is build-only. Deployed Functions document SITE_ID as a runtime
    // read-only variable even when Lambda compatibility variables are absent.
    process.env.SITE_ID = "00000000-0000-0000-0000-000000000000"; // guard:allow-env-credential -- fake value exercises Netlify's public runtime host marker.
    expect(resolveAgentChatProcessRunDispatchPath()).toBe(
      AGENT_BACKGROUND_FUNCTION_URL_PATH,
    );
  });

  it("dispatches to the PER-APP default url on hosted Netlify (workspace)", () => {
    // Workspace deploy emits one background fn per app named <app>-agent-background
    // reachable at its default url. The foreground reads the workspace app id from
    // AGENT_NATIVE_WORKSPACE_APP_ID and resolves the matching function url.
    process.env.NETLIFY = "true";
    process.env.AGENT_NATIVE_WORKSPACE_APP_ID = "plan";
    expect(resolveAgentChatProcessRunDispatchPath()).toBe(
      "/.netlify/functions/plan-agent-background",
    );
    Reflect.deleteProperty(process.env, "AGENT_NATIVE_WORKSPACE_APP_ID");
  });

  it("dispatches to the PER-APP default url in workspace Lambda runtime even when NETLIFY is absent", () => {
    process.env.AWS_LAMBDA_FUNCTION_NAME = "agent-native-workspace-design";
    process.env.AGENT_NATIVE_WORKSPACE_APP_ID = "design";
    expect(resolveAgentChatProcessRunDispatchPath()).toBe(
      "/.netlify/functions/design-agent-background",
    );
    Reflect.deleteProperty(process.env, "AGENT_NATIVE_WORKSPACE_APP_ID");
  });

  it("falls back to the single-template default url for an unsafe workspace app id", () => {
    process.env.NETLIFY = "true";
    process.env.AGENT_NATIVE_WORKSPACE_APP_ID = "../evil";
    expect(resolveAgentChatProcessRunDispatchPath()).toBe(
      AGENT_BACKGROUND_FUNCTION_URL_PATH,
    );
    Reflect.deleteProperty(process.env, "AGENT_NATIVE_WORKSPACE_APP_ID");
  });

  it("returns the framework process-run path when NOT on Netlify", () => {
    // Nothing set → not Netlify (e.g. local dev, Vercel, Cloudflare, self-host).
    // No second function exists; the in-process catch-all handles the route.
    expect(resolveAgentChatProcessRunDispatchPath()).toBe(
      AGENT_CHAT_PROCESS_RUN_PATH,
    );
  });

  it("uses a caller-provided fallback route outside Netlify", () => {
    expect(
      resolveDurableBackgroundDispatchPath(
        "/api/_agent-native-background/example",
      ),
    ).toBe("/api/_agent-native-background/example");
  });

  it("routes generic durable work to the emitted Netlify function", () => {
    process.env.NETLIFY = "true";
    expect(
      resolveDurableBackgroundDispatchPath(
        "/api/_agent-native-background/example",
      ),
    ).toBe(AGENT_BACKGROUND_FUNCTION_URL_PATH);
  });

  it("returns the framework path under `netlify dev` (NETLIFY_LOCAL=true)", () => {
    // `netlify dev` runs in-process; the same in-process catch-all handles it.
    process.env.NETLIFY = "true";
    process.env.NETLIFY_LOCAL = "true";
    process.env.AWS_LAMBDA_FUNCTION_NAME = "agent-native-design-server";
    expect(resolveAgentChatProcessRunDispatchPath()).toBe(
      AGENT_CHAT_PROCESS_RUN_PATH,
    );
  });

  it("returns the framework path when NETLIFY is explicitly false", () => {
    process.env.NETLIFY = "false";
    process.env.AWS_LAMBDA_FUNCTION_NAME = "agent-native-design-server";
    expect(resolveAgentChatProcessRunDispatchPath()).toBe(
      AGENT_CHAT_PROCESS_RUN_PATH,
    );
  });
});

describe("resolveBackgroundDispatchTarget (typed transport decision)", () => {
  it("resolves hosted Netlify to the http transport at the function's default url", () => {
    process.env.NETLIFY = "true";
    expect(resolveBackgroundDispatchTarget()).toEqual({
      kind: "http",
      path: AGENT_BACKGROUND_FUNCTION_URL_PATH,
      expectsBackgroundRuntime: true,
    });
  });

  it("resolves the workspace per-app function url on the http transport", () => {
    process.env.NETLIFY = "true";
    process.env.AGENT_NATIVE_WORKSPACE_APP_ID = "plan";
    expect(resolveBackgroundDispatchTarget()).toEqual({
      kind: "http",
      path: "/.netlify/functions/plan-agent-background",
      expectsBackgroundRuntime: true,
    });
  });

  it("resolves every other host to the portable in-process route", () => {
    expect(resolveBackgroundDispatchTarget()).toEqual({
      kind: "inline-route",
      path: AGENT_CHAT_PROCESS_RUN_PATH,
      expectsBackgroundRuntime: false,
    });
  });

  it("carries a caller-supplied fallback route onto the inline-route arm", () => {
    expect(
      resolveBackgroundDispatchTarget({
        fallbackPath: "/api/_agent-native-background/example",
      }),
    ).toEqual({
      kind: "inline-route",
      path: "/api/_agent-native-background/example",
      expectsBackgroundRuntime: false,
    });
  });

  it("ignores the caller fallback once a host transport is available", () => {
    process.env.NETLIFY = "true";
    expect(
      resolveBackgroundDispatchTarget({
        fallbackPath: "/api/_agent-native-background/example",
      }),
    ).toEqual({
      kind: "http",
      path: AGENT_BACKGROUND_FUNCTION_URL_PATH,
      expectsBackgroundRuntime: true,
    });
  });

  it("keeps the in-process route when the caller opts out of the durable transport", () => {
    // The continuation self-chain runs on the regular function unless the run
    // was already handed to the durable worker; opting out must not consult the
    // host at all.
    process.env.NETLIFY = "true";
    expect(
      resolveBackgroundDispatchTarget({ durableBackground: false }),
    ).toEqual({
      kind: "inline-route",
      path: AGENT_CHAT_PROCESS_RUN_PATH,
      expectsBackgroundRuntime: false,
    });
  });

  it("agrees with the path helpers it now backs", () => {
    for (const setup of [
      () => {},
      () => {
        process.env.NETLIFY = "true";
      },
      () => {
        process.env.SITE_ID = "00000000-0000-0000-0000-000000000000"; // guard:allow-env-credential -- fake value exercises Netlify's public runtime host marker.
      },
      () => {
        process.env.NETLIFY = "true";
        process.env.NETLIFY_LOCAL = "true";
      },
    ]) {
      for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
      setup();
      const target = resolveBackgroundDispatchTarget();
      expect(target.kind).not.toBe("queue");
      const path = (target as { path: string }).path;
      expect(resolveAgentChatProcessRunDispatchPath()).toBe(path);
      expect(
        resolveDurableBackgroundDispatchPath(AGENT_CHAT_PROCESS_RUN_PATH),
      ).toBe(path);
      expect(target.expectsBackgroundRuntime).toBe(
        dispatchPathTargetsNetlifyBackgroundFunction(path),
      );
    }
  });
});

/**
 * The full host permutation matrix for the ONE public resolver. Several arms
 * here are reachable by no live run at all: the incumbent host is only ever
 * exercised deployed, and the Workers end-to-end proof is excluded from CI, so
 * a transport-ordering change is invisible to every other form of verification
 * this repo has.
 */
const HOST_PERMUTATIONS: ReadonlyArray<{
  name: string;
  setup: () => void;
  target: BackgroundDispatchTarget;
}> = [
  {
    name: "Netlify deployed (build-time NETLIFY flag preserved)",
    setup: () => {
      process.env.NETLIFY = "true";
    },
    target: {
      kind: "http",
      path: AGENT_BACKGROUND_FUNCTION_URL_PATH,
      expectsBackgroundRuntime: true,
    },
  },
  {
    name: "Netlify deployed (modern runtime: SITE_ID only)",
    setup: () => {
      process.env.SITE_ID = "00000000-0000-0000-0000-000000000000"; // guard:allow-env-credential -- fake value exercises Netlify's public runtime host marker.
    },
    target: {
      kind: "http",
      path: AGENT_BACKGROUND_FUNCTION_URL_PATH,
      expectsBackgroundRuntime: true,
    },
  },
  {
    name: "Netlify deployed (Lambda compatibility: function name only)",
    setup: () => {
      process.env.AWS_LAMBDA_FUNCTION_NAME = "agent-native-design-server";
    },
    target: {
      kind: "http",
      path: AGENT_BACKGROUND_FUNCTION_URL_PATH,
      expectsBackgroundRuntime: true,
    },
  },
  {
    name: "Netlify local emulator (`netlify dev`)",
    setup: () => {
      process.env.NETLIFY = "true";
      process.env.NETLIFY_LOCAL = "true";
      process.env.AWS_LAMBDA_FUNCTION_NAME = "agent-native-design-server";
    },
    target: {
      kind: "inline-route",
      path: AGENT_CHAT_PROCESS_RUN_PATH,
      expectsBackgroundRuntime: false,
    },
  },
  {
    name: "Netlify explicitly disabled (NETLIFY=false)",
    setup: () => {
      process.env.NETLIFY = "false";
      process.env.AWS_LAMBDA_FUNCTION_NAME = "agent-native-design-server";
    },
    target: {
      kind: "inline-route",
      path: AGENT_CHAT_PROCESS_RUN_PATH,
      expectsBackgroundRuntime: false,
    },
  },
  {
    name: "Netlify workspace deploy (per-app background function)",
    setup: () => {
      process.env.NETLIFY = "true";
      process.env.AGENT_NATIVE_WORKSPACE_APP_ID = "plan";
    },
    target: {
      kind: "http",
      path: "/.netlify/functions/plan-agent-background",
      expectsBackgroundRuntime: true,
    },
  },
  {
    name: "Netlify workspace deploy with an unusable app id",
    setup: () => {
      process.env.NETLIFY = "true";
      process.env.AGENT_NATIVE_WORKSPACE_APP_ID = "../evil";
    },
    target: {
      kind: "http",
      path: AGENT_BACKGROUND_FUNCTION_URL_PATH,
      expectsBackgroundRuntime: true,
    },
  },
  {
    name: "Cloudflare Workers with the background queue bound",
    setup: () => {
      makeCloudflareWorkersRuntime({ withQueue: true });
    },
    target: { kind: "queue", expectsBackgroundRuntime: true },
  },
  {
    name: "Cloudflare Workers with NO queue binding",
    setup: () => {
      makeCloudflareWorkersRuntime();
      // The durable gate is open here (Workers defaults on, secret present), so
      // this is the arm that announces the lost long budget rather than taking
      // it silently.
      process.env.A2A_SECRET = "shhh";
    },
    target: {
      kind: "inline-route",
      path: AGENT_CHAT_PROCESS_RUN_PATH,
      expectsBackgroundRuntime: false,
    },
  },
  {
    // THE ordering case: the incumbent host keeps its background function even
    // when the newer transport is available and would answer. A change that
    // reorders the two degrades a host no live Workers run can ever exercise.
    name: "Netlify deployed with a Workers queue ALSO bound",
    setup: () => {
      process.env.NETLIFY = "true";
      makeCloudflareWorkersRuntime({ withQueue: true });
    },
    target: {
      kind: "http",
      path: AGENT_BACKGROUND_FUNCTION_URL_PATH,
      expectsBackgroundRuntime: true,
    },
  },
  {
    name: "Netlify workspace deploy with a Workers queue ALSO bound",
    setup: () => {
      process.env.NETLIFY = "true";
      process.env.AGENT_NATIVE_WORKSPACE_APP_ID = "plan";
      makeCloudflareWorkersRuntime({ withQueue: true });
    },
    target: {
      kind: "http",
      path: "/.netlify/functions/plan-agent-background",
      expectsBackgroundRuntime: true,
    },
  },
  {
    // `wrangler dev` sets the same platform env a deployed Worker does, so the
    // new runtime has no local-emulator arm to take — unlike the incumbent
    // host, which declines under `netlify dev`. Pinned because the asymmetry
    // reads like an oversight and is the obvious thing to "fix" in a refactor.
    name: "Cloudflare Workers local emulator (indistinguishable from deployed)",
    setup: () => {
      makeCloudflareWorkersRuntime({ withQueue: true });
      process.env.NETLIFY_LOCAL = "true";
    },
    target: { kind: "queue", expectsBackgroundRuntime: true },
  },
  {
    // The incumbent host declines under its own emulator, so the newer
    // transport is the one that answers here — the ONE arrangement in which
    // reaching the queue past a Netlify signal is the correct outcome.
    name: "Netlify local emulator with a Workers queue bound",
    setup: () => {
      process.env.NETLIFY = "true";
      process.env.NETLIFY_LOCAL = "true";
      makeCloudflareWorkersRuntime({ withQueue: true });
    },
    target: { kind: "queue", expectsBackgroundRuntime: true },
  },
  {
    // Per-app configuration is not itself a host signal: under the emulator it
    // selects nothing, rather than forcing the function path it names.
    name: "Netlify local emulator with a workspace app id set",
    setup: () => {
      process.env.NETLIFY = "true";
      process.env.NETLIFY_LOCAL = "true";
      process.env.AGENT_NATIVE_WORKSPACE_APP_ID = "plan";
    },
    target: {
      kind: "inline-route",
      path: AGENT_CHAT_PROCESS_RUN_PATH,
      expectsBackgroundRuntime: false,
    },
  },
  {
    // A binding that exists but cannot send is UNUSABLE, not present. It must
    // resolve the same as no binding at all rather than to a queue nobody
    // consumes — a handoff into a void is the failure this whole union exists
    // to keep loud.
    name: "Cloudflare Workers with a queue binding that cannot send",
    setup: () => {
      makeCloudflareWorkersRuntime({ binding: { notSend: true } });
    },
    target: {
      kind: "inline-route",
      path: AGENT_CHAT_PROCESS_RUN_PATH,
      expectsBackgroundRuntime: false,
    },
  },
  {
    name: "Cloudflare Workers, queue bound, workspace app id also set",
    setup: () => {
      makeCloudflareWorkersRuntime({ withQueue: true });
      process.env.AGENT_NATIVE_WORKSPACE_APP_ID = "plan";
    },
    target: { kind: "queue", expectsBackgroundRuntime: true },
  },
  {
    name: "neither host (local Node dev, or an unrecognised platform)",
    setup: () => {
      process.env.VERCEL = "1";
    },
    target: {
      kind: "inline-route",
      path: AGENT_CHAT_PROCESS_RUN_PATH,
      expectsBackgroundRuntime: false,
    },
  },
  {
    name: "no host signal at all",
    setup: () => {},
    target: {
      kind: "inline-route",
      path: AGENT_CHAT_PROCESS_RUN_PATH,
      expectsBackgroundRuntime: false,
    },
  },
];

describe("resolveBackgroundDispatchTarget host permutation matrix", () => {
  let consoleError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    // The Workers-without-queue arm reports its lost budget on stderr by
    // design; silence it here so the matrix output stays readable. The report
    // itself is asserted in its own case above.
    consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  for (const permutation of HOST_PERMUTATIONS) {
    it(`resolves ${permutation.name}`, () => {
      // `toEqual` on the whole target covers `expectsBackgroundRuntime` too —
      // the property the caller acts on to take the durable budget or stay on
      // the foreground clamp, which travels with the transport rather than
      // being re-derived from it.
      permutation.setup();
      expect(resolveBackgroundDispatchTarget()).toEqual(permutation.target);
    });

    it(`honours the caller opt-out on ${permutation.name}`, () => {
      permutation.setup();
      expect(
        resolveBackgroundDispatchTarget({ durableBackground: false }),
      ).toEqual({
        kind: "inline-route",
        path: AGENT_CHAT_PROCESS_RUN_PATH,
        expectsBackgroundRuntime: false,
      });
    });

    it(`keeps the caller fallback route under the opt-out on ${permutation.name}`, () => {
      permutation.setup();
      expect(
        resolveBackgroundDispatchTarget({
          durableBackground: false,
          fallbackPath: "/api/_agent-native-background/example",
        }),
      ).toEqual({
        kind: "inline-route",
        path: "/api/_agent-native-background/example",
        expectsBackgroundRuntime: false,
      });
    });
  }

  it("resolves the opt-out identically on every host in the matrix", () => {
    // The opt-out is a caller fact, not a host fact. Same value on every host
    // is what "no host is consulted" looks like from outside the resolver.
    const resolved = HOST_PERMUTATIONS.map((permutation) => {
      for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
      Reflect.deleteProperty(globalThis as Record<string, unknown>, "__cf_env");
      permutation.setup();
      return resolveBackgroundDispatchTarget({ durableBackground: false });
    });
    for (const target of resolved) {
      expect(target).toEqual(resolved[0]);
    }
  });

  it("reads no host signal at all under the opt-out", () => {
    // Stronger than the equality above: with the most host-signal-laden
    // environment this matrix can build, resolving the opt-out must touch none
    // of it — neither the env vars the incumbent host is detected by nor the
    // platform-env object the queue binding is resolved from.
    process.env.NETLIFY = "true";
    process.env.SITE_ID = "00000000-0000-0000-0000-000000000000"; // guard:allow-env-credential -- fake value exercises Netlify's public runtime host marker.
    process.env.AWS_LAMBDA_FUNCTION_NAME = "agent-native-design-server";
    process.env.AGENT_NATIVE_WORKSPACE_APP_ID = "plan";
    makeCloudflareWorkersRuntime({ withQueue: true });

    const { read, target } = recordHostSignalReads(() =>
      resolveBackgroundDispatchTarget({ durableBackground: false }),
    );
    expect(target).toEqual({
      kind: "inline-route",
      path: AGENT_CHAT_PROCESS_RUN_PATH,
      expectsBackgroundRuntime: false,
    });
    expect(read).toEqual([]);

    // Positive control: the recorder is live, so the empty list above is a real
    // observation and not a recorder that silently stopped working. Without a
    // caller opt-out the SAME environment is consulted.
    const consulted = recordHostSignalReads(() =>
      resolveBackgroundDispatchTarget(),
    );
    expect(consulted.target).toEqual({
      kind: "http",
      path: "/.netlify/functions/plan-agent-background",
      expectsBackgroundRuntime: true,
    });
    expect(consulted.read.length).toBeGreaterThan(0);
  });
});

/**
 * Run `resolve` with every readable host signal instrumented, and report which
 * ones it touched.
 *
 * `isCloudflareRuntime()` tests `"__cf_env" in globalThis`, and a bare `in` is
 * not interceptable — so the Workers side records the platform-env READ that
 * resolving the queue binding performs, which is the consultation that decides
 * the transport. `process.env` is swapped wholesale rather than per key because
 * a key the resolver reads and this list forgot would otherwise go unrecorded.
 */
function recordHostSignalReads<T>(resolve: () => T): {
  read: string[];
  target: T;
} {
  const read: string[] = [];
  const underlyingEnv = process.env;
  const scope = globalThis as Record<string, unknown>;
  const platformEnv = scope.__cf_env;
  process.env = new Proxy(underlyingEnv, {
    get(target, property) {
      if (typeof property === "string") read.push(`process.env.${property}`);
      return Reflect.get(target, property);
    },
  });
  Object.defineProperty(scope, "__cf_env", {
    configurable: true,
    get() {
      read.push("globalThis.__cf_env");
      return platformEnv;
    },
  });
  try {
    return { read, target: resolve() };
  } finally {
    process.env = underlyingEnv;
    Reflect.deleteProperty(scope, "__cf_env");
  }
}

describe("prepareProcessRunRequest (_process-run auth + marker prep)", () => {
  const RUN_ID = "run-bg-123";

  it("rejects a non-object body with 400 (no runId to attach diagnostics to)", () => {
    const r = prepareProcessRunRequest(null, undefined);
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "Invalid request body",
      runId: null,
    });
  });

  it("rejects a body with no runId/taskId with 400", () => {
    const r = prepareProcessRunRequest({ message: "hi" }, undefined);
    expect(r).toEqual({
      ok: false,
      status: 400,
      error: "runId required",
      runId: null,
    });
  });

  describe("with A2A_SECRET configured", () => {
    beforeEach(() => {
      process.env.A2A_SECRET = "test-secret";
    });

    it("rejects a missing/unsigned token with 401", () => {
      const r = prepareProcessRunRequest(
        { [AGENT_CHAT_BACKGROUND_RUN_FIELD]: { runId: RUN_ID } },
        undefined,
      );
      expect(r).toMatchObject({ ok: false, status: 401 });
    });

    it("carries the runId on a 401 so the route can record the auth failure", () => {
      // DIAGNOSTIC: an auth failure in the unreadable bg fn must still be
      // attributable to a run so /runs/active can show WHY it timed out.
      const r = prepareProcessRunRequest(
        { [AGENT_CHAT_BACKGROUND_RUN_FIELD]: { runId: RUN_ID } },
        "Bearer bogus",
      );
      expect(r).toMatchObject({ ok: false, status: 401, runId: RUN_ID });
    });

    it("rejects an invalid token with 401", () => {
      const r = prepareProcessRunRequest(
        { [AGENT_CHAT_BACKGROUND_RUN_FIELD]: { runId: RUN_ID } },
        "Bearer not-a-real-token",
      );
      expect(r).toMatchObject({ ok: false, status: 401 });
    });

    it("rejects a token signed for a DIFFERENT runId with 401", () => {
      const token = signInternalToken("some-other-run");
      const r = prepareProcessRunRequest(
        { [AGENT_CHAT_BACKGROUND_RUN_FIELD]: { runId: RUN_ID } },
        `Bearer ${token}`,
      );
      expect(r).toMatchObject({ ok: false, status: 401 });
    });

    it("accepts a valid token bound to the runId and preserves the marker", () => {
      const token = signInternalToken(RUN_ID);
      const r = prepareProcessRunRequest(
        {
          message: "do it",
          [AGENT_CHAT_BACKGROUND_RUN_FIELD]: {
            runId: RUN_ID,
            turnId: "turn-9",
          },
        },
        `Bearer ${token}`,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.runId).toBe(RUN_ID);
      expect(r.body[AGENT_CHAT_BACKGROUND_RUN_FIELD]).toMatchObject({
        runId: RUN_ID,
        turnId: "turn-9",
      });
    });

    it("injects the marker when only taskId is present (signed over taskId)", () => {
      const token = signInternalToken(RUN_ID);
      const r = prepareProcessRunRequest(
        { taskId: RUN_ID, message: "x" },
        `Bearer ${token}`,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.body[AGENT_CHAT_BACKGROUND_RUN_FIELD]).toEqual({
        runId: RUN_ID,
      });
    });
  });

  describe("without A2A_SECRET", () => {
    beforeEach(() => {
      delete process.env.A2A_SECRET;
    });

    it("refuses with 503 on a production runtime (never unsigned in prod)", () => {
      process.env.NETLIFY = "true";
      const r = prepareProcessRunRequest(
        { [AGENT_CHAT_BACKGROUND_RUN_FIELD]: { runId: RUN_ID } },
        undefined,
      );
      // Carries the runId so the route can record the "A2A_SECRET missing"
      // failure onto the run (otherwise it would time out with no clue).
      expect(r).toMatchObject({ ok: false, status: 503, runId: RUN_ID });
    });

    it("allows an unsigned dispatch in local dev (SQL claim is the guard)", () => {
      // No production env vars set in beforeEach's cleared environment.
      // Simulates the route handler seeing a loopback (127.0.0.1/::1) peer —
      // the real local-dev self-dispatch signal.
      const r = prepareProcessRunRequest(
        { [AGENT_CHAT_BACKGROUND_RUN_FIELD]: { runId: RUN_ID } },
        undefined,
        true,
      );
      expect(r.ok).toBe(true);
      if (!r.ok) throw new Error("expected ok");
      expect(r.runId).toBe(RUN_ID);
    });

    it("refuses an unsigned dispatch that is NOT from loopback (fail closed)", () => {
      // No production env vars set, but the caller can't/doesn't establish
      // loopback — e.g. a non-loopback peer address, or a caller with no h3
      // `event` to check (loopback omitted, defaults to false).
      const r = prepareProcessRunRequest(
        { [AGENT_CHAT_BACKGROUND_RUN_FIELD]: { runId: RUN_ID } },
        undefined,
      );
      expect(r).toMatchObject({ ok: false, status: 503, runId: RUN_ID });
    });
  });
});

describe("extractProcessRunId (diagnostic runId parse without auth)", () => {
  const RUN_ID = "run-diag-1";

  it("reads runId from the background-run marker", () => {
    expect(
      extractProcessRunId({
        [AGENT_CHAT_BACKGROUND_RUN_FIELD]: { runId: RUN_ID },
      }),
    ).toBe(RUN_ID);
  });

  it("falls back to top-level taskId", () => {
    expect(extractProcessRunId({ taskId: RUN_ID })).toBe(RUN_ID);
  });

  it("prefers the marker runId over taskId", () => {
    expect(
      extractProcessRunId({
        taskId: "other",
        [AGENT_CHAT_BACKGROUND_RUN_FIELD]: { runId: RUN_ID },
      }),
    ).toBe(RUN_ID);
  });

  it("returns null for an unparseable / empty body (no auth performed)", () => {
    expect(extractProcessRunId(null)).toBeNull();
    expect(extractProcessRunId("nope")).toBeNull();
    expect(extractProcessRunId({})).toBeNull();
    expect(extractProcessRunId({ taskId: "" })).toBeNull();
    expect(
      extractProcessRunId({ [AGENT_CHAT_BACKGROUND_RUN_FIELD]: { runId: 5 } }),
    ).toBeNull();
  });
});
