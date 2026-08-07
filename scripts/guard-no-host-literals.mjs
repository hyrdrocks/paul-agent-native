#!/usr/bin/env node
/**
 * guard-no-host-literals.mjs
 *
 * `packages/core/src/hosts/` is a seam: everything the framework knows about a
 * particular host lives behind a registry, and the rest of core asks the
 * registry instead of asking which host it is on. That seam is what the
 * Cloudflare work is upstreamable through — the moment a scheduler, a store or
 * a route decides something for itself by testing for "cloudflare", the seam
 * stops being a boundary and becomes a convention, and the next host costs a
 * search of the whole package instead of one new directory.
 *
 * A directory layout cannot enforce that. This guard does.
 *
 * WHAT IT DETECTS — a host IDENTITY DECISION, not the appearance of a host
 * name. A host name is also an ordinary noun in this codebase: an MCP
 * integration is called `cloudflare`, an eject preset is called `cloudflare`,
 * a provider id is the string `cloudflare`. None of those decide anything
 * about where the code is running, and a guard that flagged them would be
 * noisy in a way that gets it deleted. So the match is the host name in a
 * DECIDING position:
 *
 *     host === "cloudflare"            flagged
 *     case "netlify":                  flagged
 *     preset.startsWith("cloudflare")  flagged
 *     id: "cloudflare"                 fine — a name
 *     preset("cloudflare")             fine — a name
 *     return "netlify"                 fine — a label
 *
 * SCOPE — `packages/core/src/**`, minus `deploy/**` and `cli/**`. Those two
 * decide which host to BUILD FOR, from a target the operator named; the string
 * there is that target's own name and belongs in the build layer. This guard
 * is about code that decides what to DO while serving, which is where naming a
 * host is the seam violation.
 *
 * Only lines ADDED on this branch are checked, the same contract as
 * `no-raw-colors` and `no-silent-coercion`: a pre-existing instance is a
 * separate, schedulable cleanup, and a guard that fails on the backlog is a
 * guard someone turns off.
 *
 * WHAT IT WILL MISS, stated rather than implied: the match is per line, like
 * every other diff-scoped guard here, so a comparison the formatter wrapped
 * across two lines, one against a named constant, or a `HOSTS[name]` dispatch
 * table all get through. That is a floor, not a ceiling — the direct forms are
 * how this is actually written, and a parser here would cost more than it
 * catches.
 *
 * WIDENING THE BOUNDARY is one reviewed edit to HOST_AWARE_MODULES below.
 * That list is the design artifact — it is the answer to "which modules in
 * core are allowed to know what host they are on" — so it is deliberately
 * cheaper to read than a scattering of local opt-outs would be.
 *
 * Opt-out, for a genuine one-off (a fixture, an error message that must name
 * the host, a comment) — put on the flagged line or the one immediately above:
 *
 *   // guard:allow-host-literal — short reason
 *
 * Same diff-base contract as every guard built on changed-lines.mjs: if the
 * base can't be resolved we say so loudly and exit 0 — a silent pass here
 * would look identical to a real clean run.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { addedLines } from "./lib/changed-lines.mjs";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/**
 * The modules allowed to name a host, and why each one is here.
 *
 * Keep this short. Every entry is a module that is permitted to know something
 * the rest of core is not, so an entry nobody can justify costs the list its
 * meaning.
 */
export const HOST_AWARE_MODULES = [
  {
    // The seam itself. One subdirectory per host; naming the host is what
    // these files are for.
    pattern: /^packages\/core\/src\/hosts\//,
    why: "the Host seam",
  },
  {
    // The single runtime-detection module. It tests for the Workers global and
    // the `Cloudflare-Workers` user agent so that nothing else has to; every
    // other module imports isCloudflareRuntime() rather than re-deriving it.
    pattern: /^packages\/core\/src\/shared\/runtime\.ts$/,
    why: "the one runtime-detection module every other module asks",
  },
];

/** Directories whose host names are build targets, not host checks. */
const OUT_OF_SCOPE = [
  /^packages\/core\/src\/deploy\//,
  /^packages\/core\/src\/cli\//,
];

const IN_SCOPE_ROOT = /^packages\/core\/src\//;
const IN_SCOPE_EXT = /\.(ts|tsx)$/;
const EXCLUDED_TEST_FILE = /\.(stories|spec|test)\./;
const EXCLUDED_BUILD_DIR = /\/(node_modules|dist|build|\.output|coverage)\//;

/**
 * Host identities the framework models. Derived from the adapters under
 * `src/hosts/` plus the hosted presets the deploy layer targets — if a new
 * host adapter is added, its id belongs here too.
 */
const HOST_TOKENS = [
  "cloudflare",
  "workerd",
  "netlify",
  "vercel",
  "aws-lambda",
];

/** `cloudflare`, `cloudflare-pages`, `Cloudflare-Workers`, `cloudflare_module`. */
const TOKEN_ALT = HOST_TOKENS.join("|");
const HOST_LITERAL = `["'\`](?:${TOKEN_ALT})(?:[-_][a-z0-9-_]+)?["'\`]`;

/**
 * The deciding positions. Each of these is a branch on host identity; a host
 * name anywhere else in an expression is a name, not a decision.
 */
