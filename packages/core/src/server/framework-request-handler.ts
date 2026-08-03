/**
 * Framework request handler — registers framework routes on Nitro's h3 instance.
 *
 * Nitro 3 exposes its h3 app as `nitroApp.h3`. We register framework routes
 * directly on it as middleware (`nitroApp.h3["~middleware"]`), giving each
 * plugin a path-prefix-matched handler that runs before any file-based route.
 *
 * Plugins call `getH3App(nitroApp).use(path, handler)` exactly like h3 v1's
 * `app.use()` — the wrapper translates that into v2 middleware registration.
 *
 * Default plugins that the template doesn't provide are auto-mounted on the
 * first call to `getH3App()` per nitroApp instance.
 */
import type { EventHandler, H3Event } from "h3";
import { setResponseHeader, setResponseStatus } from "h3";

import { getMissingDefaultPlugins } from "../deploy/route-discovery.js";
import { MCP_PUBLIC_ROUTE_PREFIX } from "../mcp/route-paths.js";
import { getConfiguredAppBasePath } from "./app-base-path.js";
import { captureError } from "./capture-error.js";
import type { InitState } from "./cross-request-init.js";
import {
  INIT_POLL_INTERVAL_MS,
  isCrossRequestPromiseUnsafe,
  keepAliveAcrossRequests,
  sleep,
} from "./cross-request-init.js";
import { createCsrfMiddleware } from "./csrf.js";
import {
  installHttpResponseTelemetryHooks,
  recordFrameworkReadyWait,
} from "./http-response-telemetry.js";
import {
  hasRequestContext,
  markRequestBoundaryInstalled,
  runWithRequestContext,
} from "./request-context.js";

const BOOTSTRAPPED = new WeakSet<object>();
const IN_BOOTSTRAP = new WeakSet<object>();
const FRAMEWORK_PREFIX = "/_agent-native";
const WELL_KNOWN_PREFIX = "/.well-known";
const APP_SHIM_KEY = "_agentNativeH3Shim";
const BOOTSTRAP_PROMISE_KEY = "_agentNativeBootstrapPromise";
const BOOTSTRAP_STATE_KEY = "_agentNativeBootstrapState";
const BOOTSTRAP_ATTEMPTS_KEY = "_agentNativeBootstrapAttempts";
const BOOTSTRAP_RETRIED_KEY = "_agentNativeBootstrapRetried";
const PLUGIN_READY_KEY = "_agentNativePluginReadyPromise";
const PLUGIN_READY_PLACEHOLDERS_KEY = "_agentNativePluginReadyPlaceholders";
const PLUGIN_FAILED_KEY = "_agentNativePluginInitFailures";
const PROVIDED_PLUGIN_STEMS_KEY = "_agentNativeProvidedPluginStems";
const MIDDLEWARE_DISPATCHER_PATCHED_KEY =
  "_agentNativeMiddlewareDispatcherPatched";
const REQUEST_CONTEXT_BOUNDARY_KEY = "_agentNativeRequestContextBoundary";
const INIT_GUARD_KEY = "_agentNativeFrameworkInitGuard";

/**
 * h3's "no route matched" sentinel, which it later turns into a 404. Registered
 * symbol, so reading it here cannot drift from the h3 instance in use.
 */
const H3_NOT_FOUND = Symbol.for("h3.notFound");

interface PluginReadyEntry {
  /** Undefined until the init has actually been started (see `start`). */
  promise?: Promise<void>;
  /**
   * Completion flag for `promise`, readable from any request context. On
   * Workers, waiters poll this instead of awaiting `promise` — see
   * `cross-request-init.ts`.
   */
  state: InitState;
  paths?: string[];
  /**
   * Starts the init. Present when the caller passed a thunk rather than a
   * running promise, which is what lets Workers defer the start into a request
   * context; also used as the default retry.
   */
  start?: () => Promise<void>;
  /** Re-run this plugin's init after a failure. */
  retry?: () => Promise<void>;
  retried?: boolean;
}

/** Most bootstrap failures are a cold dependency; a poisoned isolate is not. */
const MAX_BOOTSTRAP_ATTEMPTS = 3;

function getAppBasePath(): string {
  return getConfiguredAppBasePath();
}

function pathMatchesPrefix(reqPath: string, prefix: string): boolean {
  return reqPath === prefix || reqPath.startsWith(prefix + "/");
}

function supportsAppBasePathMount(path: string): boolean {
  return (
    pathMatchesPrefix(path, FRAMEWORK_PREFIX) ||
    pathMatchesPrefix(path, WELL_KNOWN_PREFIX) ||
    pathMatchesPrefix(path, MCP_PUBLIC_ROUTE_PREFIX)
  );
}

function resolveMountMatch(
  reqPath: string,
  path: string,
): { mountPath: string; strippedPath: string } | null {
  if (pathMatchesPrefix(reqPath, path)) {
    return { mountPath: path, strippedPath: reqPath.slice(path.length) || "/" };
  }

  const appBasePath = getAppBasePath();
  if (!appBasePath || !supportsAppBasePathMount(path)) return null;

  const prefixedPath = `${appBasePath}${path}`;
  if (!pathMatchesPrefix(reqPath, prefixedPath)) return null;
  return {
    mountPath: prefixedPath,
    strippedPath: reqPath.slice(prefixedPath.length) || "/",
  };
}

/**
 * Wrapper around Nitro's h3 instance that exposes a v1-style `.use()` API
 * for registering path-prefix middleware.
 */
export interface H3AppShim {
  use(path: string, handler: EventHandler): void;
  use(handler: EventHandler): void;
}

/**
 * Mark a default plugin slot as supplied by the app/template before the
 * framework default bootstrap runs.
 *
 * Bundled serverless functions often don't have the original
 * `server/plugins/*.ts` tree on disk at runtime, so filesystem route discovery
 * can falsely conclude a template plugin is missing. Explicit plugin factories
 * call this synchronously before awaiting bootstrap so the framework does not
 * auto-mount a generic default over the app's custom implementation.
 */
export function markDefaultPluginProvided(nitroApp: any, stem: string): void {
  if (!nitroApp || !stem) return;
  const existing = nitroApp[PROVIDED_PLUGIN_STEMS_KEY] as
    | Set<string>
    | undefined;
  const provided = existing ?? new Set<string>();
  provided.add(stem);
  nitroApp[PROVIDED_PLUGIN_STEMS_KEY] = provided;
}

