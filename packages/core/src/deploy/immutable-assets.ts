import fs from "fs";
import path from "path";

export const IMMUTABLE_ASSET_CACHE_CONTROL =
  "public, max-age=31536000, immutable";

export const IMMUTABLE_ASSET_CACHE_HEADERS = {
  "cache-control": IMMUTABLE_ASSET_CACHE_CONTROL,
  "cdn-cache-control": IMMUTABLE_ASSET_CACHE_CONTROL,
  "netlify-cdn-cache-control": IMMUTABLE_ASSET_CACHE_CONTROL,
} as const;

const IMMUTABLE_ASSET_FILENAME_PATTERN = "[^/]+-[A-Za-z0-9_-]{8}\\.[a-z0-9]+";

export const IMMUTABLE_ASSET_PATH_PATTERN = `^/assets/${IMMUTABLE_ASSET_FILENAME_PATTERN}$`;

const IMMUTABLE_ASSET_PATH_RE = new RegExp(IMMUTABLE_ASSET_PATH_PATTERN);

export function isImmutableAssetPath(pathname: string): boolean {
  // Vite emits content-hashed production chunks under /assets/. Those URLs are
  // stable forever because any content change produces a new filename, so they
  // should be cached for a year at both the browser and CDN layer. Keep this
  // exact hashed-file check wherever a header is decided per request; broad
  // /assets/* immutable caching would pin manually named files like logo.png
  // that templates may replace in place. Static header *files* cannot afford
  // that precision — see IMMUTABLE_ASSET_ROUTE_GLOB.
  return IMMUTABLE_ASSET_PATH_RE.test(pathname);
}

/**
 * The single route rule that carries the immutable policy into generated
 * static header files (`_headers`).
 *
 * Cloudflare rejects a `_headers` file with more than 100 rules, and Nitro
 * writes one rule per route rule, so enumerating each hashed asset fails
 * `wrangler deploy` on any real app — `wrangler dev` only warns, which is how
 * an over-limit file reaches a deploy unnoticed. A glob is the only shape that
 * stays inside the cap at any asset count, and content hashing is what makes
 * it safe: the filename changes when the bytes do.
 *
 * It is wider than `isImmutableAssetPath`: files a template ships under
 * `public/assets/` are covered too, and no narrower rule can take that back —
 * every matching `_headers` rule applies and duplicate header names are
 * comma-joined rather than overridden. Ship static files that are replaced in
 * place outside `/assets/`.
 */
export const IMMUTABLE_ASSET_ROUTE_GLOB = "/assets/**";

/**
 * The same collapse for a Netlify `_headers` file, which matches paths with
 * `*` and `:placeholder` only and has no regex form — so nothing there can
 * require a content hash in the filename.
 *
 * `:file` rather than `*` because a Netlify placeholder matches one path
 * segment where `*` crosses `/`: this covers `assets/` itself and stops,
 * leaving a subdirectory of hand-maintained files uncovered instead of pinned
 * for a year. What it still cannot exclude is an unhashed file sitting
 * *directly* in `assets/`, and no later block can take the header back —
 * duplicate header names comma-join rather than override. Callers must report
 * what they widened; see collectNetlifyPinnedMutableAssetPaths.
 */
export const NETLIFY_IMMUTABLE_ASSET_HEADER_PATH = "/assets/:file";

/**
 * The immutable policy as one anchored regex under `prefix`, for platforms
 * whose static route config matches on a regex (Vercel's `src`). A regex can
 * keep the exact hashed-filename test that a glob has to give up, so an
 * unhashed file sitting in the same directory is *not* newly covered — the
 * widening a `_headers` file is forced into is not forced here.
 *
 * `prefix` is a literal path segment, escaped rather than interpolated as
 * pattern syntax.
 */
export function immutableAssetPathRegex(prefix: string): string {
  return `^${escapeRegExp(prefix)}/assets/${IMMUTABLE_ASSET_FILENAME_PATTERN}$`;
}

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Files under `assets/` that the glob now covers but that no content hash
 * protects. Callers report these; a build that silently pins one for a year is
 * exactly the failure the glob trades away.
 */
export function collectMutableAssetPaths(rootDir: string): string[] {
  return scanAssetPaths(rootDir).filter((p) => !isImmutableAssetPath(p));
}

/**
 * The unhashed files NETLIFY_IMMUTABLE_ASSET_HEADER_PATH actually pins: the
 * ones directly in `assets/`, not the subdirectories a single-segment
 * placeholder leaves uncovered. Reporting the wider set would name files that
 * are not in fact cached for a year.
 */
export function collectNetlifyPinnedMutableAssetPaths(
  rootDir: string,
): string[] {
  return collectMutableAssetPaths(rootDir).filter(
    (assetPath) => !assetPath.slice("/assets/".length).includes("/"),
  );
}

export function normalizeBasePath(basePath: string | undefined): string {
  const raw = String(basePath ?? "").trim();
  if (!raw || raw === "/") return "";
  const normalized = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  return normalized ? `/${normalized}` : "";
}

export function prefixAssetPath(
  pathname: string,
  basePath: string | undefined,
): string {
  const base = normalizeBasePath(basePath);
  if (!base) return pathname;
  return `${base}${pathname}`;
}

export function hasAssetsDir(rootDir: string): boolean {
  return fs.existsSync(path.join(rootDir, "assets"));
}

export function collectImmutableAssetPaths(rootDir: string): string[] {
  return scanAssetPaths(rootDir).filter(isImmutableAssetPath);
}

function scanAssetPaths(rootDir: string): string[] {
  const assetsDir = path.join(rootDir, "assets");
  if (!fs.existsSync(assetsDir)) return [];

  const paths: string[] = [];
  const scan = (dir: string, relDir = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const absPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(absPath, relPath);
        continue;
      }
      if (!entry.isFile()) continue;

      paths.push(`/assets/${relPath}`);
    }
  };

  scan(assetsDir);
  return paths.sort();
}
