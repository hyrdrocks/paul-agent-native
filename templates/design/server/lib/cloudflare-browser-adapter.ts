/**
 * cloudflare-browser-adapter.ts — the Browser Rendering half of the render
 * seam in `playwright-runtime.ts`.
 *
 * A Worker reaches Chromium through the `BROWSER` binding and a puppeteer
 * client, not a local binary. The rest of this template's render code is
 * written against the Playwright surface, so this file presents the same small
 * subset of it over puppeteer rather than forking two copies of every render
 * path — the subset is exactly what `take-design-screenshot.ts` and
 * `design-to-figma-svg.ts` use, and nothing more.
 *
 * `@cloudflare/puppeteer` is imported dynamically and ONLY once the binding has
 * been resolved, so the local Playwright route never requires a
 * Cloudflare-only package and a Node run never loads one.
 *
 * Every gap between the two APIs is closed loudly. A missing capability throws;
 * none of them degrades into a render that returns something the caller cannot
 * tell from a real one.
 */

import type {
  Browser as PlaywrightBrowser,
  BrowserContext as PlaywrightBrowserContext,
  Page as PlaywrightPage,
} from "@playwright/test";

/** Thrown when the hosted browser cannot do something the render path needs. */
export class HostedBrowserCapabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostedBrowserCapabilityError";
  }
}

interface PuppeteerRequestLike {
  url(): string;
  continue(): Promise<void>;
  abort(reason?: string): Promise<void>;
}

interface PuppeteerPageLike {
  setViewport(viewport: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
  }): Promise<void>;
  evaluateOnNewDocument(script: string): Promise<unknown>;
  setRequestInterception(enabled: boolean): Promise<void>;
  setContent(html: string, options?: { waitUntil?: string }): Promise<void>;
  evaluate(fn: unknown, ...args: unknown[]): Promise<unknown>;
  waitForFunction(
    fn: unknown,
    options?: { timeout?: number; polling?: number | string },
    ...args: unknown[]
  ): Promise<unknown>;
  screenshot(options?: Record<string, unknown>): Promise<unknown>;
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  close(): Promise<void>;
}

interface PuppeteerBrowserLike {
  newPage(): Promise<PuppeteerPageLike>;
  close(): Promise<void>;
  disconnect?(): Promise<void>;
}

interface CloudflarePuppeteerModule {
  launch(binding: unknown): Promise<PuppeteerBrowserLike>;
}

/**
 * Puppeteer's screenshot returns bytes, but its options also allow a base64
 * string, and a future default change would hand a caller a string that
 * `byteLength` reports as `undefined` and a base64 embed silently double-
 * encodes. Neither is distinguishable from a real PNG at the call site, so an
 * unexpected shape is an error here rather than something to coerce.
 */
function asPngBytes(value: unknown): Buffer {
  if (value instanceof Uint8Array) return Buffer.from(value);
  if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value));
  throw new HostedBrowserCapabilityError(
    `The hosted browser returned a ${typeof value} from screenshot() instead of image bytes — refusing to pass it off as a PNG.`,
  );
}

/**
 * Playwright's `networkidle` and puppeteer's `networkidle0` are the same
 * condition under two names; anything else this template passes would be a new
 * requirement, not a rename, so it is not silently mapped.
 */
function waitUntilForPuppeteer(waitUntil: string | undefined): string {
  if (waitUntil === undefined) return "load";
  if (waitUntil === "networkidle") return "networkidle0";
  if (waitUntil === "load" || waitUntil === "domcontentloaded") {
    return waitUntil;
  }
  throw new HostedBrowserCapabilityError(
    `No hosted-browser equivalent for waitUntil "${waitUntil}".`,
  );
}

type RouteHandler = (route: {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(reason?: string): Promise<void>;
}) => Promise<void> | void;

/**
 * One page presented as a Playwright context+page pair. Browser Rendering has
 * no browser-context concept to map onto, and this template only ever opens one
 * page per context, so a context IS its page here — stated because a second
 * `newPage()` on the same context would silently share state under this shape.
 */
class HostedPageContext {
  private page: PuppeteerPageLike | null = null;
  private closed = false;

  constructor(
    private readonly browser: PuppeteerBrowserLike,
    private readonly viewport: {
      width: number;
      height: number;
      deviceScaleFactor?: number;
    },
  ) {}

  private readonly initScripts: string[] = [];
  private routeHandler: RouteHandler | null = null;

  async addInitScript(script: unknown): Promise<void> {
    if (typeof script !== "string") {
      throw new HostedBrowserCapabilityError(
        "The hosted browser adapter only forwards string init scripts.",
      );
    }
    this.initScripts.push(script);
  }

  async route(_pattern: string, handler: RouteHandler): Promise<void> {
    // Every route this template registers is "**/*". A narrower pattern would
    // need real glob matching, and quietly applying a "**/*" handler to it
    // would either block requests the caller meant to allow or, far worse,
    // allow ones it meant to block.
    if (_pattern !== "**/*") {
      throw new HostedBrowserCapabilityError(
        `The hosted browser adapter only supports a catch-all route, not "${_pattern}".`,
      );
    }
    this.routeHandler = handler;
  }

