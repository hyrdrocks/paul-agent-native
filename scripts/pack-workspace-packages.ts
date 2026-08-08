#!/usr/bin/env node
//
// Build and pack a named set of this workspace's packages into tarballs.
//
// This is the trunk half of the vendoring procedure. It knows how to produce a
// correct build of these packages on a machine that cannot compile native
// addons, and it knows nothing else: no consumer, no destination repository, no
// dependency rewriting, no acceptance gate. A consumer passes the package list
// it wants and an output directory, and reads the manifest printed on stdout to
// learn what it got.
//
// This script IS the documentation for the build half: a written procedure that
// has drifted from reality passes silently, and a script that has drifted throws.
//
// Usage:
//   node scripts/pack-workspace-packages.ts --out-dir <dir> <package>...
//
//   --out-dir <dir>     where the tarballs land (required; created if absent).
//                       Prior versions of the packages named here are removed
//                       from it; every other file in it is left alone.
//   --manifest <file>   also write the stdout manifest here
//   --no-install        skip the dependency install (deps already present)
//   --no-prebuild       skip the workspace prebuild (dist/ already current)
//
// Both skip flags are recorded in the manifest, because a tarball packed over a
// stale dist/ is indistinguishable from a fresh one to whoever installs it.
//
// Packages are named by their directory under packages/. Progress goes to
// stderr and the JSON manifest to stdout, so the manifest can be piped.
//
// Exit codes: 0 packed, 64 usage error, 1 the build or pack failed.

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export class PackUsageError extends Error {}

export interface PackOptions {
  packages: string[];
  outDir: string;
  manifestPath: string | null;
  install: boolean;
  prebuild: boolean;
}

export interface PackageTarget {
  name: string;
  version: string;
  /** Workspace-relative, POSIX-separated: `packages/core`. */
  directory: string;
  absoluteDirectory: string;
}

export interface PackedPackage {
  name: string;
  version: string;
  directory: string;
  tarball: string;
}

export interface PackManifest {
  source: { commit: string; dirty: boolean };
  /**
   * Which build steps this run actually performed. Not every package has a
   * `prepack` of its own, so a skipped prebuild can produce a tarball carrying
   * whatever `dist/` happened to be on disk — and nothing downstream can tell
   * that from a fresh build. A consumer that cares reads this and refuses.
   */
  build: { installed: boolean; prebuilt: boolean };
  packages: PackedPackage[];
}

export function parsePackArgs(argv: string[]): PackOptions {
  const packages: string[] = [];
  let outDir: string | null = null;
  let manifestPath: string | null = null;
  let install = true;
  let prebuild = true;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--out-dir":
      case "--manifest": {
        const value = argv[index + 1];
        if (value === undefined || value.startsWith("--")) {
          throw new PackUsageError(`${arg} needs a directory or file path`);
        }
        if (arg === "--out-dir") outDir = value;
        else manifestPath = value;
        index += 1;
        break;
      }
      case "--no-install":
        install = false;
        break;
      case "--no-prebuild":
        prebuild = false;
        break;
      default:
        if (arg.startsWith("-")) {
          throw new PackUsageError(`unknown option '${arg}'`);
        }
        packages.push(arg);
    }
  }

  if (outDir === null) {
    throw new PackUsageError(
      "--out-dir is required; this script does not choose a destination",
    );
  }
  if (packages.length === 0) {
    throw new PackUsageError(
      "name at least one package to pack, by its directory under packages/",
    );
  }

  return { packages, outDir, manifestPath, install, prebuild };
}