/**
 * Get (or create) the shared H3 app wrapper for a nitroApp. Plugins use this
 * to register routes via `.use(path, handler)`.
 *
 * On the first call per nitroApp, we kick off auto-mounting any missing
 * default plugins. User-facing plugin factories (createAgentChatPlugin,
 * createAuthPlugin, etc.) await this bootstrap via `awaitBootstrap()` so the
 * default plugins finish registering middleware before requests arrive.
 */
export function getH3App(nitroApp: any): H3AppShim {
  if (!nitroApp) throw new Error("getH3App: nitroApp is required");
  ensureGlobalMiddlewareDispatch(nitroApp);
  installHttpResponseTelemetryHooks(nitroApp);

  // Reuse the cached shim if we've wrapped this nitroApp before
  const cached = nitroApp[APP_SHIM_KEY] as H3AppShim | undefined;
  if (cached) return cached;

  const shim: H3AppShim = {
    use(arg1: string | EventHandler, arg2?: EventHandler) {
      const path = typeof arg1 === "string" ? arg1 : "";
      const handler = (typeof arg1 === "string" ? arg2 : arg1) as EventHandler;
      if (typeof handler !== "function") {
        throw new Error("getH3App.use: handler must be a function");
      }
      registerMiddleware(nitroApp, path, handler);
    },
  };

  nitroApp[APP_SHIM_KEY] = shim;

  if (!BOOTSTRAPPED.has(nitroApp)) {
    BOOTSTRAPPED.add(nitroApp);
    // On Workers this runs at isolate/module scope, and everything it starts
    // belongs to whichever request happened to warm the isolate: once that
    // request answers, workerd cancels the continuations every other concurrent
    // request is parked on. Bootstrap is started from the first request instead,
    // under that request's own `waitUntil` (see ensureBootstrapStarted).
    if (!isCrossRequestPromiseUnsafe()) startBootstrap(nitroApp);

    // Readiness gate: Nitro v3 doesn't await async plugins, so routes
    // registered inside an async plugin may not exist when the first
    // request arrives. These middleware entries hold framework routes
    // until default-plugin bootstrap and tracked plugin inits complete.
    const readinessGate = (async (event: H3Event) => {
      const eventAny = event as any;
      await awaitFrameworkRoutesReadyForRequest(
        nitroApp,
        eventAny.context?._mountedPathname ?? event.url?.pathname ?? "",
        event,
      );
      // Fall through — the actual route handler runs next.
      return undefined;
    }) as EventHandler;
    registerMiddleware(nitroApp, FRAMEWORK_PREFIX, readinessGate, {
      prepend: true,
    });
    registerMiddleware(nitroApp, WELL_KNOWN_PREFIX, readinessGate, {
      prepend: true,
    });
    registerMiddleware(nitroApp, MCP_PUBLIC_ROUTE_PREFIX, readinessGate, {
      prepend: true,
    });

    // CSRF (see csrf.ts): registered here — synchronously, on the very
    // first `getH3App()` call for this nitroApp — rather than inside
    // createCoreRoutesPlugin's own async init chain. Real deployments mount
    // core-routes and agent-chat as SEPARATE, independently-async-initialized
    // Nitro plugin files with no explicit ordering between them; both
    // eventually call `getH3App(nitroApp).use(...)` to register their own
    // routes (CSRF, action routes) after their own async setup (DB reads,
    // dynamic imports) resolves in unpredictable relative order. The
    // readiness gate above only guarantees every tracked plugin has FINISHED
    // registering by the time a gated request is released — it does NOT
    // guarantee CSRF's registration call happens to `.push()` onto
    // `~middleware` before an action route's does. If agent-chat's action
    // route push happened to land first, that route would match and run
    // before CSRF ever saw the request. Registering CSRF here instead makes
    // it the first non-prepended middleware pushed onto the array for this
    // nitroApp, full stop — every plugin's own route registrations reach
    // `getH3App()` (and therefore run after this point) before they can
    // register anything, regardless of which plugin's async chain resolves
    // first.
    registerMiddleware(nitroApp, "", createCsrfMiddleware());

    // Registered last so it lands at index 0 — ahead of the readiness gates
    // and CSRF, both of which were unshifted/pushed above.
    registerRequestContextBoundary(nitroApp);

    // Primary gate: Nitro bridges this `request` hook to h3's `config.onRequest`,
    // which h3 awaits BEFORE `handler()` snapshots middleware and resolves the
    // route. The middleware gate above runs too late on production dispatchers —
    // its await finishes after the snapshot, so a route registered during async
    // init is missing from the request and 404s. The middleware gate stays as a
    // fallback for runtimes where `onRequest` isn't wired.
    nitroApp.hooks?.hook?.("request", async (event: H3Event) => {
      const reqPath = event.url?.pathname ?? "";
      // Start bootstrap on the FIRST request of any kind, not just gated ones:
      // default plugins mount the auth guard and template routes that plain
      // page/api requests depend on too.
      ensureBootstrapStarted(nitroApp, event);
      startDeferredPluginInits(nitroApp, event);
      if (
        resolveMountMatch(reqPath, FRAMEWORK_PREFIX) ||
        resolveMountMatch(reqPath, WELL_KNOWN_PREFIX) ||
        resolveMountMatch(reqPath, MCP_PUBLIC_ROUTE_PREFIX)
      ) {
        const startedAt = Date.now();
        try {
          await awaitFrameworkRoutesReadyForRequest(nitroApp, reqPath, event);
        } finally {
          recordFrameworkReadyWait(event, Date.now() - startedAt);
        }
      }
    });
  }

  return shim;
}

/**
 * Establish a `RequestContext` for every inbound request, so no HTTP handler
 * ever asks a request-scoped question with no request in scope.
 *
 * Hand-written `/api/*` routes have no ALS store of their own, and
 * `getRequestUserEmail()` used to answer those with `AGENT_USER_EMAIL` — a
 * process-wide ambient identity standing in for the caller, which fails open
 * toward more privilege (an admin gate reading it admits whoever the deploy env
 * names). This store is deliberately identity-free: resolving the session here
 * would mean reading cookies on the SSR path, which must stay one impersonal
 * cached shell. Handlers that do know the caller still nest their own
 * `runWithRequestContext`, which shadows this one.
 *
 * h3 v2 hands middleware a `next()` that returns the result of the rest of the
 * chain (route handler included), so wrapping `next()` puts the whole request
 * inside the ALS scope. It must be `~middleware[0]`; going through
 * `registerMiddleware` is not an option because that adapter hides `next`.
 */