  async newPage(): Promise<PlaywrightPage> {
    if (this.page) {
      throw new HostedBrowserCapabilityError(
        "The hosted browser adapter opens one page per context.",
      );
    }
    const page = await this.browser.newPage();
    this.page = page;
    await page.setViewport({
      width: this.viewport.width,
      height: this.viewport.height,
      ...(this.viewport.deviceScaleFactor
        ? { deviceScaleFactor: this.viewport.deviceScaleFactor }
        : {}),
    });
    for (const script of this.initScripts) {
      await page.evaluateOnNewDocument(script);
    }
    if (this.routeHandler) {
      const handler = this.routeHandler;
      // Interception is how the render path stops untrusted stored HTML
      // turning this browser into an SSRF primitive. If the host cannot do it,
      // the render does not happen — an unfiltered render is not a degraded
      // one.
      await page.setRequestInterception(true).catch((err: unknown) => {
        throw new HostedBrowserCapabilityError(
          `The hosted browser refused request interception, which is what blocks SSRF from stored HTML: ${String(err)}`,
        );
      });
      page.on("request", (...args: unknown[]) => {
        const request = args[0] as PuppeteerRequestLike;
        void Promise.resolve(
          handler({
            request: () => ({ url: () => request.url() }),
            continue: () => request.continue(),
            abort: (reason?: string) => request.abort(reason),
          }),
        ).catch(() => {
          // A handler that threw leaves the request hanging until the page
          // times out, so fail it closed instead of continuing it.
          void request.abort("failed").catch(() => {});
        });
      });
    }
    return wrapPage(page);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.page?.close();
  }
}

function wrapPage(page: PuppeteerPageLike): PlaywrightPage {
  const wrapper = {
    on(event: string, handler: (...args: unknown[]) => void) {
      // Playwright and puppeteer agree on these three event names and on
      // `msg.type()` / `msg.text()` / `request.url()`.
      page.on(event, handler);
      return wrapper;
    },
    // `async` matters: `waitUntilForPuppeteer` throws, and a caller awaiting
    // this must see a rejection rather than a synchronous throw past its own
    // try/catch.
    setContent: async (html: string, options?: { waitUntil?: string }) =>
      page.setContent(html, {
        waitUntil: waitUntilForPuppeteer(options?.waitUntil),
      }),
    evaluate: (fn: unknown, ...args: unknown[]) => page.evaluate(fn, ...args),
    waitForFunction: (
      fn: unknown,
      options?: { timeout?: number; polling?: number | string },
    ) => page.waitForFunction(fn, options),
    waitForTimeout: (ms: number) =>
      new Promise<void>((resolve) => setTimeout(resolve, ms)),
    screenshot: async (options?: Record<string, unknown>) =>
      asPngBytes(await page.screenshot(options)),
    close: () => page.close(),
  };
  return wrapper as unknown as PlaywrightPage;
}

/**
 * A Playwright-shaped `Browser` over a Browser Rendering binding.
 *
 * `binding` is the opaque value `@agent-native/core`'s browser-rendering seam
 * resolved — core owns whether this host can render, this file owns how.
 */
export async function connectHostedBrowser(
  binding: unknown,
): Promise<PlaywrightBrowser> {
  // A literal specifier with NO `@vite-ignore`, unlike `importPlaywright`'s
  // deliberately opaque one. That comment tells the bundler not to resolve the
  // import, and a Worker has no module resolution at runtime — measured on a
  // real build, the emitted chunk kept `import("@cloudflare/puppeteer")`
  // verbatim and every hosted render would have died on it. Playwright is
  // opaque because it is optional and genuinely absent here; this package must
  // be IN the bundle.
  const puppeteer = (await import("@cloudflare/puppeteer")) as unknown as {
    default?: CloudflarePuppeteerModule;
    launch?: CloudflarePuppeteerModule["launch"];
  };
  const launch = puppeteer.launch ?? puppeteer.default?.launch;
  if (typeof launch !== "function") {
    throw new HostedBrowserCapabilityError(
      "@cloudflare/puppeteer resolved without a launch() — the hosted render path has no client.",
    );
  }
  const browser = await launch(binding);
  const wrapper = {
    async newContext(options?: {
      viewport?: { width: number; height: number };
      deviceScaleFactor?: number;
    }): Promise<PlaywrightBrowserContext> {
      const viewport = options?.viewport;
      if (!viewport) {
        throw new HostedBrowserCapabilityError(
          "The hosted browser adapter needs an explicit viewport — puppeteer's default is not this template's.",
        );
      }
      return new HostedPageContext(browser, {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: options?.deviceScaleFactor,
      }) as unknown as PlaywrightBrowserContext;
    },
    async close(): Promise<void> {
      // A Browser Rendering session is a billed, limited resource and outlives
      // the isolate that opened it, so it is closed rather than disconnected.
      await browser.close();
    },
  };
  return wrapper as unknown as PlaywrightBrowser;
}
