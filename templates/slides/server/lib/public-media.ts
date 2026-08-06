import { stat } from "fs/promises";
import path from "path";

/**
 * Static media this template maintains by hand or rewrites in place.
 *
 * None of it may live under `public/assets/`: that URL prefix is Vite's
 * content-hashed build output and carries a single `/assets/**` one-year
 * immutable cache rule, which every matching request inherits and no narrower
 * rule can take back. A file replaced in place there serves stale bytes for a
 * year.
 */
export const PUBLIC_GENERATED_DIR = path.resolve(
  process.cwd(),
  "public/generated",
);
export const PUBLIC_LOGOS_DIR = path.resolve(process.cwd(), "public/logos");

/** Where a legacy `/assets/…` URL now resolves. */
export interface LegacyAssetTarget {
  /** Directory the file moved into. */
  dir: string;
  /** Path of the file inside `dir`. */
  relative: string;
  /** Root-relative URL the legacy request should be sent to. */
  url: string;
}

const LEGACY_ASSET_MOVES = [
  { prefix: "generated/", dir: PUBLIC_GENERATED_DIR, urlPrefix: "/generated/" },
  { prefix: "", dir: PUBLIC_LOGOS_DIR, urlPrefix: "/logos/" },
] as const;

/**
 * Map a path that used to sit under `/assets/` onto its new namespace. Decks
 * saved before the move still reference the old URLs, so they are redirected
 * rather than stranded.
 */
export function legacyAssetTarget(rest: string): LegacyAssetTarget | null {
  if (!rest) return null;
  for (const move of LEGACY_ASSET_MOVES) {
    if (!rest.startsWith(move.prefix)) continue;
    const relative = rest.slice(move.prefix.length);
    if (!relative) continue;
    return {
      dir: move.dir,
      relative,
      url: `${move.urlPrefix}${relative}`,
    };
  }
  return null;
}

export type PublicFileLookup =
  | { status: "found"; filepath: string }
  | { status: "forbidden" }
  | { status: "missing" };

/**
 * Resolve `relative` inside `dir`. "Escaped the directory" and "not there" are
 * separate results on purpose: a caller that collapses them answers 404 to a
 * traversal attempt and hides it.
 */
export async function lookupPublicFile(
  dir: string,
  relative: string,
): Promise<PublicFileLookup> {
  const filepath = path.resolve(dir, relative);
  if (!filepath.startsWith(dir + path.sep)) return { status: "forbidden" };
  try {
    await stat(filepath);
    return { status: "found", filepath };
  } catch {
    return { status: "missing" };
  }
}