export function resolvePackageTargets(
  workspaceRoot: string,
  names: string[],
): PackageTarget[] {
  return names.map((name) => {
    // A name that escapes packages/ would let a caller pack a template or an
    // arbitrary directory; the list is a declaration, not a path expression.
    if (name !== path.basename(name)) {
      throw new PackUsageError(
        `'${name}' is not a package directory name — name packages by their directory under packages/`,
      );
    }

    const absoluteDirectory = path.join(workspaceRoot, "packages", name);
    const manifestPath = path.join(absoluteDirectory, "package.json");
    if (!existsSync(manifestPath)) {
      throw new PackUsageError(
        `no such package: packages/${name} (looked for ${manifestPath})`,
      );
    }

    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: string;
      version?: string;
    };
    if (!manifest.name) {
      throw new Error(`packages/${name}/package.json declares no name`);
    }
    if (!manifest.version) {
      throw new Error(`packages/${name}/package.json declares no version`);
    }

    return {
      name: manifest.name,
      version: manifest.version,
      directory: `packages/${name}`,
      absoluteDirectory,
    };
  });
}

/** The filename stem `pnpm pack` derives from a package name. */
export function tarballPrefix(packageName: string): string {
  return packageName.replace(/^@/, "").replace(/\//g, "-");
}

/** The filename `pnpm pack` writes, derived rather than guessed by glob. */
export function tarballName(packageName: string, version: string): string {
  return `${tarballPrefix(packageName)}-${version}.tgz`;
}

/**
 * Prior tarballs of the packages this run packed. Matching is anchored on the
 * package name followed by a digit, so `agent-native-core-*` cannot claim
 * `agent-native-core-cli-1.0.0.tgz` — a sibling package, not a stale version.
 */
export function staleTarballs(
  existingFiles: string[],
  packed: Array<{ name: string; tarball: string }>,
): string[] {
  const patterns = packed.map(
    (entry) =>
      new RegExp(
        `^${tarballPrefix(entry.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}-\\d.*\\.tgz$`,
      ),
  );
  return existingFiles.filter((file) =>
    patterns.some((pattern) => pattern.test(file)),
  );
}

export function buildManifest(input: {
  commit: string;
  dirty: boolean;
  installed: boolean;
  prebuilt: boolean;
  packed: PackedPackage[];
}): PackManifest {
  return {
    source: { commit: input.commit, dirty: input.dirty },
    build: { installed: input.installed, prebuilt: input.prebuilt },
    packages: input.packed,
  };
}

function say(message: string): void {
  process.stderr.write(`==> ${message}\n`);
}

function run(command: string, args: string[], cwd: string): void {
  execFileSync(command, args, {
    cwd,
    // Child output goes to stderr, including what the child wrote to ITS stdout:
    // stdout here carries the manifest and nothing else, so a caller can pipe it.
    // "inherit" would splice a build log into the JSON.
    stdio: ["ignore", 2, 2],
    shell: process.platform === "win32",
  });
}

function pnpmExecutable(): string {
  return process.platform === "win32" ? "pnpm.cmd" : "pnpm";
}

function gitState(workspaceRoot: string): { commit: string; dirty: boolean } {
  const read = (args: string[]): string =>
    execFileSync("git", args, { cwd: workspaceRoot, encoding: "utf8" }).trim();
  return {
    commit: read(["rev-parse", "--short", "HEAD"]),
    dirty: read(["status", "--porcelain"]).length > 0,
  };
}

function main(argv: string[]): void {
  const workspaceRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );

  const options = parsePackArgs(argv);

  // Resolve the whole list before building anything: an unknown package name
  // must fail before a twenty-minute build, not after it.
  const targets = resolvePackageTargets(workspaceRoot, options.packages);

  const source = gitState(workspaceRoot);
  say(`workspace at ${source.commit}`);
  if (source.dirty) {
    say("WARNING: the workspace has uncommitted changes — packing them anyway");
    say("         the tarballs will not correspond to any commit");
  }

  if (options.install) {
    // --ignore-scripts is deliberate, not a shortcut. node-pty is a dependency
    // of @agent-native/core and its gyp build needs a C toolchain (make, g++).
    // Where that is absent the build fails, aborts the WHOLE install, leaves the
    // root bins unlinked, and every later prepack dies with an unrelated
    // "tsx: not found". Nothing in these builds needs node-pty's native binary.
    say("installing workspace dependencies (no native builds)");
    run(
      pnpmExecutable(),
      ["install", "--prefer-offline", "--ignore-scripts"],
      workspaceRoot,
    );
  }

  if (options.prebuild) {
    // Skipping scripts also skips the postinstall that prebuilds the workspace
    // packages in topological order. Without it packages/core cannot compile: it
    // imports @agent-native/toolkit subpaths that resolve to toolkit's dist, and
    // you get a wall of "TS2307: Cannot find module '@agent-native/toolkit/…'" —
    // stale-artifact failures wearing the shape of missing code. Run the
    // prebuild by hand, without the `pnpm rebuild better-sqlite3` half of
    // postinstall, which needs the same absent C toolchain that forced
    // --ignore-scripts in the first place.
    say("prebuilding workspace packages (postinstall, minus native rebuilds)");
    run(
      process.execPath,
      ["scripts/prebuild-workspace-packages.ts", "postinstall"],
      workspaceRoot,
    );
  } else {
    // Some packages have no `prepack` of their own, so for those this step is
    // the only thing that rebuilds dist/. Skipping it can pack a stale build
    // that looks identical to a fresh one from the outside.
    say("SKIPPING the workspace prebuild — packing whatever dist/ is on disk");
  }

  // Pack into a staging directory and only touch the output directory once every
  // package has packed. Clearing the destination up front means any later
  // failure leaves the consumer with no tarballs at all, which breaks a fresh
  // clone of a repository that was working a moment ago.
  const stageDir = mkdtempSync(path.join(tmpdir(), "pack-workspace-packages-"));
  const packed: PackedPackage[] = [];
  try {
    for (const target of targets) {
      say(`packing ${target.name} (runs its prepack build)`);
      run(
        pnpmExecutable(),
        ["pack", "--pack-destination", stageDir],
        target.absoluteDirectory,
      );

      // Derived from the manifest, not picked by `ls -t`: a stale tarball left
      // in the staging directory by an interrupted run must not be mistaken for
      // this run's output.
      const tarball = tarballName(target.name, target.version);
      if (!existsSync(path.join(stageDir, tarball))) {
        throw new Error(
          `pnpm pack produced no ${tarball} for ${target.name} in ${stageDir}`,
        );
      }
      packed.push({
        name: target.name,
        version: target.version,
        directory: target.directory,
        tarball,
      });
    }

    const outDir = path.resolve(options.outDir);
    mkdirSync(outDir, { recursive: true });
    for (const stale of staleTarballs(readdirSync(outDir), packed)) {
      rmSync(path.join(outDir, stale), { force: true });
    }
    for (const entry of packed) {
      // Copy rather than rename: the staging directory is under the system temp
      // directory, which is routinely a different filesystem, and renameSync
      // fails with EXDEV across one.
      copyFileSync(
        path.join(stageDir, entry.tarball),
        path.join(outDir, entry.tarball),
      );
      say(`  → ${path.join(options.outDir, entry.tarball)}`);
    }

    const manifest = buildManifest({
      ...source,
      installed: options.install,
      prebuilt: options.prebuild,
      packed,
    });
    const serialized = `${JSON.stringify(manifest, null, 2)}\n`;
    if (options.manifestPath) {
      writeFileSync(path.resolve(options.manifestPath), serialized);
    }
    process.stdout.write(serialized);
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    // A usage error is the caller's mistake and needs one line, not a stack. Any
    // other error is this script or a build failing, and the stack is the only
    // record of where — so it is rethrown rather than summarised into exit 1.
    if (!(error instanceof PackUsageError)) throw error;
    process.stderr.write(`pack-workspace-packages: ${error.message}\n`);
    process.exit(64);
  }
}
