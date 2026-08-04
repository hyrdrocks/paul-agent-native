/**
 * Cold-isolate route dispatch, against REAL h3 wired the way Nitro 3 generates
 * it — `config.onRequest` bridged to the `request` hook, `~findRoute` for
 * file-based routes, and a `~getMiddleware` dispatcher that (as Nitro emits it
 * for an app with no `server/middleware/*`) does not include the global
 * `~middleware` array at all.
 *
 * The hand-rolled harness in `framework-request-handler.workers.spec.ts` asserts
 * the framework's own bookkeeping. This file asserts what a client actually
 * receives, because the failures that survived the first fix were all of the
 * form "the gate said ready and the response was still a 404": on a genuinely
 * cold Cloudflare isolate, six sequential samples of `/mcp`,
 * `/.well-known/oauth-authorization-server` and
 * `/.well-known/oauth-protected-resource` each returned exactly one 404, always
 * the slow first request, at 2.4-3.9s — the full cost of init, paid and then
 * thrown away.
 */
import { H3Core } from "h3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getH3App, trackPluginInit } from "./framework-request-handler.js";

vi.mock("../deploy/route-discovery.js", () => ({
  getMissingDefaultPlugins: vi.fn(async () => []),
}));

/**
 * `hookable`'s serial `callHook`, inlined: it returns a promise as soon as a
 * hook returns one, which is exactly what h3 awaits before resolving the route.
 * Getting this wrong would hide the bug these tests exist to catch.
 */
function createHooks() {
  const registered: Record<string, Array<(...args: any[]) => any>> = {};
  return {
    hook: (name: string, fn: (...args: any[]) => any) => {
      (registered[name] ??= []).push(fn);
    },
    callHook: (name: string, ...args: any[]) => {
      const list = registered[name] ?? [];
      const step = (i: number): any => {
        if (i >= list.length) return undefined;
        const result = list[i](...args);
        return result && typeof result.then === "function"
          ? Promise.resolve(result).then(() => step(i + 1))
          : step(i + 1);
      };
      return step(0);
    },
  };
}

function createNitroApp() {
  const hooks = createHooks();
  const h3App = new H3Core({});
  (h3App as any).config.onRequest = (event: any) =>
    hooks.callHook("request", event)?.catch?.(() => {});
  // No file-based route matches a framework path.
  (h3App as any)["~findRoute"] = () => undefined;
  // Nitro emits this dispatcher whenever the app has route rules; with no
  // `server/middleware/*` files it never reads `h3App["~middleware"]`, which is
  // the array `getH3App().use()` writes to.
  (h3App as any)["~getMiddleware"] = () => [];
  return {
    fetch: (req: Request) => (h3App as any).fetch(req),
    h3: h3App,
    hooks,
  };
}

function get(nitroApp: any, path: string): Promise<Response> {
  return nitroApp.fetch(new Request(`https://worker.test${path}`));
}

