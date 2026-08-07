/**
 * The public browser-rendering seam.
 *
 * The host adapter is imported BY VALUE and registered here, not reached
 * through `hosts/index.js`. A side-effect-only import of the host barrel is
 * dropped by any bundler honouring this package's `sideEffects` field, and the
 * seam then answers "no host claimed this process" — which reads as a plain
 * Node run and sends a Worker off to launch a Chromium binary it does not
 * have. The edge runs seam -> host and never the reverse.
 */

import { registerCloudflareBrowserRendering } from "../hosts/cloudflare/browser-rendering.js";

export {
  type BrowserBindingLike,
  CLOUDFLARE_BROWSER_BINDING_NAME,
  CLOUDFLARE_BROWSER_RENDERING_ENV,
  type CloudflareBrowserBindingState,
  cloudflareBrowserSetupStep,
  describeCloudflareBrowserBinding,
} from "./cloudflare-browser.js";
export {
  type BrowserRenderingDecision,
  type BrowserRenderingProvider,
  type BrowserRenderingRefusal,
  listBrowserRenderingProviders,
  registerBrowserRenderingProvider,
  resolveBrowserRenderingDecision,
  unregisterBrowserRenderingProvider,
} from "./registry.js";

registerCloudflareBrowserRendering();