const DECIDING_PATTERNS = [
  {
    re: new RegExp(`(?:===|!==|==|!=)\\s*${HOST_LITERAL}`, "i"),
    shape: "compared against a host name",
  },
  {
    re: new RegExp(`${HOST_LITERAL}\\s*(?:===|!==|==|!=)`, "i"),
    shape: "compared against a host name",
  },
  {
    re: new RegExp(`\\bcase\\s+${HOST_LITERAL}\\s*:`, "i"),
    shape: "switched on a host name",
  },
  {
    re: new RegExp(
      `\\.(?:startsWith|endsWith|includes|match)\\(\\s*${HOST_LITERAL}`,
      "i",
    ),
    shape: "tested for a host name",
  },
];

const PRAGMA = /(?:\/\/|\/\*)\s*guard:allow-host-literal\b/;

const HELP = `    Core outside the Host seam must not decide anything from which host it
    is on. Ask the seam instead:
      a host capability      -> register it under packages/core/src/hosts/<host>/
                                and resolve it through the registry; see
                                packages/core/src/hosts/fallback-storage.ts for
                                the registry/refusal shape
      "am I on this runtime" -> import isCloudflareRuntime() / isNodeRuntime()
                                from packages/core/src/shared/runtime.ts
    To widen the boundary instead, add the module to HOST_AWARE_MODULES in
    scripts/guard-no-host-literals.mjs — one reviewed edit, so the list stays
    the record of which modules are allowed to know.`;

/** True when this path is subject to the rule at all. */
export function inScope(relPath) {
  if (EXCLUDED_BUILD_DIR.test(`/${relPath}`)) return false;
  if (!IN_SCOPE_ROOT.test(relPath)) return false;
  if (!IN_SCOPE_EXT.test(relPath)) return false;
  if (EXCLUDED_TEST_FILE.test(relPath)) return false;
  if (OUT_OF_SCOPE.some((re) => re.test(relPath))) return false;
  if (HOST_AWARE_MODULES.some(({ pattern }) => pattern.test(relPath))) {
    return false;
  }
  return true;
}

/**
 * A violation descriptor for one line, or null. Exported so the guard's own
 * test can exercise the detector directly — the diff plumbing is tested
 * end-to-end separately.
 */
export function checkLine(lineText) {
  for (const { re, shape } of DECIDING_PATTERNS) {
    const match = re.exec(lineText);
    if (match) return { snippet: match[0].trim(), shape };
  }
  return null;
}

/**
 * Violations among `lineNumbers` (1-based) of `lines`. The one place the pragma
 * lookbehind and the per-line check live, so the whole-file and diff-scoped
 * callers cannot drift apart about what counts.
 */
function violationsForLines(lines, lineNumbers) {
  const violations = [];
  for (const lineNumber of [...lineNumbers].sort((a, b) => a - b)) {
    const lineText = lines[lineNumber - 1];
    if (lineText === undefined) continue;
    const prevLine = lineNumber >= 2 ? lines[lineNumber - 2] : "";
    if (PRAGMA.test(lineText) || PRAGMA.test(prevLine)) continue;
    const violation = checkLine(lineText);
    if (!violation) continue;
    violations.push({ lineNumber, text: lineText.trim(), ...violation });
  }
  return violations;
}

/** Every violating line in `source`, for a file already known to be in scope. */
export function findHostLiteralViolations(relPath, source) {
  if (!inScope(relPath)) return [];
  const lines = source.split("\n");
  return violationsForLines(
    lines,
    lines.map((_, i) => i + 1),
  );
}

function main() {
  const added = addedLines(REPO_ROOT);
  if (added === null) {
    console.error(
      "guard-no-host-literals: could not resolve a diff base against this " +
        "branch (checked GUARD_DIFF_BASE/GITHUB_BASE_REF, origin/main, main) " +
        "— cannot tell which lines are new. Skipping the check rather than " +
        "reporting a false pass; this is not a clean result.",
    );
    process.exit(0);
  }

  const violations = [];

  for (const [absFile, lineNumbers] of added) {
    const relPath = path.relative(REPO_ROOT, absFile).replace(/\\/g, "/");
    if (!inScope(relPath)) continue;

    let src;
    try {
      src = readFileSync(absFile, "utf8");
    } catch {
      continue; // renamed or deleted since diffing
    }
    for (const violation of violationsForLines(src.split("\n"), lineNumbers)) {
      violations.push({ relPath, ...violation });
    }
  }

  if (violations.length === 0) {
    console.log("guard-no-host-literals: OK");
    process.exit(0);
  }

  console.error(
    `\nguard-no-host-literals: ${violations.length} host identity ` +
      `decision(s) added on this branch outside the Host seam.\n`,
  );
  for (const v of violations) {
    console.error(`  ${v.relPath}:${v.lineNumber}  ${v.text}`);
    console.error(`    found: ${v.snippet}  (${v.shape})`);
    console.error(HELP);
    console.error("");
  }
  console.error(
    "For a genuine one-off exception add the comment:\n" +
      "  // guard:allow-host-literal — <reason>\n" +
      "on the same line or the line immediately above it.\n",
  );
  process.exit(1);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
