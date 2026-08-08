#!/usr/bin/env node
//
// Re-baseline every workspace package onto the Upstream version it now forks.
//
// changesets can only increment the version already in package.json, so it can
// never carry the fork from 0.134.0-paul.2 to Upstream's 0.145.2: a re-baseline
// is a merge resolution, not a bump. This script performs that one resolution
// and nothing else. For each package it copies the `version` value verbatim from
// the named Upstream commit, so it chooses no number and every result is
// checkable with `git show <ref>:packages/<pkg>/package.json`.
//
// Run `changeset version` afterwards to put the -paul.N tag back on top. Keep
// that a PATCH. A minor or major release of @agent-native/core is what makes
// changesets treat dispatch, creative-context, scheduling, pinpoint and frame —
// each of which declares core as a peerDependency — as out of range and bump
// every one of them to a new major, landing dispatch on 1.0.0.
//
// Every workspace member gets a line, including the ones nothing is done to. A
// package missing from the report is indistinguishable from one that was
// considered and left alone, and the difference is the whole point of reading it.
//
// Usage:
//   node scripts/rebaseline-to-upstream.ts <upstream-ref> [--dry-run]
//
// Exit codes: 0 planned or applied, 64 usage error, 1 the plan could not be read.

import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class RebaselineUsageError extends Error {}

export interface RebaselineOptions {
  upstreamRef: string;
  dryRun: boolean;
}

export type RebaselineDecision =
  | { action: "rebaseline"; from: string; to: string; sameTuple: boolean }
  | { action: "unchanged"; version: string }
  | { action: "ahead"; forkVersion: string; upstreamVersion: string }
  | { action: "fork-only"; forkVersion: string }
  | { action: "no-version"; upstreamVersion: string | null };

export interface RebaselineEntry {
  name: string;
  file: string;
  decision: RebaselineDecision;
}

export function parseRebaselineArgs(argv: string[]): RebaselineOptions {
  let upstreamRef: string | null = null;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new RebaselineUsageError(`unknown option '${arg}'`);
    }
    if (upstreamRef !== null) {
      throw new RebaselineUsageError(
        `expected one Upstream ref, got '${upstreamRef}' and '${arg}'`,
      );
    }
    upstreamRef = arg;
  }
  if (upstreamRef === null) {
    throw new RebaselineUsageError("an Upstream ref is required");
  }
  return { upstreamRef, dryRun };
}

