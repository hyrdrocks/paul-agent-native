import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  type BackgroundTransport,
  backgroundTargetAcknowledgesWithoutClaim,
  deliverBackgroundHandoff,
  INLINE_ROUTE_TRANSPORT_ID,
  isDurableBackgroundTarget,
  listBackgroundTransports,
  registerBackgroundTransport,
  unregisterBackgroundTransport,
} from "./background-transports.js";
import {
  AGENT_CHAT_PROCESS_RUN_PATH,
  resolveBackgroundDispatchTarget,
} from "./durable-background.js";

/**
 * The registry itself, independent of which hosts happen to be in the tree.
 * `durable-background.spec.ts` pins what the REAL hosts resolve to; these cases
 * pin the rules that keep adding a host from changing that answer.
 */

const ENV_KEYS = [
  "NETLIFY",
  "NETLIFY_LOCAL",
  "SITE_ID",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AGENT_NATIVE_WORKSPACE_APP_ID",
  "AGENT_CHAT_DURABLE_BACKGROUND",
  "A2A_SECRET",
] as const;

const TEST_TRANSPORT_IDS = ["test-early", "test-late", "test-pathless"];

function testTransport(
  overrides: Partial<BackgroundTransport> & { id: string; priority: number },
): BackgroundTransport {
  return {
    acknowledgesWithoutClaim: false,
    resolve: () => ({
      kind: overrides.id,
      path: `/${overrides.id}`,
      expectsBackgroundRuntime: true,
    }),
    ...overrides,
  };
}

let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  for (const k of ENV_KEYS) Reflect.deleteProperty(process.env, k);
});

afterEach(() => {
  process.env = saved;
  for (const id of TEST_TRANSPORT_IDS) unregisterBackgroundTransport(id);
  Reflect.deleteProperty(globalThis as Record<string, unknown>, "__cf_env");
});

describe("both hosts join the registry as peers", () => {
  it("registers each host's transport with a declared priority", () => {
    const transports = listBackgroundTransports();
    // Registration is static at module load through the host barrel, which
    // `durable-background.ts` imports — a host that answers only when some
    // other importer happened to load the barrel first would be a host fact
    // inferred from module order.
    expect(transports.map((t) => t.id)).toEqual(["http", "queue"]);
    for (const transport of transports) {
      expect(Number.isFinite(transport.priority)).toBe(true);
    }
  });

  it("orders by declared priority, not by registration order", () => {
    // THE regression this registry exists to prevent: a host added later must
    // not be able to displace an existing one by registering (or being
    // bundled, or imported) after it.
    const [incumbent] = listBackgroundTransports();
    expect(incumbent).toBeDefined();
    registerBackgroundTransport(
      testTransport({ id: "test-early", priority: incumbent!.priority - 1 }),
    );
    registerBackgroundTransport(
      testTransport({ id: "test-late", priority: incumbent!.priority + 1 }),
    );

    const ordered = listBackgroundTransports().map((t) => t.id);
    expect(ordered.indexOf("test-early")).toBeLessThan(
      ordered.indexOf(incumbent!.id),
    );
    expect(ordered.indexOf("test-late")).toBeGreaterThan(
      ordered.indexOf(incumbent!.id),
    );
  });

  it("asks transports in declared order and stops at the first available one", () => {
    process.env.NETLIFY = "true";
    const late = vi.fn(() => null);
    registerBackgroundTransport(
      testTransport({ id: "test-early", priority: -1 }),
    );
    registerBackgroundTransport(
      testTransport({ id: "test-late", priority: 1_000, resolve: late }),
    );

    expect(resolveBackgroundDispatchTarget()).toEqual({
      kind: "test-early",
      path: "/test-early",
      expectsBackgroundRuntime: true,
    });
    // Not merely "a later transport lost": it was never consulted at all.
    expect(late).not.toHaveBeenCalled();
  });
});

describe("the caller opt-out never reaches the registry", () => {
  it("consults no transport at all", () => {
    process.env.NETLIFY = "true";
    const resolve = vi.fn(() => null);
    registerBackgroundTransport(
      testTransport({ id: "test-early", priority: -1, resolve }),
    );

    expect(
      resolveBackgroundDispatchTarget({ durableBackground: false }),
    ).toEqual({
      kind: INLINE_ROUTE_TRANSPORT_ID,
      path: AGENT_CHAT_PROCESS_RUN_PATH,
      expectsBackgroundRuntime: false,
    });
    expect(resolve).not.toHaveBeenCalled();

    // Positive control: the same transport IS consulted without the opt-out.
    resolveBackgroundDispatchTarget();
    expect(resolve).toHaveBeenCalled();
  });
});