describe("cold-isolate dispatch on Cloudflare Workers", () => {
  beforeEach(() => {
    (globalThis as any).__cf_env = {};
    process.env.AGENT_NATIVE_ROUTE_READY_TIMEOUT_MS = "2000";
  });

  afterEach(() => {
    delete (globalThis as any).__cf_env;
    delete process.env.AGENT_NATIVE_ROUTE_READY_TIMEOUT_MS;
    vi.restoreAllMocks();
  });

  it("holds a request for an init that mounts its route under another plugin's prefix", async () => {
    const nitroApp = createNitroApp();

    // Production shape: core-routes declares "/mcp" (it owns /mcp/oauth and
    // /mcp/connect) and finishes early, while the agent-chat init is what
    // actually mounts the /mcp protocol endpoint under a prefix of its own.
    trackPluginInit(nitroApp, async () => {}, {
      paths: ["/_agent-native", "/mcp", "/.well-known"],
    });
    trackPluginInit(
      nitroApp,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 80));
        getH3App(nitroApp).use("/mcp", () => ({ mcp: "ok" }));
      },
      { paths: ["/_agent-native/agent-chat"] },
    );

    const response = await get(nitroApp, "/mcp");

    // Scoping readiness by declared prefix released this request as soon as the
    // first entry settled, and answered the 404 that kills MCP clients.
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mcp: "ok" });
  });

  it("answers a gated path with a retryable 503 while any init is unfinished", async () => {
    const nitroApp = createNitroApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // An init that never settles: the isolate cannot prove it is initialized, so
    // "no route" is unknown, not absent.
    trackPluginInit(nitroApp, () => new Promise<void>(() => {}), {
      paths: ["/_agent-native/agent-chat"],
    });

    const response = await get(
      nitroApp,
      "/.well-known/oauth-authorization-server",
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("retry-after")).toBe("5");
    const body = (await response.json()) as any;
    expect(body.pending).toContain("/_agent-native/agent-chat");
    warn.mockRestore();
  });

  it("still answers 404 for a gated path on a fully initialized isolate", async () => {
    const nitroApp = createNitroApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    trackPluginInit(
      nitroApp,
      async () => {
        getH3App(nitroApp).use("/mcp", () => ({ mcp: "ok" }));
      },
      { paths: ["/mcp"] },
    );

    expect((await get(nitroApp, "/mcp")).status).toBe(200);
    // A route that genuinely does not exist must not be dressed up as a
    // transient failure — that would make every client typo retry forever.
    expect((await get(nitroApp, "/_agent-native/nope")).status).toBe(404);
    warn.mockRestore();
  });

  it("does not let the app's catch-all answer a gated path mid-init", async () => {
    const nitroApp = createNitroApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // An SSR app matches every path, so h3 resolves a route for /mcp and the
    // React Router 404 page is a perfectly good "result". The guard used to
    // step aside for it, which is how a 404 kept reaching MCP clients even with
    // the guard deployed.
    (nitroApp.h3 as any)["~findRoute"] = () => ({
      data: { handler: () => new Response("app 404", { status: 404 }) },
      params: {},
    });
    trackPluginInit(nitroApp, () => new Promise<void>(() => {}), {
      paths: ["/_agent-native/agent-chat"],
    });

    expect((await get(nitroApp, "/mcp")).status).toBe(503);
    warn.mockRestore();
  });

  it("holds a request that arrives before any init has been tracked", async () => {
    const nitroApp = createNitroApp();
    // Nothing tracked yet: bootstrap settles with no entries, so the readiness
    // bookkeeping reads exactly like a finished isolate. It is not one — no
    // framework route is registered — and pruned entries produce the same
    // reading on a real cold isolate.
    getH3App(nitroApp);
    setTimeout(() => {
      getH3App(nitroApp).use("/mcp", () => ({ mcp: "ok" }));
    }, 120);

    const response = await get(nitroApp, "/mcp");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mcp: "ok" });
  });

  it("serves a route mounted after the request took its middleware snapshot", async () => {
    const nitroApp = createNitroApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Measured on Workers: the readiness gate released a `/mcp` request —
    // 0ms wait, `bootstrap=ready pending=[] failed=[]` — and the isolate then
    // registered 298 mounts, `/mcp` among them. The gate's flags cannot fix
    // this; by the time they are consulted the middleware list is already
    // snapshotted, so the recovery has to happen after dispatch.
    trackPluginInit(nitroApp, async () => {}, { paths: ["/mcp"] });
    void get(nitroApp, "/_agent-native/config");
    await new Promise((resolve) => setTimeout(resolve, 20));
    setTimeout(() => getH3App(nitroApp).use("/mcp", () => ({ mcp: "ok" })), 60);

    const response = await get(nitroApp, "/mcp");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ mcp: "ok" });
    warn.mockRestore();
  });

  it("recovers a gated path a catch-all already answered with a bare 404", async () => {
    const nitroApp = createNitroApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    // Nitro's asset/SSR fallback answers `/.well-known/agent-card.json` with an
    // empty 404 when the framework mount for it does not exist yet — a 404 that
    // never reaches the "no route matched" path, and so used to escape the
    // guard entirely.
    (nitroApp.h3 as any)["~findRoute"] = () => ({
      data: { handler: () => new Response(null, { status: 404 }) },
      params: {},
    });
    trackPluginInit(nitroApp, async () => {}, { paths: ["/.well-known"] });
    setTimeout(
      () =>
        getH3App(nitroApp).use("/.well-known/agent-card.json", () => ({
          name: "Dispatch",
        })),
      60,
    );

    const response = await get(nitroApp, "/.well-known/agent-card.json");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ name: "Dispatch" });
    warn.mockRestore();
  });

  it("does not replay a framework mount that answered its own 404", async () => {
    const nitroApp = createNitroApp();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;

    // An action answering "no such record" is a real answer. Re-running the
    // mount to double-check it would execute the action twice.
    trackPluginInit(
      nitroApp,
      async () => {
        getH3App(nitroApp).use("/_agent-native/actions/get-thing", () => {
          calls += 1;
          return new Response(null, { status: 404 });
        });
      },
      { paths: ["/_agent-native/actions"] },
    );

    const response = await get(nitroApp, "/_agent-native/actions/get-thing");

    expect(response.status).toBe(404);
    expect(calls).toBe(1);
    warn.mockRestore();
  });

  it("leaves non-gated paths to the app", async () => {
    const nitroApp = createNitroApp();
    trackPluginInit(nitroApp, async () => {}, { paths: ["/_agent-native"] });

    // The guard must not touch the SSR/app surface: reaching it on `/` would
    // mean rewriting the app's own 404s.
    expect((await get(nitroApp, "/vault")).status).toBe(404);
  });
});
