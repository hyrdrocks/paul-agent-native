import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  PackUsageError,
  buildManifest,
  parsePackArgs,
  resolvePackageTargets,
  staleTarballs,
  tarballName,
} from "./pack-workspace-packages";

function workspaceFixture(
  packages: Record<string, { name: string; version: string }>,
): string {
  const root = mkdtempSync(path.join(tmpdir(), "pack-workspace-"));
  for (const [dir, manifest] of Object.entries(packages)) {
    const packageDir = path.join(root, "packages", dir);
    mkdirSync(packageDir, { recursive: true });
    writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify(manifest),
    );
  }
  return root;
}

describe("parsePackArgs", () => {
  it("reads an arbitrary package list and an output directory", () => {
    const options = parsePackArgs([
      "--out-dir",
      "/tmp/vendor",
      "core",
      "dispatch",
      "creative-context",
    ]);

    assert.deepEqual(options.packages, [
      "core",
      "dispatch",
      "creative-context",
    ]);
    assert.equal(options.outDir, "/tmp/vendor");
    assert.equal(options.install, true);
    assert.equal(options.prebuild, true);
    assert.equal(options.manifestPath, null);
  });

  it("rejects an empty package list", () => {
    assert.throws(
      () => parsePackArgs(["--out-dir", "/tmp/vendor"]),
      PackUsageError,
    );
  });

  it("rejects a missing --out-dir rather than defaulting to one", () => {
    assert.throws(() => parsePackArgs(["core"]), PackUsageError);
  });

  it("rejects unknown options", () => {
    assert.throws(
      () => parsePackArgs(["--out-dir", "/tmp/vendor", "--probe", "core"]),
      PackUsageError,
    );
  });

  it("accepts the skip flags and a manifest path", () => {
    const options = parsePackArgs([
      "--out-dir",
      "/tmp/vendor",
      "--no-install",
      "--no-prebuild",
      "--manifest",
      "/tmp/vendor/manifest.json",
      "core",
    ]);

    assert.equal(options.install, false);
    assert.equal(options.prebuild, false);
    assert.equal(options.manifestPath, "/tmp/vendor/manifest.json");
  });
});

describe("resolvePackageTargets", () => {
  it("resolves directory names under packages/ to their real package names", () => {
    const root = workspaceFixture({
      core: { name: "@agent-native/core", version: "0.134.0-paul.2" },
      "creative-context": {
        name: "@agent-native/creative-context",
        version: "0.3.1",
      },
    });

    const targets = resolvePackageTargets(root, ["core", "creative-context"]);

    assert.deepEqual(
      targets.map((target) => [target.name, target.version, target.directory]),
      [
        ["@agent-native/core", "0.134.0-paul.2", "packages/core"],
        [
          "@agent-native/creative-context",
          "0.3.1",
          "packages/creative-context",
        ],
      ],
    );
  });

  it("fails on an unknown package instead of packing the ones it recognises", () => {
    const root = workspaceFixture({
      core: { name: "@agent-native/core", version: "1.0.0" },
    });

    assert.throws(
      () => resolvePackageTargets(root, ["core", "not-a-package"]),
      /not-a-package/,
    );
  });

  it("fails on a package whose manifest has no version to pack", () => {
    const root = workspaceFixture({
      core: { name: "@agent-native/core" } as { name: string; version: string },
    });

    assert.throws(() => resolvePackageTargets(root, ["core"]), /version/);
  });

  it("rejects a package name that escapes packages/", () => {
    const root = workspaceFixture({
      core: { name: "@agent-native/core", version: "1.0.0" },
    });

    assert.throws(
      () => resolvePackageTargets(root, ["../templates/crm"]),
      PackUsageError,
    );
  });
});

describe("tarballName", () => {
  it("matches the name pnpm pack writes for a scoped package", () => {
    assert.equal(
      tarballName("@agent-native/core", "0.134.0-paul.2"),
      "agent-native-core-0.134.0-paul.2.tgz",
    );
  });

  it("matches the name pnpm pack writes for an unscoped package", () => {
    assert.equal(tarballName("recap-cli", "1.2.3"), "recap-cli-1.2.3.tgz");
  });
});

describe("staleTarballs", () => {
  it("selects prior versions of the packages just packed", () => {
    const stale = staleTarballs(
      [
        "agent-native-core-0.133.0-paul.1.tgz",
        "agent-native-core-0.134.0-paul.2.tgz",
        "agent-native-dispatch-0.16.6.tgz",
      ],
      [
        {
          name: "@agent-native/core",
          tarball: "agent-native-core-0.134.0.tgz",
        },
      ],
    );

    assert.deepEqual(stale, [
      "agent-native-core-0.133.0-paul.1.tgz",
      "agent-native-core-0.134.0-paul.2.tgz",
    ]);
  });

  it("leaves tarballs of packages this run did not pack alone", () => {
    const stale = staleTarballs(
      ["agent-native-dispatch-0.16.6.tgz", "unrelated.tgz"],
      [{ name: "@agent-native/core", tarball: "agent-native-core-1.0.0.tgz" }],
    );

    assert.deepEqual(stale, []);
  });

  it("does not treat a longer package name as a version of a shorter one", () => {
    const stale = staleTarballs(
      ["agent-native-core-cli-1.0.0.tgz"],
      [{ name: "@agent-native/core", tarball: "agent-native-core-2.0.0.tgz" }],
    );

    assert.deepEqual(stale, []);
  });
});

describe("buildManifest", () => {
  it("names every packed package so a consumer needs no hardcoded list", () => {
    const manifest = buildManifest({
      commit: "abc1234",
      dirty: false,
      packed: [
        {
          name: "@agent-native/core",
          version: "1.0.0",
          directory: "packages/core",
          tarball: "agent-native-core-1.0.0.tgz",
        },
      ],
    });

    assert.deepEqual(manifest, {
      source: { commit: "abc1234", dirty: false },
      packages: [
        {
          name: "@agent-native/core",
          version: "1.0.0",
          directory: "packages/core",
          tarball: "agent-native-core-1.0.0.tgz",
        },
      ],
    });
  });

  it("records an uncommitted source tree so a consumer can refuse it", () => {
    const manifest = buildManifest({
      commit: "abc1234",
      dirty: true,
      packed: [],
    });

    assert.equal(manifest.source.dirty, true);
  });
});
