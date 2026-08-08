import { describe, expect, it, vi } from "vitest";

import {
  connectHostedBrowser,
  HostedBrowserCapabilityError,
} from "./cloudflare-browser-adapter.js";

type Handler = (...args: unknown[]) => void;

function fakePage(overrides: Record<string, unknown> = {}) {
  const handlers = new Map<string, Handler>();
  return {
    handlers,
    viewport: null as unknown,
    initScripts: [] as string[],
    intercepted: false,
    setViewport: vi.fn(async function (this: never, v: unknown) {
      page.viewport = v;
    }),
    evaluateOnNewDocument: vi.fn(async (s: string) => {
      page.initScripts.push(s);
    }),
    setRequestInterception: vi.fn(async (on: boolean) => {
      page.intercepted = on;
    }),
    setContent: vi.fn(async () => {}),
    evaluate: vi.fn(async () => null),
    waitForFunction: vi.fn(async () => null),
    screenshot: vi.fn(async () => new Uint8Array([1, 2, 3])),
    on: vi.fn((event: string, handler: Handler) => {
      handlers.set(event, handler);
    }),
    close: vi.fn(async () => {}),
    ...overrides,
  };
}
let page: ReturnType<typeof fakePage>;

function stubPuppeteer(browser: unknown) {
  vi.doMock("@cloudflare/puppeteer", () => ({
    default: { launch: async () => browser },
    launch: async () => browser,
  }));
}

async function connect(pageStub = fakePage()) {
  page = pageStub;
  const browser = { newPage: async () => page, close: vi.fn(async () => {}) };
  stubPuppeteer(browser);
  return { browser, handle: await connectHostedBrowser({}) };
}

describe("hosted browser adapter", () => {
  it("applies the viewport and device scale the caller asked for", async () => {
    const { handle } = await connect();

    const context = await handle.newContext({
      viewport: { width: 375, height: 812 },
      deviceScaleFactor: 2,
    });
    await context.newPage();

    expect(page.viewport).toEqual({
      width: 375,
      height: 812,
      deviceScaleFactor: 2,
    });
  });

  it("refuses a context with no viewport instead of taking puppeteer's default", async () => {
    // A silently-different viewport is a screenshot of a different layout,
    // which is exactly what this action exists to inspect.
    const { handle } = await connect();

    await expect(handle.newContext({})).rejects.toThrow(
      HostedBrowserCapabilityError,
    );
  });

  it("forwards init scripts before the page is used", async () => {
    const { handle } = await connect();

    const context = await handle.newContext({
      viewport: { width: 800, height: 600 },
    });
    await context.addInitScript("globalThis.__name ||= (v) => v;");
    await context.newPage();

    expect(page.initScripts).toEqual(["globalThis.__name ||= (v) => v;"]);
  });

  it("blocks a request the route handler rejects", async () => {
    const { handle } = await connect();
    const context = await handle.newContext({
      viewport: { width: 800, height: 600 },
    });
    await context.route("**/*", async (route) => {
      if (route.request().url().includes("169.254")) {
        await route.abort("blockedbyclient");
      } else {
        await route.continue();
      }
    });
    await context.newPage();

    const abort = vi.fn(async () => {});
    const cont = vi.fn(async () => {});
    page.handlers.get("request")?.({
      url: () => "http://169.254.169.254/latest/meta-data",
      abort,
      continue: cont,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(page.intercepted).toBe(true);
    expect(abort).toHaveBeenCalledWith("blockedbyclient");
    expect(cont).not.toHaveBeenCalled();
  });

  it("fails the render when the host cannot intercept requests", async () => {
    // Interception is what stops untrusted stored HTML making this browser an
    // SSRF primitive. An unfiltered render is not a degraded render.
    const { handle } = await connect(
      fakePage({
        setRequestInterception: vi.fn(async () => {
          throw new Error("not supported");
        }),
      }),
    );
    const context = await handle.newContext({
      viewport: { width: 800, height: 600 },
    });
    await context.route("**/*", async (route) => {
      await route.continue();
    });

    await expect(context.newPage()).rejects.toThrow(/request interception/);
  });

  it("fails a request whose handler threw rather than letting it through", async () => {
    const { handle } = await connect();
    const context = await handle.newContext({
      viewport: { width: 800, height: 600 },
    });
    await context.route("**/*", async () => {
      throw new Error("dns lookup failed");
    });
    await context.newPage();

    const abort = vi.fn(async () => {});
    const cont = vi.fn(async () => {});
    page.handlers.get("request")?.({
      url: () => "https://example.test/a.png",
      abort,
      continue: cont,
    });
    await new Promise((r) => setTimeout(r, 0));

    expect(cont).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalled();
  });

  it("refuses a screenshot that is not image bytes", async () => {
    // A base64 string has no byteLength and double-encodes into a data: URL —
    // neither is distinguishable from a real PNG at the call site.
    const { handle } = await connect(
      fakePage({ screenshot: vi.fn(async () => "iVBORw0KG") }),
    );
    const context = await handle.newContext({
      viewport: { width: 800, height: 600 },
    });
    const p = await context.newPage();

    await expect(p.screenshot({ type: "png" })).rejects.toThrow(
      HostedBrowserCapabilityError,
    );
  });

  it("returns real bytes as a Buffer, so base64 embedding works", async () => {
    const { handle } = await connect();
    const context = await handle.newContext({
      viewport: { width: 800, height: 600 },
    });
    const p = await context.newPage();

    const png = await p.screenshot({ type: "png" });

    expect(Buffer.isBuffer(png)).toBe(true);
    expect(png.byteLength).toBe(3);
    expect(png.toString("base64")).toBe(
      Buffer.from([1, 2, 3]).toString("base64"),
    );
  });

  it("translates the one waitUntil this template uses and rejects the rest", async () => {
    const { handle } = await connect();
    const context = await handle.newContext({
      viewport: { width: 800, height: 600 },
    });
    const p = await context.newPage();

    await p.setContent("<p>hi</p>", { waitUntil: "networkidle" });
    expect(page.setContent).toHaveBeenCalledWith("<p>hi</p>", {
      waitUntil: "networkidle0",
    });

    await expect(
      p.setContent("<p>hi</p>", {
        waitUntil: "commit" as unknown as "networkidle",
      }),
    ).rejects.toThrow(HostedBrowserCapabilityError);
  });

  it("closes the session rather than leaving it billed and open", async () => {
    const { browser, handle } = await connect();

    await handle.close();

    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});