function registerRequestContextBoundary(nitroApp: any): void {
  const h3 = nitroApp?.h3;
  if (!h3 || !Array.isArray(h3["~middleware"])) return;
  if (h3[REQUEST_CONTEXT_BOUNDARY_KEY]) return;

  const middleware = (event: H3Event, next: () => unknown) => {
    // Index 0 on every request, so it is also the earliest point at which a
    // runtime that never wires Nitro's `request` hook can still start bootstrap
    // inside a real request context (see ensureBootstrapStarted).
    ensureBootstrapStarted(nitroApp, event);
    startDeferredPluginInits(nitroApp, event);
    if (hasRequestContext()) return next();
    return runWithRequestContext({}, () => next());
  };

  h3[REQUEST_CONTEXT_BOUNDARY_KEY] = middleware;
  h3["~middleware"].unshift(middleware);
  markRequestBoundaryInstalled();
}

function isGatedPath(reqPath: string): boolean {
  return Boolean(
    resolveMountMatch(reqPath, FRAMEWORK_PREFIX) ||
    resolveMountMatch(reqPath, WELL_KNOWN_PREFIX) ||
    resolveMountMatch(reqPath, MCP_PUBLIC_ROUTE_PREFIX),
  );
}

interface ReadinessSnapshot {
  bootstrap: "unstarted" | "pending" | "failed" | "ready";
  pending: string[];
  failed: string[];
}

/**
 * What this isolate can currently prove about its own framework init.
 *
 * Entries are pruned once they settle cleanly, so a healthy warm isolate reports
 * `ready` with nothing pending — which is what makes "incomplete" a usable
 * signal rather than a permanent state.
 */
function describeFrameworkReadiness(nitroApp: any): ReadinessSnapshot {
  const state = nitroApp?.[BOOTSTRAP_STATE_KEY] as InitState | undefined;
  const entries =
    (nitroApp?.[PLUGIN_READY_KEY] as PluginReadyEntry[] | undefined) ?? [];
  const label = (entry: PluginReadyEntry) =>
    entry.paths?.join(",") || "(unscoped)";
  return {
    bootstrap: !state
      ? "unstarted"
      : state.error
        ? "failed"
        : state.settled
          ? "ready"
          : "pending",
    pending: entries.filter((entry) => !entry.state.settled).map(label),
    failed: entries.filter((entry) => entry.state.error).map(label),
  };
}

function isFrameworkInitIncomplete(snapshot: ReadinessSnapshot): boolean {
  return (
    snapshot.bootstrap !== "ready" ||
    snapshot.pending.length > 0 ||
    snapshot.failed.length > 0
  );
}

/**
 * Last-resort middleware for the gated prefixes: it runs after every route, so
 * reaching it means nothing matched this request.
 *
 * A gated prefix answering a bare 404 is the one failure external clients cannot
 * survive. An MCP client makes a handful of discovery/handshake calls and does
 * not retry, so a single 404 on `/mcp` or
 * `/.well-known/oauth-authorization-server` kills the connection outright, while
 * a 503 is a "try again" it can act on. Whenever this isolate cannot prove its
 * own init finished, "no route" means "not mounted yet", not "does not exist" —
 * those are different answers and must not share a status code.
 *
 * The warn line is unconditional on purpose. A gated 404 on a fully-initialized
 * isolate is a genuine missing route and worth seeing; a gated 404 with anything
 * pending names the init that had not finished, which is the only way to tell
 * the two apart from outside the isolate.
 */
function getFrameworkInitGuard(
  nitroApp: any,
): (event: H3Event, next: () => any) => any {
  const cached = nitroApp[INIT_GUARD_KEY];
  if (cached) return cached;

  const guard = async (event: H3Event, next: () => any) => {
    const reqPath = event.url?.pathname ?? "";
    if (!isGatedPath(reqPath)) return next();

    const result = await next();
    if (result !== undefined && result !== H3_NOT_FOUND) return result;

    const readiness = describeFrameworkReadiness(nitroApp);
    const incomplete = isFrameworkInitIncomplete(readiness);
    console.warn(
      `[agent-native] no framework route matched ${reqPath} — ` +
        `bootstrap=${readiness.bootstrap} ` +
        `pending=[${readiness.pending.join(" ")}] ` +
        `failed=[${readiness.failed.join(" ")}] ` +
        `answering ${incomplete ? "503" : "404"}`,
    );
    if (!incomplete) return result;

    setResponseStatus(event, 503);
    setResponseHeader(event, "retry-after", "5");
    return {
      error: "agent-native routes are still initializing",
      bootstrap: readiness.bootstrap,
      pending: readiness.pending,
      failed: readiness.failed,
    };
  };

  nitroApp[INIT_GUARD_KEY] = guard;
  return guard;
}

/**
 * Nitro 3 production builds generate a route dispatcher by overriding h3's
 * internal `~getMiddleware()` hook. Some generated dispatchers return only
 * route-rule middleware and skip the global `h3["~middleware"]` array that
 * `getH3App().use()` appends to. Wrap the dispatcher once so framework routes
 * registered at runtime are still part of request dispatch.
 */
function ensureGlobalMiddlewareDispatch(nitroApp: any): void {
  const h3 = nitroApp?.h3;
  if (!h3) return;
  const current = h3["~getMiddleware"];
  if (h3[MIDDLEWARE_DISPATCHER_PATCHED_KEY] === current) return;

  const original = typeof current === "function" ? current.bind(h3) : undefined;

  const wrappedGetMiddleware = (event: H3Event, route: unknown) => {
    const originalResult = original ? original(event, route) : [];
    const originalList = Array.isArray(originalResult)
      ? originalResult
      : originalResult
        ? [originalResult]
        : [];
    const globalMiddleware = Array.isArray(h3["~middleware"])
      ? h3["~middleware"]
      : [];
    const alreadyIncluded = new Set(originalList);
    const missingGlobal = globalMiddleware.filter(
      (middleware) => !alreadyIncluded.has(middleware),
    );
    // Appended here rather than registered, because "last" is the guard's whole
    // contract and registration order cannot provide it: real routes are pushed
    // onto `~middleware` during plugin init, long after this module runs.
    return [...missingGlobal, ...originalList, getFrameworkInitGuard(nitroApp)];
  };

  h3["~getMiddleware"] = wrappedGetMiddleware;
  h3[MIDDLEWARE_DISPATCHER_PATCHED_KEY] = wrappedGetMiddleware;
}

/**
 * Start default-plugin bootstrap and publish both its promise (Node waiters)
 * and its completion flag (Workers waiters, which cannot await the promise).
 *
 * `event`, when given, is the request that owns the work: handing the promise to
 * its `waitUntil` keeps that request context alive past its own response so the
 * bootstrap's continuations stay legal on Workers.
 */
