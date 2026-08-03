import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  AuthMountIncompleteError: class AuthMountIncompleteError extends Error {
    constructor(cause: unknown) {
      super("degraded");
      this.cause = cause;
    }
  },
  autoMountAuth: vi.fn(),
  getAuthMountFailure: vi.fn(),
  awaitBootstrap: vi.fn(),
  getH3App: vi.fn(),
  markDefaultPluginProvided: vi.fn(),
  trackPluginInit: vi.fn(),
}));

vi.mock("./auth.js", () => ({
  autoMountAuth: mocks.autoMountAuth,
  getAuthMountFailure: mocks.getAuthMountFailure,
  AuthMountIncompleteError: mocks.AuthMountIncompleteError,
}));

vi.mock("./framework-request-handler.js", () => ({
  awaitBootstrap: mocks.awaitBootstrap,
  getH3App: mocks.getH3App,
  markDefaultPluginProvided: mocks.markDefaultPluginProvided,
  trackPluginInit: mocks.trackPluginInit,
}));

import { createAuthPlugin } from "./auth-plugin.js";

describe("createAuthPlugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.awaitBootstrap.mockResolvedValue(undefined);
    mocks.autoMountAuth.mockResolvedValue(true);
    mocks.getAuthMountFailure.mockReturnValue(undefined);
  });

  it("tracks auth initialization before its routes mount", async () => {
    const nitroApp = {};
    const h3App = { use: vi.fn() };
    const options = { publicPaths: ["/public"] };
    mocks.getH3App.mockReturnValue(h3App);

    const result = createAuthPlugin(options)(nitroApp);

    expect(result).toBeUndefined();
    expect(mocks.markDefaultPluginProvided).toHaveBeenCalledWith(
      nitroApp,
      "auth",
    );
    // A thunk, not a running promise: on Workers the init must start inside a
    // request context, which only the readiness gate can provide.
    expect(mocks.trackPluginInit).toHaveBeenCalledWith(
      nitroApp,
      expect.any(Function),
      { paths: ["/_agent-native/auth"] },
    );

    await mocks.trackPluginInit.mock.calls[0]?.[1]();

    expect(mocks.awaitBootstrap).toHaveBeenCalledWith(nitroApp);
    expect(mocks.autoMountAuth).toHaveBeenCalledWith(h3App, options);
  });

  it("fails the tracked init when Better Auth's own routes never mounted", async () => {
    // autoMountAuth still returns true for a degraded mount (guard installed,
    // app locked), but /_agent-native/auth/ba/* is missing — releasing that into
    // a bare 404 is what left cold instances looking like they had no auth. The
    // readiness gate needs a rejected init to answer a retryable 503 instead.
    const nitroApp = {};
    mocks.getH3App.mockReturnValue({ use: vi.fn() });
    mocks.getAuthMountFailure.mockReturnValue({
      cause: new Error("db unreachable"),
    });

    createAuthPlugin()(nitroApp);

    const mount = mocks.trackPluginInit.mock.calls[0]?.[1];
    await expect(mount()).rejects.toBeInstanceOf(
      mocks.AuthMountIncompleteError,
    );
  });

  it("hands the gate a mount thunk it can run more than once", async () => {
    // The gate retries a failed init by calling the thunk again, which is only
    // useful if the whole mount re-runs.
    const nitroApp = {};
    mocks.getH3App.mockReturnValue({ use: vi.fn() });
    createAuthPlugin()(nitroApp);

    const mount = mocks.trackPluginInit.mock.calls[0]?.[1];
    await mount();
    await mount();

    expect(mocks.autoMountAuth).toHaveBeenCalledTimes(2);
  });
});
