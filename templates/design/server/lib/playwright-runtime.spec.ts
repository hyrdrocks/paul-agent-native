import {
  registerBrowserRenderingProvider,
  unregisterBrowserRenderingProvider,
} from "@agent-native/core/browser-rendering";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  isBrowserRenderingUnavailableError,
  launchRenderBrowser,
} from "./playwright-runtime.js";

const TEST_PROVIDER = "test-host";

afterEach(() => {
  unregisterBrowserRenderingProvider(TEST_PROVIDER);
  vi.resetModules();
  vi.restoreAllMocks();
});

describe("launchRenderBrowser", () => {
  it("refuses when the host that owns this process has no browser bound", async () => {
    registerBrowserRenderingProvider({
      id: TEST_PROVIDER,
      priority: 1,
      resolve: () => ({
        available: false,
        provider: TEST_PROVIDER,
        reason: "no Chromium on this host",
        setup: "build with CLOUDFLARE_BROWSER_RENDERING=1",
      }),
    });

    // The failure mode this replaces: falling through to a local launch on a
    // host that has no binary, which surfaces as a module-resolution crash and
    // gets caught somewhere as "nothing to render".
    await expect(launchRenderBrowser()).rejects.toSatisfy(
      isBrowserRenderingUnavailableError,
    );
    await expect(launchRenderBrowser()).rejects.toThrow(
      /no Chromium on this host/,
    );
  });

  it("carries the setup step a caller can act on", async () => {
    registerBrowserRenderingProvider({
      id: TEST_PROVIDER,
      priority: 1,
      resolve: () => ({
        available: false,
        provider: TEST_PROVIDER,
        reason: "no browser",
        setup: "build with CLOUDFLARE_BROWSER_RENDERING=1",
      }),
    });

    const err = await launchRenderBrowser().catch((e: unknown) => e);

    expect(isBrowserRenderingUnavailableError(err)).toBe(true);
    if (!isBrowserRenderingUnavailableError(err))
      throw new Error("unreachable");
    expect(err.setup).toContain("CLOUDFLARE_BROWSER_RENDERING");
    expect(err.provider).toBe(TEST_PROVIDER);
  });

  it("goes through the host binding when one is available", async () => {
    const binding = { fetch: async () => new Response("") };
    registerBrowserRenderingProvider({
      id: TEST_PROVIDER,
      priority: 1,
      resolve: () => ({ available: true, provider: TEST_PROVIDER, binding }),
    });
    const browser = { newPage: async () => ({}), close: async () => {} };
    vi.doMock("@cloudflare/puppeteer", () => ({
      default: { launch: async () => browser },
      launch: async () => browser,
    }));

    await expect(launchRenderBrowser()).resolves.toBeDefined();
  });

  it("negative control: with no host claiming the process it launches locally", async () => {
    // A seam that always claimed would break every local run, and would stop
    // being evidence that a host decided anything.
    const launch = vi.fn(async () => ({}) as never);
    vi.doMock("playwright", () => ({ chromium: { launch } }));

    await launchRenderBrowser().catch(() => undefined);

    expect(launch).toHaveBeenCalled();
  });
});
