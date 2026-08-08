import { afterEach, describe, expect, it } from "vitest";

import {
  type BrowserRenderingProvider,
  listBrowserRenderingProviders,
  registerBrowserRenderingProvider,
  resolveBrowserRenderingDecision,
  unregisterBrowserRenderingProvider,
} from "./registry.js";

const registered: string[] = [];

function register(provider: BrowserRenderingProvider): void {
  registered.push(provider.id);
  registerBrowserRenderingProvider(provider);
}

afterEach(() => {
  while (registered.length > 0) {
    unregisterBrowserRenderingProvider(registered.pop() as string);
  }
});

describe("browser-rendering registry", () => {
  it("answers null when no provider claims the process", () => {
    // Deliberately distinct from a refusal: nothing claimed this process, so
    // launching a local Chromium is correct. A refusal must never be answered
    // that way.
    register({ id: "test-absent", priority: 10, resolve: () => null });

    expect(resolveBrowserRenderingDecision()).toBeNull();
  });

  it("asks providers in declared priority, not registration order", () => {
    register({
      id: "test-late",
      priority: 90,
      resolve: () => ({ available: true, provider: "test-late", binding: {} }),
    });
    register({
      id: "test-early",
      priority: 10,
      resolve: () => ({ available: true, provider: "test-early", binding: {} }),
    });

    expect(listBrowserRenderingProviders().map((p) => p.id)).toEqual([
      "test-early",
      "test-late",
    ]);
    expect(resolveBrowserRenderingDecision()).toMatchObject({
      provider: "test-early",
    });
  });

  it("does not let a provider that declines displace one that refuses", () => {
    register({ id: "test-declines", priority: 10, resolve: () => null });
    register({
      id: "test-refuses",
      priority: 20,
      resolve: () => ({
        available: false,
        provider: "test-refuses",
        reason: "no browser here",
        setup: "bind one",
      }),
    });

    expect(resolveBrowserRenderingDecision()).toEqual({
      available: false,
      provider: "test-refuses",
      reason: "no browser here",
      setup: "bind one",
    });
  });

  it("carries a setup step on every refusal", () => {
    register({
      id: "test-refuses",
      priority: 10,
      resolve: () => ({
        available: false,
        provider: "test-refuses",
        reason: "no browser here",
        setup: "bind Browser Rendering as BROWSER",
      }),
    });

    const decision = resolveBrowserRenderingDecision();

    expect(decision?.available).toBe(false);
    expect(decision && !decision.available && decision.setup).toBeTruthy();
  });
});