// Read by hand rather than through a YAML library: this runs in a checkout that
// may have no node_modules yet — re-baselining is a release-time step, and an
// import that only resolves after `pnpm install` would make it unrunnable
// exactly when someone reaches for it. The parse is deliberately narrow and
// throws on anything it does not recognise instead of returning a short list.
export function parseWorkspaceGlobs(workspaceYaml: string): string[] {
  const lines = workspaceYaml.split("\n");
  const start = lines.findIndex((line) => /^packages:\s*(#.*)?$/.test(line));
  if (start === -1) {
    if (lines.some((line) => /^packages:/.test(line))) {
      throw new Error(
        "pnpm-workspace.yaml states `packages:` inline; this reader only understands a block sequence",
      );
    }
    throw new Error("pnpm-workspace.yaml declares no member globs");
  }
  const globs: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s+-\s+(.+?)\s*(?:#.*)?$/.exec(line);
    if (!item) break;
    globs.push(item[1].replace(/^["']|["']$/g, ""));
  }
  if (globs.length === 0) {
    throw new Error("pnpm-workspace.yaml declares no member globs");
  }
  return globs;
}

// pnpm's member globs use `*` for exactly one path segment, which is all this
// workspace uses. Anything richer belongs to a glob library, not here — so an
// unsupported pattern throws rather than quietly matching nothing.
export function workspaceManifests(root: string, globs: string[]): string[] {
  const files = new Set<string>();
  for (const glob of globs) {
    const segments = glob.split("/");
    if (segments.filter((s) => s === "*").length !== 1) {
      throw new Error(`unsupported workspace glob '${glob}'`);
    }
    const star = segments.indexOf("*");
    const prefix = segments.slice(0, star);
    const suffix = segments.slice(star + 1);
    for (const entry of listDirectories(path.join(root, ...prefix))) {
      const file = [...prefix, entry, ...suffix, "package.json"].join("/");
      if (readManifest(path.join(root, file)) !== null) files.add(file);
    }
  }
  return [...files].sort();
}

function listDirectories(dir: string): string[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

// A missing manifest and an unreadable one are different facts: ENOENT/ENOTDIR
// mean this directory is not a package, anything else means the file is there
// and broken, which must not be reported as absence.
function readManifest(
  file: string,
): { name?: string; version?: string } | null {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
  return JSON.parse(raw);
}

function tupleOf(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+]|$)/.exec(version);
  if (!match) {
    throw new Error(`cannot read '${version}' as a major.minor.patch version`);
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareTuples(a: string, b: string): number {
  const left = tupleOf(a);
  const right = tupleOf(b);
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}

// Comparing tuples is enough here, and comparing prereleases would be wrong.
// When the tuples are equal the fork carries -paul.N, which sorts BELOW the
// plain Upstream release of the same tuple — so it is behind, not ahead, and
// re-baselining it to the plain number is what lets the tag be re-applied.
export function decideRebaseline(
  forkVersion: string | undefined,
  upstreamVersion: string | null,
): RebaselineDecision {
  if (forkVersion === undefined)
    return { action: "no-version", upstreamVersion };
  if (upstreamVersion === null) return { action: "fork-only", forkVersion };
  if (forkVersion === upstreamVersion) {
    return { action: "unchanged", version: forkVersion };
  }
  const order = compareTuples(forkVersion, upstreamVersion);
  if (order > 0) {
    return { action: "ahead", forkVersion, upstreamVersion };
  }
  return {
    action: "rebaseline",
    from: forkVersion,
    to: upstreamVersion,
    sameTuple: order === 0,
  };
}

export function rewriteVersion(
  manifest: string,
  from: string,
  to: string,
): string {
  const needle = `"version": ${JSON.stringify(from)}`;
  const first = manifest.indexOf(needle);
  if (first === -1) {
    throw new Error(`${needle} not found in the manifest`);
  }
  if (manifest.indexOf(needle, first + 1) !== -1) {
    throw new Error(`${needle} appears twice in the manifest`);
  }
  return manifest.replace(needle, `"version": ${JSON.stringify(to)}`);
}

export function planRebaseline(
  root: string,
  files: string[],
  readUpstreamVersion: (file: string) => string | null,
): RebaselineEntry[] {
  const plan: RebaselineEntry[] = [];
  for (const file of files) {
    const manifest = readManifest(path.join(root, file));
    if (manifest === null) {
      throw new Error(`${file} disappeared between the scan and the plan`);
    }
    plan.push({
      name: manifest.name ?? file,
      file,
      decision: decideRebaseline(manifest.version, readUpstreamVersion(file)),
    });
  }
  return plan.sort((a, b) => a.name.localeCompare(b.name));
}

export function applyRebaseline(root: string, plan: RebaselineEntry[]): void {
  for (const entry of plan) {
    if (entry.decision.action !== "rebaseline") continue;
    const file = path.join(root, entry.file);
    const manifest = readFileSync(file, "utf8");
    writeFileSync(
      file,
      rewriteVersion(manifest, entry.decision.from, entry.decision.to),
    );
  }
}

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  }).trim();
}

function upstreamReader(
  root: string,
  upstreamRef: string,
): (file: string) => string | null {
  execFileSync("git", ["rev-parse", "--verify", `${upstreamRef}^{commit}`], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
  });
  // Listing the tree first keeps "Upstream does not have this package" a fact
  // rather than a caught error: a `git show` that fails afterwards is a real
  // failure and is allowed to throw.
  const present = new Set(
    execFileSync("git", ["ls-tree", "-r", "--name-only", upstreamRef], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    })
      .split("\n")
      .filter(Boolean),
  );
  return (file) => {
    if (!present.has(file)) return null;
    const manifest = execFileSync("git", ["show", `${upstreamRef}:${file}`], {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(manifest).version ?? null;
  };
}

function describe(entry: RebaselineEntry): string {
  const { decision } = entry;
  const name = entry.name.padEnd(44);
  switch (decision.action) {
    case "rebaseline":
      return `rebaseline  ${name}  ${decision.from} -> ${decision.to}${
        decision.sameTuple
          ? "   WARNING: Upstream has already published this exact number; it needs a" +
            " changeset to move off it before publish, or publish will silently skip it"
          : ""
      }`;
    case "ahead":
      return `ahead       ${name}  ${decision.forkVersion} > upstream ${decision.upstreamVersion}, left alone`;
    case "fork-only":
      return `fork-only   ${name}  ${decision.forkVersion}, not in Upstream`;
    case "no-version":
      return `no-version  ${name}  declares no version, nothing to re-baseline`;
    case "unchanged":
      return `unchanged   ${name}  ${decision.version}`;
  }
}

function main(argv: string[]): void {
  const options = parseRebaselineArgs(argv);
  const root = repoRoot();
  const globs = parseWorkspaceGlobs(
    readFileSync(path.join(root, "pnpm-workspace.yaml"), "utf8"),
  );
  const files = workspaceManifests(root, globs);
  const plan = planRebaseline(
    root,
    files,
    upstreamReader(root, options.upstreamRef),
  );
  // Templates and examples legitimately carry no version, and one line each
  // buries the handful that matter. They are still named, one per line's worth,
  // so a package that LOST its version in a bad merge is still visible here.
  const versionless = plan.filter((e) => e.decision.action === "no-version");
  for (const entry of plan) {
    if (entry.decision.action === "no-version") continue;
    process.stdout.write(`${describe(entry)}\n`);
  }
  if (versionless.length > 0) {
    process.stdout.write(
      `no-version  ${versionless.length}: ${versionless.map((e) => e.name).join(", ")}\n`,
    );
  }

  const changing = plan.filter((e) => e.decision.action === "rebaseline");
  process.stdout.write(`\n${plan.length} workspace package(s) considered\n`);
  if (options.dryRun) {
    process.stdout.write(`${changing.length} would be re-baselined\n`);
    return;
  }
  applyRebaseline(root, changing);
  process.stdout.write(
    `${changing.length} re-baselined — run \`pnpm changeset:version\` to re-apply the prerelease tag\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // A usage error is the caller's mistake and needs one line, not a stack. Any
    // other error is git or a manifest failing, and the stack is the only record
    // of where — so it is rethrown rather than summarised into exit 1.
    if (!(error instanceof RebaselineUsageError)) throw error;
    process.stderr.write(`rebaseline-to-upstream: ${error.message}\n`);
    process.stderr.write(
      "usage: node scripts/rebaseline-to-upstream.ts <upstream-ref> [--dry-run]\n",
    );
    process.exit(64);
  }
}
