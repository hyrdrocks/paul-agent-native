/**
 * Cloudflare Workers cold-isolate regressions for the framework readiness gate.
 *
 * On Workers a promise belongs to the request context that created it. The
 * framework used to cache the bootstrap / plugin-init promises in isolate-global
 * scope and have every concurrent request await those same promises, so a cold
 * isolate taking a burst failed in a mixed, confusing way once the request that
 * warmed it answered:
 *
 *   "A promise was resolved or rejected from a different request context than
 *    the one it was created in. However, the creating request has already been
 *    completed or canceled. Continuations for that request are unlikely to run
 *    safely and have been canceled."
 *
 * Requests parked on those canceled continuations waited out the readiness
 * deadline (503) or were killed as hung, and routes the canceled bootstrap never
 * registered answered the router's no-match 404. Observed live: a 9-way burst
 * against a cold isolate returned 5x 200, 2x 404, 2x 503.
 *
 * These tests set `globalThis.__cf_env` (what `isCloudflareRuntime()` reads) so
 * only the Workers path is exercised; `framework-request-handler.spec.ts` covers
 * the unchanged Node path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getMissingDefaultPlugins } from "../deploy/route-discovery.js";
import { getH3App, trackPluginInit } from "./framework-request-handler.js";

vi.mock("../deploy/route-discovery.js", () => ({
  getMissingDefaultPlugins: vi.fn(async () => []),
}));

function createNitroApp() {
  const requestHooks: Array<(event: any) => unknown> = [];
  return {
    h3: { "~middleware": [] as any[] },
    hooks: {
      hook: (name: string, fn: (event: any) => unknown) => {
        if (name === "request") requestHooks.push(fn);
      },
    },
    __requestHooks: requestHooks,
  };
}

function createEvent(pathname: string) {
  const url = new URL(`https://worker.test${pathname}`);
  const waitUntil = vi.fn();
  const event = {
    method: "GET",
    url,
    path: pathname,
    context: {},
    req: new Request(url, { method: "GET" }),
    res: { status: 200, headers: new Headers() },
    waitUntil,
  };
  return { event, waitUntil };
}

/**
 * Production ordering: Nitro awaits the `request` hook before h3 snapshots the
 * middleware list for the request, so the hook is where a cold isolate is held.
 */
async function dispatch(nitroApp: any, pathname: string) {
  const { event, waitUntil } = createEvent(pathname);
  for (const hook of nitroApp.__requestHooks) await hook(event);
  const snapshot = [...nitroApp.h3["~middleware"]];
  let index = 0;
  const next = async (): Promise<unknown> => {
    const middleware = snapshot[index++];
    if (!middleware) return { fellThrough: true };
    return middleware(event, next);
  };
  const body = await next();
  return { body, status: event.res.status, waitUntil };
}

