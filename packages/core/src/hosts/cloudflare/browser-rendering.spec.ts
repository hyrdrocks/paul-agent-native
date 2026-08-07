import { afterEach, beforeEach, describe, expect, it } from "vitest";

// Imported through the public package surface on purpose — the same anti-
// tree-shake pin R4 put on fallback storage. A side-effect-only import of the
// host barrel is dropped by a bundler honouring this package's `sideEffects`
// field, and the seam then answers "no host claimed this process", which is
// the one answer that sends a Worker off to launch a Chromium binary.
import {
  CLOUDFLARE_BROWSER_BINDING_NAME,
  CLOUDFLARE_BROWSER_RENDERING_ENV,
  cloudflareBrowserSetupStep,
  resolveBrowserRenderingDecision,
} from "../../browser-rendering/index.js";

const scope = globalThis as { __cf_env?: Record<string, unknown> };

describe("Cloudflare browser rendering", () => {
  beforeEach(() => {
    delete scope.__cf_env;
  });

  afterEach(() => {
    delete scope.__cf_env;
  });

  it("resolves the bound binding when this Worker has one", () => {
    const binding = { fetch: async () => new Response("") };
    scope.__cf_env = { [CLOUDFLARE_BROWSER_BINDING_NAME]: binding };

    const decision = resolveBrowserRenderingDecision();

    expect(decision).toMatchObject({ available: true, provider: "cloudflare" });
    expect(decision?.available && decision.binding).toBe(binding);
  });

  it("refuses by name on this host when nothing is bound", () => {
    scope.__cf_env = {};

    const decision = resolveBrowserRenderingDecision();

    expect(decision?.available).toBe(false);
    if (!decision || decision.available) throw new Error("unreachable");
    expect(decision.provider).toBe("cloudflare");
    expect(decision.setup).toContain(CLOUDFLARE_BROWSER_BINDING_NAME);
    expect(decision.setup).toContain(CLOUDFLARE_BROWSER_RENDERING_ENV);
  });

  it("tells a malformed binding apart from an absent one", () => {
    // Opposite repairs. "Turn the emitter on" is useless advice to someone who
    // already did and got something else bound under the name.
    scope.__cf_env = { [CLOUDFLARE_BROWSER_BINDING_NAME]: { put: () => {} } };

    const decision = resolveBrowserRenderingDecision();

    expect(decision?.available).toBe(false);
    if (!decision || decision.available) throw new Error("unreachable");
    expect(decision.setup).toContain("is not a Browser Rendering binding");
  });

  it("tells an unreadable env apart from an absent binding", () => {
    // A third repair again. "Turn the emitter on" is the wrong instruction for
    // someone whose Worker never published its platform env in the first place.
    const decision = resolveBrowserRenderingDecision();
    // __cf_env is deleted in beforeEach, but isCloudflareRuntime() has not
    // claimed the process either, so this asserts the pairing directly.
    expect(decision).toBeNull();
    expect(cloudflareBrowserSetupStep("unreadable")).toContain(
      "could not be read",
    );
    expect(cloudflareBrowserSetupStep("unreadable")).not.toBe(
      cloudflareBrowserSetupStep("absent"),
    );
  });

  it("negative control: off this host nothing claims the process", () => {
    // A provider that claimed every process would break the local Chromium
    // path everywhere and stop being evidence that a host decided anything.
    expect(resolveBrowserRenderingDecision()).toBeNull();
  });
});
