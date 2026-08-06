import fs from "fs";
import path from "path";

export const IMMUTABLE_ASSET_CACHE_CONTROL =
  "public, max-age=31536000, immutable";

export const IMMUTABLE_ASSET_CACHE_HEADERS = {
  "cache-control": IMMUTABLE_ASSET_CACHE_CONTROL,
  "cdn-cache-control": IMMUTABLE_ASSET_CACHE_CONTROL,
  "netlify-cdn-cache-control": IMMUTABLE_ASSET_CACHE_CONTROL,
} as const;

export const IMMUTABLE_ASSET_PATH_PATTERN =
  "^/assets/[^/]+-[A-Za-z0-9_-]{8}\\.[a-z0-9]+$";

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
 * Files under `assets/` that the glob now covers but that no content hash
 * protects. Callers report these; a build that silently pins one for a year is
 * exactly the failure the glob trades away.
 */
export function collectMutableAssetPaths(rootDir: string): string[] {
  return scanAssetPaths(rootDir).filter((p) => !isImmutableAssetPath(p));
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