describe("framework readiness gate on Cloudflare Workers", () => {
  beforeEach(() => {
    (globalThis as any).__cf_env = {};
    process.env.AGENT_NATIVE_ROUTE_READY_TIMEOUT_MS = "300";
    // A module-mock fn keeps its call history across tests; several assertions
    // here count bootstrap attempts.
    vi.mocked(getMissingDefaultPlugins).mockClear();
  });

  afterEach(() => {
    delete (globalThis as any).__cf_env;
    delete process.env.AGENT_NATIVE_ROUTE_READY_TIMEOUT_MS;
    vi.restoreAllMocks();
    vi.mocked(getMissingDefaultPlugins).mockImplementation(async () => []);
  });

  it("starts bootstrap in the first request's context, under its waitUntil", async () => {
    const nitroApp = createNitroApp();
    getH3App(nitroApp);

    // Nothing may run at isolate scope: work started here belongs to whichever
    // request happens to warm the isolate, and dies with it.
    expect(getMissingDefaultPlugins).not.toHaveBeenCalled();
    expect((nitroApp as any)._agentNativeBootstrapPromise).toBeUndefined();

    const { waitUntil } = await dispatch(nitroApp, "/_agent-native/config");

    expect(getMissingDefaultPlugins).toHaveBeenCalledTimes(1);
    const promise = (nitroApp as any)._agentNativeBootstrapPromise;
    expect(promise).toBeInstanceOf(Promise);
    // The keep-alive is what lets the bootstrap's own continuations still run
    // after this request has answered.
    expect(waitUntil).toHaveBeenCalledWith(promise);
  });

  it("defers a tracked plugin init to the first request, under its waitUntil", async () => {
    // A Nitro plugin runs at isolate scope, where workerd refuses I/O outright
    // ("Disallowed operation called within global scope") and where work
    // attributed to the request that warmed the isolate dies with it. Callers
    // pass a thunk so the start happens in a request context — and it must be
    // the context that then keeps the work alive, because a promise whose
    // creating context is gone cannot be rescued by another request's waitUntil.
    const nitroApp = createNitroApp();
    let started = 0;
    getH3App(nitroApp);

    trackPluginInit(
      nitroApp,
      async () => {
        started += 1;
        getH3App(nitroApp).use("/_agent-native/mcp", () => ({ ok: true }));
      },
      { paths: ["/_agent-native/mcp"] },
    );

    expect(started).toBe(0);

    const response = await dispatch(nitroApp, "/_agent-native/mcp");

    expect(started).toBe(1);
    expect(response.body).toEqual({ ok: true });
    // Two keep-alives from this one request: the bootstrap it started and the
    // plugin init it started. Both must be its own, or the work outlives nothing.
    const kept = response.waitUntil.mock.calls.map(([p]: [unknown]) => p);
    expect(kept).toHaveLength(2);
    expect(kept[0]).toBeInstanceOf(Promise);
    expect(kept[1]).toBeInstanceOf(Promise);
    expect(kept[0]).not.toBe(kept[1]);
    expect(kept).toContain((nitroApp as any)._agentNativeBootstrapPromise);
  });

  it("releases a waiting request whose foreign init continuation was canceled", async () => {
    const nitroApp = createNitroApp();
    getH3App(nitroApp);

    // A cold isolate's plugin init, tracked by the request that warmed the
    // isolate. `never` stands in for what a later request sees after workerd
    // cancels the creating context's continuations: a promise chain that will
    // not settle for anyone else, even though the work behind it finished and
    // registered its route.
    const never = new Promise<void>(() => {});
    trackPluginInit(nitroApp, never, { paths: ["/_agent-native/actions"] });
    getH3App(nitroApp).use("/_agent-native/actions/list-vault-secrets", () => ({
      ok: true,
    }));
    // Completion is published as a flag precisely because it has to be readable
    // from a request context that cannot await the promise. (Reaching into the
    // entry is the only way to model a canceled continuation in-process.)
    const entries = (nitroApp as any)._agentNativePluginReadyPromise;
    entries[0].state.settled = true;

    const response = await dispatch(
      nitroApp,
      "/_agent-native/actions/list-vault-secrets",
    );

    // Before the fix this request awaited `never`, waited out the readiness
    // deadline and answered 503 — the live 9-way-burst signature.
    expect(response.body).toEqual({ ok: true });
    expect(response.status).toBe(200);
  });

  it("retries bootstrap on a later request instead of staying poisoned", async () => {
    const nitroApp = createNitroApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getMissingDefaultPlugins)
      .mockRejectedValueOnce(new Error("D1 not reachable yet"))
      .mockImplementationOnce(async () => {
        getH3App(nitroApp).use("/_agent-native/config", () => ({ ok: true }));
        return [];
      });
    getH3App(nitroApp);

    const first = await dispatch(nitroApp, "/_agent-native/config");
    expect(first.body).toEqual({ fellThrough: true });

    const second = await dispatch(nitroApp, "/_agent-native/config");
    expect(second.body).toEqual({ ok: true });
    expect(getMissingDefaultPlugins).toHaveBeenCalledTimes(2);
    warn.mockRestore();
  });

  it("stops retrying a bootstrap that keeps failing", async () => {
    const nitroApp = createNitroApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.mocked(getMissingDefaultPlugins).mockRejectedValue(
      new Error("D1 not reachable yet"),
    );
    getH3App(nitroApp);

    for (let i = 0; i < 5; i++)
      await dispatch(nitroApp, "/_agent-native/config");

    expect(getMissingDefaultPlugins).toHaveBeenCalledTimes(3);
    warn.mockRestore();
  });
});
