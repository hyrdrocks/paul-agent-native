import {
  defineEventHandler,
  getRouterParam,
  sendRedirect,
  setResponseStatus,
} from "h3";

import { legacyAssetTarget, lookupPublicFile } from "../../lib/public-media";

/**
 * Legacy `/assets/…` URLs for the media this template used to ship under
 * `public/assets/`. Only requests no build output claims reach this handler.
 *
 * It redirects instead of streaming the bytes: `/assets/**` carries the
 * one-year immutable cache rule, so a body served here would be pinned for a
 * year again. The rename is permanent, but its target keeps serving fresh
 * bytes when an image is replaced in place.
 */
export default defineEventHandler(async (event) => {
  const rest = getRouterParam(event, "_", { decode: true }) ?? "";
  const target = legacyAssetTarget(rest);
  if (!target) {
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }

  const found = await lookupPublicFile(target.dir, target.relative);
  if (found.status === "forbidden") {
    setResponseStatus(event, 403);
    return { error: "Forbidden" };
  }
  if (found.status === "missing") {
    setResponseStatus(event, 404);
    return { error: "Not found" };
  }

  // Keep whatever prefix the request arrived with; the app can be mounted under
  // a base path. Anything that reached this handler without `/assets/` in its
  // path was not mounted the way this assumes, so redirect from the root rather
  // than from a silently truncated prefix.
  const mountEnd = event.path.indexOf("/assets/");
  const mount = mountEnd > 0 ? event.path.slice(0, mountEnd) : "";
  return sendRedirect(event, `${mount}${target.url}`, 301);
});
