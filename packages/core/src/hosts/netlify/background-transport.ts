/**
 * The Netlify durable background transport.
 *
 * The handoff is an HTTP POST to the emitted background function's DEFAULT url
 * (`/.netlify/functions/<name>`, or `<app>-agent-background` per app in a
 * workspace deploy). That function declares `background: true` and no custom
 * `config.path`, so any invocation of that url is async: an immediate 202 and a
 * 15-minute budget. The Nitro `server` function already excludes `/.netlify/*`
 * from its `/*` catch-all, so the url is never shadowed by the synchronous
 * function.
 *
 * This is the DOC-CORRECT approach. An earlier attempt gave the function a
 * custom `config.path` plus a catch-all `excludedPath` patch; the custom path
 * was NOT honored as a route in prod (probe → 404). The function is emitted by
 * `emitSingleTemplateNetlifyBackgroundFunction` in `deploy/build.ts`, and its
 * entry rewrites the incoming pathname to `AGENT_CHAT_PROCESS_RUN_PATH`
 * (base-path-prefixed for workspaces) before delegating to the Nitro router, so
 * `_process-run` runs with the async 15-min budget.
 */

import { registerBackgroundTransport } from "../../agent/background-transports.js";
import {
  AGENT_BACKGROUND_FUNCTION_URL_PATH,
  resolveWorkspaceBackgroundFunctionUrlPath,
} from "../../agent/durable-background.js";

/**
 * Declared ahead of every other host: this host's background function is the
 * incumbent transport, and its regression — quietly dropping to the in-process
 * route and losing the long budget — is invisible to a run on any other host.
 * A host added later must not be able to displace it by registering earlier.
 */
const NETLIFY_BACKGROUND_FUNCTION_PRIORITY = 10;

/**
 * Names the handoff mechanism, not the host: a POST to a url that carries its
 * own long budget. A second host with the same mechanism registers its own id
 * rather than sharing this one — ids are a routing key back to the transport
 * that resolved the target.
 */
const HTTP_TRANSPORT_ID = "http";

function isNetlifyHostedRuntimeForDispatch(): boolean {
  if (process.env.NETLIFY_LOCAL === "true") return false;
  if (process.env.NETLIFY === "false") return false;
  if (process.env.NETLIFY && process.env.NETLIFY !== "false") return true;
  // NETLIFY is a build-only read-only variable. In deployed Functions Netlify
  // documents URL, SITE_NAME, and SITE_ID as the runtime read-only variables;
  // SITE_ID is the unambiguous host marker. Lambda compatibility mode also
  // exposes AWS runtime variables, so keep the function-name fallback for older
  // deploys. Without either check a modern Netlify Function silently selects the
  // portable framework route even though the emitted background function exists.
  if (process.env.SITE_ID) return true; // guard:allow-env-credential - Netlify's read-only public site identifier is a runtime host marker, not a user credential.
  // Non-Netlify AWS falls back inline if the /.netlify/functions dispatch
  // fast-fails.
  return Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
}

export function registerNetlifyBackgroundTransport(): void {
  registerBackgroundTransport({
    id: HTTP_TRANSPORT_ID,
    priority: NETLIFY_BACKGROUND_FUNCTION_PRIORITY,
    // The function 202s on enqueue in well under a second and the foreground
    // awaits that status, so a worker that will never run is already a failure
    // the call site can see.
    acknowledgesWithoutClaim: false,
    resolve() {
      if (!isNetlifyHostedRuntimeForDispatch()) return null;
      return {
        kind: HTTP_TRANSPORT_ID,
        path:
          resolveWorkspaceBackgroundFunctionUrlPath() ??
          AGENT_BACKGROUND_FUNCTION_URL_PATH,
        expectsBackgroundRuntime: true,
      };
    },
  });
}
