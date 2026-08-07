/**
 * playwright-runtime.ts — shared headless-Chromium bootstrap used by every
 * server-side action that needs a real rendered DOM (as opposed to static
 * HTML/CSS analysis): `take-design-screenshot.ts`'s visual diagnostics pass
 * and `design-to-figma-svg.ts`'s scene extractor for the Figma SVG export.
 *
 * Extracted out of `take-design-screenshot.ts` (which originally owned this
 * logic) so `server/lib/*` modules can share it without an inverted
 * lib -> action dependency. `take-design-screenshot.ts` re-exports these same
 * names for backward compatibility with its existing spec/imports.
 */

import { resolveBrowserRenderingDecision } from "@agent-native/core/browser-rendering";

export type PlaywrightModule = {
  chromium: import("@playwright/test").BrowserType;
};

/**
 * Dynamic import of a real Chromium-capable Playwright package.  Tries the
 * bare `"playwright"` package first (present when `@agent-native/core`'s
 * optional dependency resolved), then falls back to `@playwright/test` (a
 * direct devDependency of this template, used by its own e2e suite, which
 * re-exports the same chromium/Browser API). Loaded via a non-literal
 * specifier so bundlers don't try to statically resolve/include it — it's
 * optional and can be entirely absent (e.g. in a hosted deploy).
 */
export async function importPlaywright(): Promise<PlaywrightModule> {
  try {
    const specifier = "playwright";
    return (await import(
      /* @vite-ignore */ specifier
    )) as unknown as PlaywrightModule;
  } catch {
    return (await import("@playwright/test")) as unknown as PlaywrightModule;
  }
}

const SYSTEM_CHROME_EXECUTABLES = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "/usr/bin/chromium",
];

/** Pure classifier for "no Chromium binary available" errors. */
export function isMissingBrowserError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /Executable doesn't exist|playwright install|browser.*not found|chromium.*not found/i.test(
    message,
  );
}

/** Launches Chromium, falling back to a system Chrome/Chromium binary when
 *  Playwright's bundled browser isn't installed (hosted/serverless deploys). */
export async function launchChromium(
  chromium: import("@playwright/test").BrowserType,
): Promise<import("@playwright/test").Browser> {
  const launchOptions = { args: ["--no-sandbox"] };
  try {
    return await chromium.launch(launchOptions);
  } catch (err) {
    if (!isMissingBrowserError(err)) throw err;
    const { existsSync } = await import("node:fs");
    for (const executablePath of SYSTEM_CHROME_EXECUTABLES) {
      if (!existsSync(executablePath)) continue;
      try {
        return await chromium.launch({ ...launchOptions, executablePath });
      } catch {
        // Try the next candidate; the original error is rethrown below.
      }
    }
    throw err;
  }
}

// NOTE: no shared `chromiumUnavailableReason` here on purpose — each caller's
// message should name ITS OWN fallback (e.g. `take-design-screenshot.ts`
// points at `run-design-audit`; the Figma SVG export points at `export-svg`),
// so that stays a small, action-local export next to each call site.

// ---------------------------------------------------------------------------
// The render seam: one entry point, two hosts.
// ---------------------------------------------------------------------------

/**
 * Thrown when the host that owns this process cannot render at all. Distinct
 * from a launch failure: there is no browser to fall back to and no retry that
 * helps, so a caller must surface `setup` rather than produce an artifact.
 */
export class BrowserRenderingUnavailableError extends Error {
  readonly setup: string;
  readonly provider: string;
  constructor(reason: string, setup: string, provider: string) {
    super(reason);
    this.name = "BrowserRenderingUnavailableError";
    this.setup = setup;
    this.provider = provider;
  }
}

export function isBrowserRenderingUnavailableError(
  err: unknown,
): err is BrowserRenderingUnavailableError {
  return err instanceof BrowserRenderingUnavailableError;
}

/**
 * Open a browser for this process.
 *
 * Which mechanism is not a decision this file makes: `@agent-native/core`'s
 * browser-rendering seam answers whether a host claims this process, because a
 * call site can only see "the Chromium import threw" and every call site
 * resolves that the same wrong way — by returning something the caller cannot
 * tell from a render.
 *
 *  - a host claims it and has a binding -> that binding, through puppeteer
 *  - a host claims it and has none      -> throws, carrying the setup step
 *  - nothing claims it                  -> the local Playwright/Chromium path
 */
export async function launchRenderBrowser(): Promise<
  import("@playwright/test").Browser
> {
  const decision = resolveBrowserRenderingDecision();
  if (decision) {
    if (!decision.available) {
      throw new BrowserRenderingUnavailableError(
        decision.reason,
        decision.setup,
        decision.provider,
      );
    }
    const { connectHostedBrowser } =
      await import("./cloudflare-browser-adapter.js");
    return connectHostedBrowser(decision.binding);
  }
  const playwright = await importPlaywright();
  return launchChromium(playwright.chromium);
}