describe("the in-process route terminates the chain", () => {
  it("carries the caller's fallback path and is not a durable target", () => {
    const target = resolveBackgroundDispatchTarget({
      fallbackPath: "/api/_agent-native-background/example",
    });
    expect(target).toEqual({
      kind: INLINE_ROUTE_TRANSPORT_ID,
      path: "/api/_agent-native-background/example",
      expectsBackgroundRuntime: false,
    });
    expect(isDurableBackgroundTarget(target)).toBe(false);
  });

  it("treats any registered transport's target as durable", () => {
    registerBackgroundTransport(
      testTransport({ id: "test-early", priority: -1 }),
    );
    expect(isDurableBackgroundTarget(resolveBackgroundDispatchTarget())).toBe(
      true,
    );
  });
});

describe("the unclaimed-run watchdog arms from a declaration", () => {
  it("follows the transport's own declaration, either way", () => {
    registerBackgroundTransport(
      testTransport({
        id: "test-early",
        priority: -1,
        acknowledgesWithoutClaim: true,
      }),
    );
    registerBackgroundTransport(
      testTransport({
        id: "test-late",
        priority: 1_000,
        acknowledgesWithoutClaim: false,
      }),
    );

    expect(
      backgroundTargetAcknowledgesWithoutClaim({
        kind: "test-early",
        expectsBackgroundRuntime: true,
      }),
    ).toBe(true);
    expect(
      backgroundTargetAcknowledgesWithoutClaim({
        kind: "test-late",
        expectsBackgroundRuntime: true,
      }),
    ).toBe(false);
  });

  it("never arms for the in-process route (it is synchronous by construction)", () => {
    expect(
      backgroundTargetAcknowledgesWithoutClaim(
        resolveBackgroundDispatchTarget(),
      ),
    ).toBe(false);
  });

  it("reports an id no transport claims rather than assuming it is benign", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(
        backgroundTargetAcknowledgesWithoutClaim({
          kind: "test-pathless",
          expectsBackgroundRuntime: true,
        }),
      ).toBe(true);
      expect(errors).toHaveBeenCalledTimes(1);
      expect(String(errors.mock.calls[0]?.[0])).toContain("test-pathless");
    } finally {
      errors.mockRestore();
    }
  });
});

describe("a registered host resolves and delivers as one seam", () => {
  it("puts the run on the bound queue instead of the in-process route", async () => {
    // The nearest in-process stand-in for the Workers end-to-end proof: the
    // registry both SELECTS this host's transport and routes the handoff to it,
    // so a regression that quietly dropped to the inline route would show up as
    // a producer that was never called.
    const { fireBackgroundDispatch } =
      await import("../server/self-dispatch.js");
    const send = vi.fn(async () => {});
    (globalThis as Record<string, unknown>).__cf_env = {
      AGENT_NATIVE_BACKGROUND_QUEUE: { send },
    };
    process.env.A2A_SECRET = "shhh";

    const target = resolveBackgroundDispatchTarget();
    expect(target).toEqual({ kind: "queue", expectsBackgroundRuntime: true });
    expect(target.path).toBeUndefined();

    await fireBackgroundDispatch({
      target,
      taskId: "run_1",
      baseUrl: "https://app.example",
      body: { __backgroundRun: { runId: "run_1" } },
    });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]?.[0]).toMatchObject({
      taskId: "run_1",
      origin: "https://app.example",
    });
  });
});

describe("delivering a handoff on a transport with no path", () => {
  it("goes to the transport that declared the target", async () => {
    const deliver = vi.fn(async () => {});
    registerBackgroundTransport(
      testTransport({ id: "test-pathless", priority: -1, deliver }),
    );

    await deliverBackgroundHandoff(
      { kind: "test-pathless", expectsBackgroundRuntime: true },
      { taskId: "run-1", origin: "https://example.test" },
    );
    expect(deliver).toHaveBeenCalledWith({
      taskId: "run-1",
      origin: "https://example.test",
      body: undefined,
    });
  });

  it("throws when nothing can deliver it, rather than reporting a handoff", async () => {
    // A resolved-but-undeliverable target must not look like a completed
    // handoff: the caller degrades to an inline run on a throw, and reports a
    // durable run on a return.
    registerBackgroundTransport(
      testTransport({ id: "test-late", priority: 1_000 }),
    );
    await expect(
      deliverBackgroundHandoff(
        { kind: "test-late", expectsBackgroundRuntime: true },
        { taskId: "run-2", origin: "https://example.test" },
      ),
    ).rejects.toThrow(/no registered way to deliver/);
    await expect(
      deliverBackgroundHandoff(
        { kind: "test-pathless", expectsBackgroundRuntime: true },
        { taskId: "run-3", origin: "https://example.test" },
      ),
    ).rejects.toThrow(/test-pathless/);
  });
});