function startBootstrap(nitroApp: any, event?: H3Event): void {
  if (nitroApp[BOOTSTRAP_STATE_KEY]) return;
  const state: InitState = { settled: false };
  nitroApp[BOOTSTRAP_STATE_KEY] = state;
  nitroApp[BOOTSTRAP_ATTEMPTS_KEY] =
    (nitroApp[BOOTSTRAP_ATTEMPTS_KEY] ?? 0) + 1;

  const promise = (async () => {
    try {
      await bootstrapDefaultPlugins(nitroApp);
      state.settled = true;
    } catch (err) {
      // Flag the failure before reporting it: a waiter polling this state must
      // learn "ran and failed", not keep waiting for a run that already ended.
      state.settled = true;
      state.error = err;
      console.warn(
        "[agent-native] Failed to auto-mount default plugins:",
        (err as Error).message,
      );
      captureError(err, {
        route: "default-plugin-bootstrap",
        tags: { phase: "default-plugin-bootstrap" },
      });
    }
  })();

  nitroApp[BOOTSTRAP_PROMISE_KEY] = promise;
  keepAliveAcrossRequests(event, promise);
}

/** Start bootstrap under `event`'s context if it has never run here. */
function ensureBootstrapStarted(nitroApp: any, event?: H3Event): void {
  if (!nitroApp || IN_BOOTSTRAP.has(nitroApp)) return;
  if (nitroApp[BOOTSTRAP_STATE_KEY]) return;
  startBootstrap(nitroApp, event);
}

/**
 * Restart a bootstrap that already ran and failed — at most once per request and
 * `MAX_BOOTSTRAP_ATTEMPTS` per isolate.
 *
 * A bootstrap that rejected once (DB not yet reachable on a cold instance) used
 * to leave its settled-with-error memo behind for the isolate's whole lifetime,
 * so every later request there was served by an app whose default plugins never
 * mounted — a permanent 404 surface produced by one transient error.
 */
function retryBootstrapIfFailed(nitroApp: any, event?: H3Event): void {
  if (!nitroApp || IN_BOOTSTRAP.has(nitroApp)) return;
  const state = nitroApp[BOOTSTRAP_STATE_KEY] as InitState | undefined;
  if (!state?.error) return;
  if ((nitroApp[BOOTSTRAP_ATTEMPTS_KEY] ?? 0) >= MAX_BOOTSTRAP_ATTEMPTS) return;
  // Both readiness gates run for the same request; one retry between them.
  const context = (event as any)?.context;
  if (context) {
    if (context[BOOTSTRAP_RETRIED_KEY]) return;
    context[BOOTSTRAP_RETRIED_KEY] = true;
  }
  nitroApp[BOOTSTRAP_STATE_KEY] = undefined;
  nitroApp[BOOTSTRAP_PROMISE_KEY] = undefined;
  startBootstrap(nitroApp, event);
}

/**
 * Wait for the framework's default-plugin bootstrap to complete.
 *
 * Called by user-facing plugin factories (`createAgentChatPlugin`, etc.) at
 * the top of their plugin function, so that by the time the function returns
 * — and Nitro starts accepting requests — all default plugins have finished
 * registering their middleware.
 *
 * No-op when called from inside the bootstrap itself (avoids deadlock when a
 * default plugin happens to be running as part of bootstrap).
 */
export async function awaitBootstrap(nitroApp: any): Promise<void> {
  if (!nitroApp || IN_BOOTSTRAP.has(nitroApp)) return;
  // Trigger bootstrap if it hasn't been already (idempotent — getH3App
  // creates the shim and kicks off bootstrap on first call).
  getH3App(nitroApp);
  if (isCrossRequestPromiseUnsafe()) {
    const state = nitroApp[BOOTSTRAP_STATE_KEY] as InitState | undefined;
    // No bootstrap yet means we are at isolate scope, where Workers forbids
    // both starting the work and sleeping on a timer. The first request starts
    // it and the readiness gate holds requests until it finishes, so returning
    // here delays default plugins rather than dropping them.
    if (!state) return;
    await pollUntilBootstrapSettled(nitroApp, frameworkReadyDeadlineMs());
    return;
  }
  const promise = nitroApp[BOOTSTRAP_PROMISE_KEY];
  if (promise) await promise;
}

async function pollUntilBootstrapSettled(
  nitroApp: any,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = nitroApp[BOOTSTRAP_STATE_KEY] as InitState | undefined;
    if (!state || state.settled) return true;
    if (Date.now() >= deadline) return false;
    await sleep(INIT_POLL_INTERVAL_MS);
  }
}

/**
 * Wait until framework routes are safe to dispatch.
 *
 * Request-time gates must wait for both phases:
 *   1. default-plugin bootstrap, which discovers and starts missing plugins
 *   2. async plugin init promises, which register routes such as A2A cards
 */
async function awaitFrameworkRoutesReadyForRequest(
  nitroApp: any,
  reqPath: string,
  event?: H3Event,
): Promise<boolean> {
  if (!nitroApp) return true;
  ensureBootstrapStarted(nitroApp, event);
  retryBootstrapIfFailed(nitroApp, event);
  startDeferredPluginInits(nitroApp, event);
  if (isCrossRequestPromiseUnsafe()) {
    return pollFrameworkRoutesReady(nitroApp, event);
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      (async () => {
        const bootstrapPromise = nitroApp[BOOTSTRAP_PROMISE_KEY];
        if (bootstrapPromise) await bootstrapPromise;
        await awaitPluginsReady(nitroApp, reqPath);
        return true;
      })(),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), frameworkReadyDeadlineMs());
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Workers-safe readiness wait: observe completion FLAGS on a timer this request
 * created, never a promise another request created.
 *
 * Init work that has not started yet is started here, so it belongs to a live
 * request context rather than to isolate scope.
 *
 * Waits for EVERY tracked init, not just the ones whose declared paths match
 * this request. `paths` says where a plugin registers its own routes, which is
 * not the same question as which plugin owns the route being requested: `/mcp`
 * is mounted by the agent-chat init while `/mcp/oauth` is mounted by
 * core-routes, so scoping by prefix released `/mcp` as soon as core-routes
 * finished and answered a 404 for a handler that was still being mounted. On a
 * cold isolate every init is running concurrently anyway, so the wall-clock cost
 * is the slowest init either way. The deadline still bounds it, and a single
 * stalled init now holds every gated prefix rather than one — a retryable 503
 * instead of an unrecoverable 404, which is the trade we want.
 */
