/**
 * The Cloudflare Browser Rendering binding.
 *
 * A Worker has no Chromium binary and no filesystem to put one on, so the only
 * way it renders a DOM is the `BROWSER` binding. Unlike D1 and R2 there is no
 * resource behind it — it is an account entitlement — so the only two facts
 * worth telling apart are "nothing is bound here" and "something is bound but
 * it is not a browser". Those send an operator to opposite repairs and must
 * never collapse into one value.
 */

/**
 * The Browser Rendering binding name the render path reads, and the one the
 * build emits. Fixed rather than configurable for the same reason as
 * `CLOUDFLARE_D1_BINDING_NAME` and `CLOUDFLARE_R2_BINDING_NAME` — a renameable
 * binding is configuration no reader honours.
 */
export const CLOUDFLARE_BROWSER_BINDING_NAME = "BROWSER";

/**
 * The build variable that turns the emitter on. There is no id or name to
 * derive from, so this declares intent rather than pointing at a resource;
 * `resolveCloudflareBrowserBinding()` in `deploy/build.ts` reads it.
 */
export const CLOUDFLARE_BROWSER_RENDERING_ENV = "CLOUDFLARE_BROWSER_RENDERING";

/**
 * Minimal shape of a Browser Rendering binding. It is a Fetcher: the puppeteer
 * client talks CDP over it. Nothing here calls `fetch` directly — this is only
 * enough to tell a Fetcher from whatever else got bound under the name.
 */
export interface BrowserBindingLike {
  fetch(...args: unknown[]): Promise<unknown>;
}

export type CloudflareBrowserBindingState =
  | { state: "absent" }
  | { state: "malformed" }
  | { state: "ready"; binding: BrowserBindingLike };

function readCloudflareEnv(): Record<string, unknown> | null {
  const scope = globalThis as {
    __cf_env?: Record<string, unknown>;
    __env__?: Record<string, unknown>;
  };
  return scope.__cf_env ?? scope.__env__ ?? null;
}

export function describeCloudflareBrowserBinding(): CloudflareBrowserBindingState {
  const env = readCloudflareEnv();
  if (!env) return { state: "absent" };
  const binding = env[CLOUDFLARE_BROWSER_BINDING_NAME];
  if (binding == null) return { state: "absent" };
  if (
    typeof binding !== "object" ||
    typeof (binding as BrowserBindingLike).fetch !== "function"
  ) {
    return { state: "malformed" };
  }
  return { state: "ready", binding: binding as BrowserBindingLike };
}

/** The setup step for a binding in this state, or null when it is usable. */
export function cloudflareBrowserSetupStep(
  state: CloudflareBrowserBindingState["state"],
): string | null {
  if (state === "ready") return null;
  if (state === "malformed") {
    return `The ${CLOUDFLARE_BROWSER_BINDING_NAME} binding exists but is not a Browser Rendering binding (it has no fetch()). Something else is bound under that name — check the generated wrangler.json, not ${CLOUDFLARE_BROWSER_RENDERING_ENV}.`;
  }
  return `Bind Browser Rendering as ${CLOUDFLARE_BROWSER_BINDING_NAME}: build with ${CLOUDFLARE_BROWSER_RENDERING_ENV}=1, and make sure the account is on a plan that includes Browser Rendering.`;
}
