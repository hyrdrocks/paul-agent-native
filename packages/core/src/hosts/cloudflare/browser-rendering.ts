/**
 * The Cloudflare Browser Rendering provider.
 *
 * A Worker has no Chromium binary and nowhere to install one, so a render on
 * this host either goes through the `BROWSER` binding or does not happen. It
 * must never fall through to a local launch: that produces a module-resolution
 * crash at best, and at worst a caller that treats the miss as "nothing to
 * render" and returns an empty artifact.
 */

import {
  cloudflareBrowserSetupStep,
  describeCloudflareBrowserBinding,
} from "../../browser-rendering/cloudflare-browser.js";
import { registerBrowserRenderingProvider } from "../../browser-rendering/registry.js";
import { isCloudflareRuntime } from "../../shared/runtime.js";

/**
 * Declared first among hosts. Spread out so a host can be slotted ahead of or
 * behind this one without renumbering either.
 */
const CLOUDFLARE_BROWSER_RENDERING_PRIORITY = 20;

const PROVIDER_ID = "cloudflare";

export function registerCloudflareBrowserRendering(): void {
  registerBrowserRenderingProvider({
    id: PROVIDER_ID,
    priority: CLOUDFLARE_BROWSER_RENDERING_PRIORITY,
    resolve() {
      if (!isCloudflareRuntime()) return null;
      const described = describeCloudflareBrowserBinding();
      if (described.state === "ready") {
        return {
          available: true,
          provider: PROVIDER_ID,
          binding: described.binding,
        };
      }
      // The setup step names what is actually wrong. A binding that exists but
      // is not a browser is not a missing binding, and telling that operator
      // to turn the emitter on sends them to check a variable they already set.
      return {
        available: false,
        provider: PROVIDER_ID,
        reason:
          "This app runs on Cloudflare Workers, which has no Chromium binary — rendering goes through the Browser Rendering binding or not at all.",
        setup: cloudflareBrowserSetupStep(described.state) ?? "",
      };
    },
  });
}