async function pollFrameworkRoutesReady(
  nitroApp: any,
  event?: H3Event,
): Promise<boolean> {
  const deadline = Date.now() + frameworkReadyDeadlineMs();
  for (;;) {
    const bootstrapState = nitroApp[BOOTSTRAP_STATE_KEY] as
      | InitState
      | undefined;
    const bootstrapSettled = !bootstrapState || bootstrapState.settled;

    startDeferredPluginInits(nitroApp, event);
    const pending = bootstrapSettled
      ? relevantPluginEntries(nitroApp).filter((entry) => !entry.state.settled)
      : [];

    if (bootstrapSettled && pending.length === 0) {
      prunePluginEntries(nitroApp);
      return true;
    }
    if (Date.now() >= deadline) return false;
    await sleep(INIT_POLL_INTERVAL_MS);
  }
}

/**
 * Cap on how long a request may be held waiting for framework routes.
 *
 * Holding past the platform's own request wall is pure loss: the serverless
 * gateway kills the invocation and the client gets a bare 502/504 it cannot
 * act on. Releasing first lets the placeholder answer with a retryable 503.
 * Keep this BELOW the shortest deployment target's request wall (Netlify
 * synchronous functions cut off around 40s regardless of a higher configured
 * `timeout`).
 */
function frameworkReadyDeadlineMs(): number {
  const raw = Number(process.env.AGENT_NATIVE_ROUTE_READY_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : 25_000;
}

/**
 * Track an async plugin's initialization promise. Nitro v3 calls plugins
 * synchronously and doesn't await async return values, so routes registered
 * inside an async plugin may not be ready when the first request arrives.
 *
 * Call this from the TOP of any async plugin so that the readiness gate
 * (installed by getH3App) can hold /_agent-native requests until the plugin
 * finishes mounting its routes.
 *
 * Pass a THUNK, not a running promise, unless the init has to start eagerly:
 * only a thunk can be started inside a request context, which is what Cloudflare
 * Workers requires (a Nitro plugin runs at isolate scope, where workerd refuses
 * I/O outright) and what makes a failed init retryable.
 */
export function trackPluginInit(
  nitroApp: any,
  init: Promise<void> | (() => Promise<void>),
  options: { paths?: string[]; retry?: () => Promise<void> } = {},
): void {
  if (!nitroApp) return;
  // Ensure the readiness gate exists even when the tracked plugin is the first
  // framework code to run in a serverless isolate. Otherwise an immediate
  // first request can fall through before the plugin registers its routes.
  getH3App(nitroApp);
  const start = typeof init === "function" ? init : undefined;
  const entry: PluginReadyEntry = {
    state: { settled: false },
    paths: options.paths?.filter(Boolean),
    start,
    retry: options.retry ?? start,
  };

  const existing = nitroApp[PLUGIN_READY_KEY] as PluginReadyEntry[] | undefined;
  if (existing) {
    existing.push(entry);
  } else {
    nitroApp[PLUGIN_READY_KEY] = [entry];
  }
  installPluginReadyPlaceholders(nitroApp, entry.paths);

  // Workers: a plugin runs at isolate scope, where starting the init is not
  // merely fragile but forbidden — workerd answers `setTimeout`, `fetch` and
  // every other I/O call outside a request with "Disallowed operation called
  // within global scope". Callers that pass a thunk get their init started by
  // the first request instead (startDeferredPluginInits), inside that request's
  // context and under its `waitUntil`. Verified on workerd: a promise whose
  // creating context is gone can be rescued by nobody — a second request
  // handing it to its OWN waitUntil does not keep it alive.
  if (start && isCrossRequestPromiseUnsafe()) return;

  attachTrackedInit(nitroApp, entry, start ? start() : (init as Promise<void>));
}

/**
 * Bind a running init to its entry: flip the entry's flag when it settles, and
 * record a rejection so the readiness gate can answer the plugin's routes with a
 * retryable 503.
 */
function attachTrackedInit(
  nitroApp: any,
  entry: PluginReadyEntry,
  promise: Promise<void>,
): void {
  const state = entry.state;
  // Attach a no-op catch so the promise doesn't surface as an unhandled
  // rejection when Nitro v3 drops the async return value. The actual error
  // is still observable when awaitPluginsReady() re-awaits the promise.
  entry.promise = promise.then(
    () => {
      state.settled = true;
    },
    (err) => {
      state.settled = true;
      state.error = err;
      console.error(
        "[agent-native] Plugin init failed:",
        (err as Error).message || err,
      );
      // Record the failure so the readiness gate can return a retryable 503 for
      // this plugin's routes instead of letting them fall through to a bare
      // "Cannot find any route matching" 404. That bare 404 is what kept biting
      // external MCP clients (pi/codex/claude) and the connect flow on cold /
      // propagating instances whose async init rejected (e.g. DB not yet
      // reachable): the route never registered, so the placeholder released into
      // a 404 the client couldn't recover from. A 503 is at least retryable.
      const failures = (nitroApp[PLUGIN_FAILED_KEY] ??= new Map<
        string,
        string
      >());
      const msg = (err as Error)?.message || String(err);
      for (const p of entry.paths ?? []) failures.set(p, msg);
    },
  );
}

/**
 * Start any init whose caller deferred it to a request context, in THIS
 * request's context and under its `waitUntil` — the only context that can keep
 * the work's own continuations alive on Workers.
 */
function startDeferredPluginInits(nitroApp: any, event?: H3Event): void {
  const entries = nitroApp?.[PLUGIN_READY_KEY] as
    | PluginReadyEntry[]
    | undefined;
  if (!entries?.length) return;
  for (const entry of entries) {
    if (entry.promise || !entry.start) continue;
    attachTrackedInit(nitroApp, entry, entry.start());
    keepAliveAcrossRequests(event, entry.promise);
  }
}

function installPluginReadyPlaceholders(
  nitroApp: any,
  paths: string[] | undefined,
): void {
  if (!paths?.length) return;
  const existing = nitroApp[PLUGIN_READY_PLACEHOLDERS_KEY] as
    | Set<string>
    | undefined;
  const installed = existing ?? new Set<string>();
  nitroApp[PLUGIN_READY_PLACEHOLDERS_KEY] = installed;

  for (const path of paths) {
    if (!path || installed.has(path)) continue;
    installed.add(path);
    registerMiddleware(
      nitroApp,
      path,
      (async (event: H3Event) => {
        const eventAny = event as any;
        const reqPath =
          eventAny.context?._mountedPathname ?? event.url?.pathname ?? path;
        const ready = await awaitFrameworkRoutesReadyForRequest(
          nitroApp,
          reqPath,
          event,
        );
        if (!ready) {
          // Boot is still running and we are out of budget. Answer now, while
          // the gateway is still listening, rather than being killed mid-wait.
          setResponseStatus(event, 503);
          setResponseHeader(event, "retry-after", "5");
          return { error: "agent-native routes are still initializing" };
        }
        // If this plugin's async init failed, its real route was never
        // registered. Return a retryable 503 instead of releasing into a bare
        // 404 (external MCP clients can't recover from a 404; a 503 is at least
        // a "try again" the client / next instance can act on).
        const failures = nitroApp[PLUGIN_FAILED_KEY] as
          | Map<string, string>
          | undefined;
        if (failures?.size) {
          for (const [failedPath, msg] of failures) {
            if (resolveMountMatch(reqPath, failedPath)) {
              // A 503 the caller can retry into the same 503 forever is not
              // actually retryable. Queue one fresh init attempt for this
              // plugin and answer 503 now, so the caller's next try can find
              // real routes.
              retryFailedPluginInit(nitroApp, failedPath);
              setResponseStatus(event, 503);
              setResponseHeader(event, "retry-after", "5");
              return {
                error: `agent-native route is initializing or unavailable: ${msg}`,
              };
            }
          }
        }
        return undefined;
      }) as EventHandler,
      {
        prepend: true,
      },
    );
  }
}

/**
 * Re-run the init of a plugin whose first attempt failed, at most once per
 * tracked entry, so the 503 this request is about to answer is one the caller
 * can actually retry into something better.
 */
function retryFailedPluginInit(nitroApp: any, failedPath: string): void {
  const entry = (
    (nitroApp[PLUGIN_READY_KEY] as PluginReadyEntry[] | undefined) ?? []
  ).find(
    (candidate) =>
      candidate.retry &&
      !candidate.retried &&
      candidate.state.error &&
      candidate.paths?.includes(failedPath),
  );
  if (!entry?.retry) return;
  entry.retried = true;
  const failures = nitroApp[PLUGIN_FAILED_KEY] as
    | Map<string, string>
    | undefined;
  for (const path of entry.paths ?? []) failures?.delete(path);
  // Tracked as a thunk, so on Workers the attempt starts in the NEXT request's
  // context — this one is about to answer 503, and a context that is closing
  // cannot carry the work.
  trackPluginInit(nitroApp, entry.retry, { paths: entry.paths });
}

function logFrameworkRouteError(args: {
  method: string | undefined;
  route: string;
  status: number;
  error: unknown;
}): void {
  const error = args.error as any;
  const message = error?.message || String(args.error);
  const prefix = `[agent-native] ${args.method ?? ""} ${args.route} failed (${args.status})`;
  if (process.env.NODE_ENV === "production") {
    console.error(`${prefix}: ${message}`);
    return;
  }
  console.error(`${prefix}: ${message}`, error?.stack || args.error);
}

function isClientAbortError(error: unknown, event: H3Event): boolean {
  const err = error as any;
  const message = typeof err?.message === "string" ? err.message : "";
  const code = typeof err?.code === "string" ? err.code : "";
  const node = (event as any).node;
  return (
    message === "aborted" ||
    code === "ECONNRESET" ||
    node?.req?.destroyed === true ||
    node?.res?.destroyed === true
  );
}

function debugClientAbort(args: {
  method: string | undefined;
  route: string;
  error: unknown;
}): void {
  if (process.env.NODE_ENV === "production") return;
  const err = args.error as any;
  const message = err?.message || String(args.error);
  console.debug?.(
    `[agent-native] ${args.method ?? ""} ${args.route} aborted by client: ${message}`,
  );
}

/**
 * Await all tracked plugin initializations. Called by the readiness gate
 * middleware before dispatching framework routes.
 */
export async function awaitPluginsReady(
  nitroApp: any,
  reqPath?: string,
): Promise<void> {
  const relevant = relevantPluginEntries(nitroApp, reqPath);
  if (!relevant.length) return;

  if (isCrossRequestPromiseUnsafe()) {
    // Poll the flags; the promises belong to whichever request tracked them.
    const deadline = Date.now() + frameworkReadyDeadlineMs();
    while (!relevant.every((entry) => entry.state.settled)) {
      if (Date.now() >= deadline) return;
      await sleep(INIT_POLL_INTERVAL_MS);
    }
  } else {
    await Promise.all(
      relevant.map((entry) => entry.promise ?? entry.start?.()),
    );
  }
  const completed = new Set(relevant.filter(isPrunableEntry));
  const latest =
    (nitroApp[PLUGIN_READY_KEY] as PluginReadyEntry[] | undefined) ?? [];
  nitroApp[PLUGIN_READY_KEY] = latest.filter((entry) => !completed.has(entry));
}

/**
 * A failed entry stays tracked until its retry has been used: it is the only
 * place the retry thunk lives, and the readiness gate needs it when a later
 * request hits the recorded failure.
 */
function isPrunableEntry(entry: PluginReadyEntry): boolean {
  if (!entry.state.settled) return false;
  if (!entry.state.error) return true;
  return !entry.retry || entry.retried === true;
}

function relevantPluginEntries(
  nitroApp: any,
  reqPath?: string,
): PluginReadyEntry[] {
  const entries = nitroApp?.[PLUGIN_READY_KEY] as
    | PluginReadyEntry[]
    | undefined;
  if (!entries?.length) return [];
  if (!reqPath) return entries;
  return entries.filter((entry) =>
    entry.paths?.length
      ? entry.paths.some((path) => resolveMountMatch(reqPath, path))
      : true,
  );
}

function prunePluginEntries(nitroApp: any, reqPath?: string): void {
  const settled = new Set(
    relevantPluginEntries(nitroApp, reqPath).filter(isPrunableEntry),
  );
  if (!settled.size) return;
  const latest =
    (nitroApp[PLUGIN_READY_KEY] as PluginReadyEntry[] | undefined) ?? [];
  nitroApp[PLUGIN_READY_KEY] = latest.filter((entry) => !settled.has(entry));
}

/**
 * Register a path-prefix middleware on Nitro's h3 instance.
 *
 * The middleware:
 *   - Returns `next()` (continues) if the request path doesn't match.
 *   - Otherwise dispatches to the handler. If the handler returns a value,
 *     it short-circuits the request. If it returns undefined, next() runs.
 *
 * Path matching emulates h3 v1's `app.use(path, ...)` behavior:
 *   - Exact-match prefix: `/foo` matches `/foo`, `/foo/bar`, but not `/foobar`
 *   - Empty path: middleware runs on every request
 */
function registerMiddleware(
  nitroApp: any,
  path: string,
  handler: EventHandler,
  options: { prepend?: boolean } = {},
) {
  const h3 = nitroApp.h3;
  if (!h3 || !Array.isArray(h3["~middleware"])) {
    throw new Error(
      "[agent-native] Cannot register route: nitroApp.h3 is not available. " +
        "Make sure you're calling getH3App() from inside a Nitro plugin.",
    );
  }

  const middleware = async (event: H3Event, next: () => any) => {
    let originalPathname: string | undefined;
    let originalEventPath: string | undefined;
    let hadEventPath = false;
    // Only true once this specific middleware invocation has actually
    // stripped a mount prefix (i.e. `path` was non-empty and matched).
    // Global (`path === ""`) middleware never mutates event.path/pathname,
    // so `restoreOriginalPath` must be a no-op for it — otherwise it would
    // unconditionally `delete event.path` on every pass-through (hadEventPath
    // defaults to false), corrupting the event for any middleware that runs
    // later in the chain (a real bug: two or more global middlewares in
    // sequence, e.g. security-headers + CORS + CSRF, would wipe event.path
    // for everything downstream, including the final route handler).
    let didStripPath = false;
    const restoreOriginalPath = () => {
      if (!didStripPath) return;
      if (originalPathname !== undefined) {
        try {
          event.url.pathname = originalPathname;
        } catch {
          // ignore
        }
        originalPathname = undefined;
      }
      if (hadEventPath) {
        try {
          (event as any).path = originalEventPath;
        } catch {
          // ignore
        }
      } else {
        try {
          delete (event as any).path;
        } catch {
          // ignore
        }
      }
    };
    if (path) {
      const reqPath = event.url?.pathname ?? "";
      const match = resolveMountMatch(reqPath, path);
      if (!match) {
        return next();
      }
      // Strip the mount prefix from event.url.pathname so handlers that
      // dispatch sub-routes can read `event.path` (or `event.url.pathname`)
      // and see the path RELATIVE to their mount point — matching h3 v1's
      // `app.use(path, handler)` semantics.
      const eventAny = event as any;
      hadEventPath = "path" in eventAny;
      originalEventPath = eventAny.path;
      didStripPath = true;
      try {
        originalPathname = event.url.pathname;
        // Save the full path in context so handlers that need the original URL
        // (e.g. Better Auth, which extracts its own basePath prefix) can
        // reconstruct a Request with the un-stripped URL.
        eventAny.context = eventAny.context ?? {};
        eventAny.context._mountedPathname = originalPathname;
        eventAny.context._mountPrefix = match.mountPath;
        event.url.pathname = match.strippedPath;
        eventAny.path = `${match.strippedPath}${event.url.search || ""}`;
      } catch {
        // event.url is read-only on some runtimes — fall through. Handlers
        // that don't depend on prefix stripping (most of them) still work.
      }
    }
    try {
      const result = await handler(event);
      if (result === undefined) {
        // Restore the original pathname BEFORE calling next() so downstream
        // middleware sees the full URL — not the stripped mount-relative path.
        // Matches h3 v2's own sub-app middleware pattern where the restore
        // happens inside the next() callback, not after it returns.
        restoreOriginalPath();
        return next();
      }
      return result;
    } catch (err) {
      // Log 500s to the server console so they're debuggable, and respond
      // with JSON instead of the default HTML error page so clients can
      // surface error messages. This only applies to routes mounted under
      // the framework prefix (or middleware mounted at `/`, for which we
      // still want visibility).
      const reqPath = originalPathname ?? event.url?.pathname ?? "";
      const e = err as any;
      const status =
        typeof e?.statusCode === "number"
          ? e.statusCode
          : typeof e?.status === "number"
            ? e.status
            : 500;
      if (isClientAbortError(err, event)) {
        debugClientAbort({ method: event.method, route: reqPath, error: err });
        return undefined;
      }
      logFrameworkRouteError({
        method: event.method,
        route: reqPath,
        status,
        error: err,
      });
      // Forward 5xx to the configured server error providers — Nitro's own
      // `error` hook may not fire here because we convert the throw into a
      // normal JSON response, and a console.error alone is invisible in
      // deployed environments. 4xx are user-input errors (validation, auth)
      // and aren't worth alerting on.
      if (status >= 500) {
        captureError(err, {
          route: reqPath,
          method: event.method,
          tags: { status_code: String(status) },
          userAgent: (() => {
            try {
              return event.headers?.get("user-agent") ?? undefined;
            } catch {
              return undefined;
            }
          })(),
        });
      }
      try {
        setResponseStatus(event, status);
        setResponseHeader(event, "content-type", "application/json");
      } catch {
        // Response already sent — best effort.
      }
      return {
        error: e?.message || "Internal server error",
        // Only surface the stack to clients when explicitly enabled.
        // `NODE_ENV !== "production"` was unsafe — preview deploys and
        // any host that forgets to set NODE_ENV=production leaked stack
        // traces (file paths, dependency versions, internal route
        // topology) to anonymous callers. Operators who want stacks in
        // dev set `AGENT_NATIVE_DEBUG_ERRORS=1` explicitly.
        ...(status >= 500 &&
        process.env.AGENT_NATIVE_DEBUG_ERRORS === "1" &&
        e?.stack
          ? { stack: e.stack }
          : {}),
      };
    } finally {
      // Restore the original pathname so downstream middleware sees the
      // full URL.
      restoreOriginalPath();
    }
  };

  if (options.prepend) {
    h3["~middleware"].unshift(middleware);
  } else {
    h3["~middleware"].push(middleware);
  }
}

/**
 * Auto-mount any default framework plugins that the template doesn't provide.
 *
 * Runs once per nitroApp on the first `getH3App()` call. Uses route-discovery
 * to find which default plugin stems are missing from `server/plugins/`, then
 * dynamically imports and mounts them. If a workspace core is present in the
 * ancestor chain, plugin slots the workspace core exports are mounted from
 * there instead of from @agent-native/core — this is the middle layer of the
 * three-layer inheritance model (app local > workspace core > framework).
 */
async function bootstrapDefaultPlugins(nitroApp: any): Promise<void> {
  IN_BOOTSTRAP.add(nitroApp);
  try {
    const cwd = process.cwd();
    const discoveredMissing = await getMissingDefaultPlugins(cwd);
    const provided = nitroApp[PROVIDED_PLUGIN_STEMS_KEY] as
      | Set<string>
      | undefined;
    const missing = provided
      ? discoveredMissing.filter((stem) => !provided.has(stem))
      : discoveredMissing;
    if (missing.length === 0) return;

    // Lazy import to avoid circular dependency at module load time
    const serverModule = await import("./index.js");
    const terminalModule = await import("../terminal/terminal-plugin.js");
    const integrationsModule = await import("../integrations/plugin.js");
    const contextXrayModule = await import("../agent/context-xray/plugin.js");
    const observationalMemoryModule =
      await import("../agent/observational-memory/plugin.js");
    const orgModule = await import("../org/plugin.js");
    const onboardingModule = await import("../onboarding/plugin.js");

    const frameworkImpls: Record<
      string,
      ((nitroApp: any) => void | Promise<void>) | undefined
    > = {
      "agent-chat": (serverModule as any).defaultAgentChatPlugin,
      auth: (serverModule as any).defaultAuthPlugin,
      "context-xray": (contextXrayModule as any).defaultContextXrayPlugin,
      "core-routes": (serverModule as any).defaultCoreRoutesPlugin,
      integrations: (integrationsModule as any).defaultIntegrationsPlugin,
      "observational-memory": (observationalMemoryModule as any)
        .defaultObservationalMemoryPlugin,
      onboarding: (onboardingModule as any).defaultOnboardingPlugin,
      org: (orgModule as any).defaultOrgPlugin,
      resources: (serverModule as any).defaultResourcesPlugin,
      sentry: (serverModule as any).defaultSentryPlugin,
      terminal: (terminalModule as any).defaultTerminalPlugin,
    };

    // Workspace core layer: if the app is inside an enterprise monorepo with
    // `agent-native.workspaceCore` configured, pull in any plugin slots the
    // workspace core exports from its server entry. We dynamically import the
    // workspace core package at runtime.
    let workspaceImpls: Record<
      string,
      ((nitroApp: any) => void | Promise<void>) | undefined
    > = {};
    try {
      const { getWorkspaceCoreExports } =
        await import("../deploy/workspace-core.js");
      const ws = await getWorkspaceCoreExports(cwd);
      if (ws && Object.keys(ws.plugins).length > 0) {
        try {
          const wsServerModule = await loadWorkspaceCoreServer(
            ws.packageName,
            ws.packageDir,
          );
          for (const [slot, exportName] of Object.entries(ws.plugins)) {
            if (!exportName) continue;
            const impl = (wsServerModule as any)[exportName];
            if (typeof impl === "function") {
              workspaceImpls[slot] = impl;
            }
          }
          if (process.env.DEBUG) {
            console.log(
              `[agent-native] Workspace core ${ws.packageName} provides plugin slots: ${Object.keys(workspaceImpls).join(", ")}`,
            );
          }
        } catch (e) {
          const msg = (e as Error).message ?? "";
          // Common cause: workspace-core's package.json points "./server"
          // at a TS source file (the scaffold default), but Node can't
          // resolve relative `.js` imports inside it without a TS loader.
          // Tell the user to compile to dist/ rather than just dumping the
          // raw resolution error.
          const tsLoadHint = /\.js' imported from .*\.ts/.test(msg)
            ? " — workspace-core src is TypeScript but isn't being compiled. " +
              "Run `pnpm --filter " +
              ws.packageName +
              " build` and point its `./server` export at dist/server/index.js."
            : "";
          console.warn(
            `[agent-native] Failed to load workspace core ${ws.packageName}/server: ${msg}${tsLoadHint}`,
          );
        }
      }
    } catch {
      // Workspace shared package isn't available (e.g. running on an edge
      // runtime without fs). Silently fall through to framework defaults.
    }

    if (process.env.DEBUG)
      console.log(
        `[agent-native] Auto-mounting ${missing.length} default plugin(s): ${missing.join(", ")}`,
      );

    for (const stem of missing) {
      // Prefer workspace-core impl over framework default when both exist.
      const impl = workspaceImpls[stem] ?? frameworkImpls[stem];
      if (typeof impl === "function") {
        try {
          await impl(nitroApp);
        } catch (e) {
          console.warn(
            `[agent-native] Failed to auto-mount default plugin ${stem}:`,
            (e as Error).message,
          );
          captureError(e, {
            route: "default-plugin-bootstrap",
            tags: { phase: "default-plugin-bootstrap", plugin: stem },
          });
        }
      }
    }
  } finally {
    IN_BOOTSTRAP.delete(nitroApp);
  }
}

/**
 * Load a workspace-core's `/server` entry, transparently handling TS source.
 *
 * The scaffolded workspace-core template ships TS sources without a build
 * step (exports point at `./src/server/index.ts`), so plain `await import()`
 * blows up the moment Node hits a relative `.js` import inside (the standard
 * TS ESM convention) — and even before that, Node may resolve the package
 * relative to the framework's own location rather than the user's monorepo.
 *
 * We try Node's plain `import()` first (fastest path when the user has
 * compiled to dist/) and fall through to jiti on any error. jiti is anchored
 * to a real file inside the workspace-core's directory, so its module
 * resolution starts in the right node_modules tree (handles pnpm hoisting
 * and linked workspaces) AND handles TS source files + `.js` → `.ts` ESM
 * extension remapping.
 *
 * Edge runtimes without `fs` won't be able to load jiti at all; the outer
 * try/catch silently falls through to framework defaults in that case.
 */
export async function loadWorkspaceCoreServer(
  packageName: string,
  packageDir: string,
): Promise<any> {
  let firstErr: unknown;
  try {
    return await import(/* @vite-ignore */ `${packageName}/server`);
  } catch (e) {
    firstErr = e;
  }

  try {
    const { createJiti } = await import("jiti");
    const { pathToFileURL } = await import("node:url");
    const path = await import("node:path");
    // Anchor jiti to a real file inside the workspace-core package so its
    // module resolution starts in the right node_modules tree (handles pnpm
    // hoisting and linked workspaces).
    const anchor = pathToFileURL(
      path.join(packageDir, "package.json"),
    ).toString();
    const jiti = createJiti(anchor, { interopDefault: true });
    return await jiti.import(`${packageName}/server`);
  } catch (jitiErr) {
    // jiti also failed — rethrow the original Node error since it's usually
    // more informative about *why* the package wasn't resolvable.
    throw firstErr ?? jitiErr;
  }
}

export { FRAMEWORK_PREFIX };
