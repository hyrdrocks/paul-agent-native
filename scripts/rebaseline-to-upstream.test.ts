import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  RebaselineUsageError,
  applyRebaseline,
  decideRebaseline,
  parseRebaselineArgs,
  parseWorkspaceGlobs,
  planBaseline,
  planRebaseline,
  rewriteBaselineVersion,
  rewriteVersion,
  workspaceManifests,
} from "./rebaseline-to-upstream";

describe("parseRebaselineArgs", () => {
  it("reads the Upstream ref", () => {
    assert.deepEqual(parseRebaselineArgs(["c2b7f8231"]), {
      upstreamRef: "c2b7f8231",
      dryRun: false,
    });
  });

  it("reads --dry-run", () => {
    assert.deepEqual(parseRebaselineArgs(["c2b7f8231", "--dry-run"]), {
      upstreamRef: "c2b7f8231",
      dryRun: true,
    });
  });

  it("refuses a missing ref rather than guessing one", () => {
    assert.throws(() => parseRebaselineArgs([]), RebaselineUsageError);
  });

  it("refuses a second ref rather than silently using the first", () => {
    assert.throws(() => parseRebaselineArgs(["a", "b"]), RebaselineUsageError);
  });

  it("refuses an unknown flag", () => {
    assert.throws(
      () => parseRebaselineArgs(["a", "--force"]),
      RebaselineUsageError,
    );
  });
});

describe("parseWorkspaceGlobs", () => {
  it("reads every member glob, not just packages/*", () => {
    assert.deepEqual(
      parseWorkspaceGlobs(
        [
          "packages:",
          "  - packages/*",
          "  - examples/*",
          "  - templates/.retired/*",
          "  - templates/*",
          "  - templates/*/desktop",
          "",
          "minimumReleaseAge: 1440",
        ].join("\n"),
      ),
      [
        "packages/*",
        "examples/*",
        "templates/.retired/*",
        "templates/*",
        "templates/*/desktop",
      ],
    );
  });

  it("stops at the next top-level key", () => {
    assert.deepEqual(
      parseWorkspaceGlobs(
        ["packages:", "  - packages/*", "catalog:", "  h3: ^1", ""].join("\n"),
      ),
      ["packages/*"],
    );
  });

  it("refuses a workspace file with no members rather than scanning nothing", () => {
    assert.throws(
      () => parseWorkspaceGlobs("minimumReleaseAge: 1440\n"),
      /no member globs/,
    );
  });

  it("refuses a shape it does not understand rather than returning a short list", () => {
    assert.throws(
      () => parseWorkspaceGlobs("packages: [packages/*, templates/*]\n"),
      /inline/,
    );
  });
});

describe("decideRebaseline", () => {
  it("re-baselines a fork left behind Upstream", () => {
    assert.deepEqual(decideRebaseline("0.134.0-paul.2", "0.145.2"), {
      action: "rebaseline",
      from: "0.134.0-paul.2",
      to: "0.145.2",
      sameTuple: false,
    });
  });

  it("marks a re-baseline that only drops the prerelease tag", () => {
    // 0.1.19-paul.0 is BELOW 0.1.19, so this is still behind Upstream — but the
    // number it lands on is one Upstream has already published, which the report
    // has to say out loud.
    assert.deepEqual(decideRebaseline("0.1.19-paul.0", "0.1.19"), {
      action: "rebaseline",
      from: "0.1.19-paul.0",
      to: "0.1.19",
      sameTuple: true,
    });
  });

  it("leaves a package whose fork version is ahead of Upstream", () => {
    assert.deepEqual(decideRebaseline("0.1.155-paul.0", "0.1.154"), {
      action: "ahead",
      forkVersion: "0.1.155-paul.0",
      upstreamVersion: "0.1.154",
    });
  });

  it("leaves a package already on Upstream's number", () => {
    assert.deepEqual(decideRebaseline("0.13.3", "0.13.3"), {
      action: "unchanged",
      version: "0.13.3",
    });
  });

  it("reports a package Upstream does not have, rather than skipping it", () => {
    assert.deepEqual(decideRebaseline("0.1.0", null), {
      action: "fork-only",
      forkVersion: "0.1.0",
    });
  });

  it("reports a manifest with no version, rather than dropping it", () => {
    assert.deepEqual(decideRebaseline(undefined, "0.1.0"), {
      action: "no-version",
      upstreamVersion: "0.1.0",
    });
  });

  it("refuses a version it cannot read as a tuple", () => {
    assert.throws(() => decideRebaseline("nightly", "0.1.0"), /nightly/);
  });
});

describe("rewriteVersion", () => {
  it("replaces the version and touches nothing else", () => {
    const before =
      '{\n  "name": "@agent-native/core",\n  "version": "0.134.0-paul.2",\n  "type": "module"\n}\n';
    assert.equal(
      rewriteVersion(before, "0.134.0-paul.2", "0.145.2"),
      '{\n  "name": "@agent-native/core",\n  "version": "0.145.2",\n  "type": "module"\n}\n',
    );
  });

  it("throws rather than pick one when the value appears twice", () => {
    const before =
      '{\n  "version": "1.0.0",\n  "x": { "version": "1.0.0" }\n}\n';
    assert.throws(() => rewriteVersion(before, "1.0.0", "2.0.0"), /twice/);
  });

  it("throws rather than no-op when the value is absent", () => {
    assert.throws(
      () => rewriteVersion('{\n  "version": "1.0.0"\n}\n', "9.9.9", "2.0.0"),
      /not found/,
    );
  });
});

function forkFixture(
  manifests: Record<string, Record<string, unknown>>,
  files: string[] = [],
  initialVersions?: Record<string, string>,
): string {
  const root = mkdtempSync(path.join(tmpdir(), "rebaseline-"));
  for (const [dir, manifest] of Object.entries(manifests)) {
    mkdirSync(path.join(root, dir), { recursive: true });
    writeFileSync(
      path.join(root, dir, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
  }
  for (const file of files) {
    mkdirSync(path.join(root, path.dirname(file)), { recursive: true });
    writeFileSync(path.join(root, file), "");
  }
  if (initialVersions !== undefined) {
    mkdirSync(path.join(root, ".changeset"), { recursive: true });
    writeFileSync(
      path.join(root, ".changeset/pre.json"),
      `${JSON.stringify(
        {
          mode: "pre",
          tag: "paul",
          initialVersions,
          changesets: ["lucky-donkeys-attack"],
        },
        null,
        2,
      )}\n`,
    );
  }
  return root;
}

describe("workspaceManifests", () => {
  it("expands every glob, including a nested one", () => {
    const root = forkFixture({
      "packages/core": { name: "core" },
      "templates/clips": { name: "clips" },
      "templates/clips/desktop": { name: "clips-desktop" },
      "examples/demo": { name: "demo" },
      "unlisted/thing": { name: "thing" },
    });

    assert.deepEqual(
      workspaceManifests(root, [
        "packages/*",
        "examples/*",
        "templates/*",
        "templates/*/desktop",
      ]),
      [
        "examples/demo/package.json",
        "packages/core/package.json",
        "templates/clips/desktop/package.json",
        "templates/clips/package.json",
      ],
    );
  });

  it("steps over a stray file sitting where a package directory would be", () => {
    const root = forkFixture({ "packages/core": { name: "core" } }, [
      "packages/README.md",
    ]);

    assert.deepEqual(workspaceManifests(root, ["packages/*"]), [
      "packages/core/package.json",
    ]);
  });
});

describe("planRebaseline", () => {
  const upstream: Record<string, string> = {
    "packages/core/package.json": "0.145.2",
    "packages/frame/package.json": "0.1.154",
    "packages/toolkit/package.json": "0.13.3",
    "packages/docs/package.json": "0.0.1",
  };
  const readUpstream = (file: string) => upstream[file] ?? null;

  it("decides one action per package, and reports the ones it cannot act on", () => {
    const root = forkFixture({
      "packages/core": {
        name: "@agent-native/core",
        version: "0.134.0-paul.2",
      },
      "packages/frame": {
        name: "@agent-native/frame",
        version: "0.1.155-paul.0",
      },
      "packages/toolkit": { name: "@agent-native/toolkit", version: "0.13.3" },
      "packages/docs": { name: "@agent-native/docs" },
      "packages/local": { name: "@agent-native/local", version: "0.1.0" },
    });

    const plan = planRebaseline(
      root,
      workspaceManifests(root, ["packages/*"]),
      readUpstream,
    );

    assert.deepEqual(
      plan.members.map((entry) => [entry.name, entry.decision.action]),
      [
        ["@agent-native/core", "rebaseline"],
        ["@agent-native/docs", "no-version"],
        ["@agent-native/frame", "ahead"],
        ["@agent-native/local", "fork-only"],
        ["@agent-native/toolkit", "unchanged"],
      ],
    );
  });

  it("writes only the packages it re-baselines", () => {
    const root = forkFixture({
      "packages/core": {
        name: "@agent-native/core",
        version: "0.134.0-paul.2",
      },
      "packages/frame": {
        name: "@agent-native/frame",
        version: "0.1.155-paul.0",
      },
    });
    const before = readFileSync(
      path.join(root, "packages/frame/package.json"),
      "utf8",
    );

    applyRebaseline(
      root,
      planRebaseline(
        root,
        workspaceManifests(root, ["packages/*"]),
        readUpstream,
      ),
    );

    assert.equal(
      JSON.parse(
        readFileSync(path.join(root, "packages/core/package.json"), "utf8"),
      ).version,
      "0.145.2",
    );
    assert.equal(
      readFileSync(path.join(root, "packages/frame/package.json"), "utf8"),
      before,
    );
  });

  it("reports no baseline when the workspace is not in pre mode", () => {
    const root = forkFixture({
      "packages/core": {
        name: "@agent-native/core",
        version: "0.134.0-paul.2",
      },
    });

    const plan = planRebaseline(
      root,
      workspaceManifests(root, ["packages/*"]),
      readUpstream,
    );

    assert.equal(plan.baseline, null);
  });
});

describe("planBaseline", () => {
  // The baseline records the version each manifest ends the pass on, which for a
  // re-baselined package is Upstream's number and for every other action is the
  // number the manifest keeps. Anything else produces the disagreement this
  // whole pass exists to remove.
  const members = [
    {
      name: "@agent-native/core",
      file: "packages/core/package.json",
      decision: {
        action: "rebaseline" as const,
        from: "0.134.0-paul.2",
        to: "0.145.2",
        sameTuple: false,
      },
    },
    {
      name: "@agent-native/frame",
      file: "packages/frame/package.json",
      decision: {
        action: "ahead" as const,
        forkVersion: "0.1.155-paul.0",
        upstreamVersion: "0.1.154",
      },
    },
    {
      name: "@agent-native/local",
      file: "packages/local/package.json",
      decision: { action: "fork-only" as const, forkVersion: "0.1.0" },
    },
    {
      name: "@agent-native/toolkit",
      file: "packages/toolkit/package.json",
      decision: { action: "unchanged" as const, version: "0.13.3" },
    },
    {
      name: "@agent-native/docs",
      file: "packages/docs/package.json",
      decision: { action: "no-version" as const, upstreamVersion: "0.0.1" },
    },
  ];

  it("records the version each member ends the pass on", () => {
    assert.deepEqual(
      planBaseline(members, {
        "@agent-native/core": "0.133.3",
        "@agent-native/frame": "0.1.154",
        "@agent-native/local": "0.1.0",
        "@agent-native/toolkit": "0.13.3",
      }),
      [
        {
          name: "@agent-native/core",
          decision: { action: "rewrite", from: "0.133.3", to: "0.145.2" },
        },
        {
          name: "@agent-native/frame",
          decision: {
            action: "rewrite",
            from: "0.1.154",
            to: "0.1.155-paul.0",
          },
        },
        {
          name: "@agent-native/local",
          decision: { action: "current", version: "0.1.0" },
        },
        {
          name: "@agent-native/toolkit",
          decision: { action: "current", version: "0.13.3" },
        },
      ],
    );
  });

  it("reports a member the baseline has never heard of, rather than dropping it", () => {
    const plan = planBaseline(members, { "@agent-native/core": "0.133.3" });

    assert.deepEqual(
      plan.find((entry) => entry.name === "@agent-native/toolkit"),
      {
        name: "@agent-native/toolkit",
        decision: { action: "absent", memberVersion: "0.13.3" },
      },
    );
  });

  it("reports a baseline entry no workspace member answers to, rather than dropping it", () => {
    const plan = planBaseline(members, {
      "@agent-native/core": "0.133.3",
      "@agent-native/retired": "0.9.0",
    });

    assert.deepEqual(
      plan.find((entry) => entry.name === "@agent-native/retired"),
      {
        name: "@agent-native/retired",
        decision: { action: "orphan", baselineVersion: "0.9.0" },
      },
    );
  });

  it("counts a versionless member as absent from the workspace, not as a member to record", () => {
    const plan = planBaseline(members, { "@agent-native/docs": "0.0.1" });

    assert.deepEqual(
      plan.find((entry) => entry.name === "@agent-native/docs"),
      {
        name: "@agent-native/docs",
        decision: { action: "orphan", baselineVersion: "0.0.1" },
      },
    );
  });
});

describe("rewriteBaselineVersion", () => {
  const before = [
    "{",
    '  "mode": "pre",',
    '  "initialVersions": {',
    '    "@agent-native/core": "0.133.3",',
    '    "@agent-native/dispatch": "0.133.3"',
    "  }",
    "}",
    "",
  ].join("\n");

  it("replaces one entry and touches nothing else", () => {
    assert.equal(
      rewriteBaselineVersion(
        before,
        "@agent-native/core",
        "0.133.3",
        "0.145.2",
      ),
      before.replace(
        '"@agent-native/core": "0.133.3"',
        '"@agent-native/core": "0.145.2"',
      ),
    );
  });

  it("throws rather than no-op when the entry is absent", () => {
    assert.throws(
      () =>
        rewriteBaselineVersion(before, "@agent-native/gone", "1.0.0", "2.0.0"),
      /not found/,
    );
  });

  it("throws rather than pick one when the entry appears twice", () => {
    assert.throws(
      () =>
        rewriteBaselineVersion(
          `${before}${before}`,
          "@agent-native/core",
          "0.133.3",
          "0.145.2",
        ),
      /twice/,
    );
  });
});

describe("the pre-mode baseline and the manifests move together", () => {
  const upstream: Record<string, string> = {
    "packages/core/package.json": "0.145.2",
    "packages/frame/package.json": "0.1.154",
  };
  const readUpstream = (file: string) => upstream[file] ?? null;

  const manifests = {
    "packages/core": {
      name: "@agent-native/core",
      version: "0.134.0-paul.2",
    },
    "packages/frame": {
      name: "@agent-native/frame",
      version: "0.1.155-paul.0",
    },
  };

  it("leaves the baseline file untouched until apply runs", () => {
    const root = forkFixture(manifests, [], {
      "@agent-native/core": "0.133.3",
      "@agent-native/frame": "0.1.154",
    });
    const before = readFileSync(path.join(root, ".changeset/pre.json"), "utf8");

    planRebaseline(
      root,
      workspaceManifests(root, ["packages/*"]),
      readUpstream,
    );

    assert.equal(
      readFileSync(path.join(root, ".changeset/pre.json"), "utf8"),
      before,
    );
  });

  it("applies the baseline and the manifests in one pass, and agrees with itself", () => {
    const root = forkFixture(manifests, [], {
      "@agent-native/core": "0.133.3",
      "@agent-native/frame": "0.1.154",
    });

    applyRebaseline(
      root,
      planRebaseline(
        root,
        workspaceManifests(root, ["packages/*"]),
        readUpstream,
      ),
    );

    const pre = JSON.parse(
      readFileSync(path.join(root, ".changeset/pre.json"), "utf8"),
    );
    for (const dir of ["packages/core", "packages/frame"]) {
      const manifest = JSON.parse(
        readFileSync(path.join(root, dir, "package.json"), "utf8"),
      );
      assert.equal(pre.initialVersions[manifest.name], manifest.version);
    }
    assert.equal(pre.initialVersions["@agent-native/core"], "0.145.2");
  });

  it("keeps the rest of the baseline file byte-identical", () => {
    const root = forkFixture(manifests, [], {
      "@agent-native/core": "0.133.3",
      "@agent-native/frame": "0.1.155-paul.0",
    });
    const before = readFileSync(path.join(root, ".changeset/pre.json"), "utf8");

    applyRebaseline(
      root,
      planRebaseline(
        root,
        workspaceManifests(root, ["packages/*"]),
        readUpstream,
      ),
    );

    assert.equal(
      readFileSync(path.join(root, ".changeset/pre.json"), "utf8"),
      before.replace(
        '"@agent-native/core": "0.133.3"',
        '"@agent-native/core": "0.145.2"',
      ),
    );
  });

  it("writes nothing at all when one manifest rewrite cannot be made", () => {
    const root = forkFixture(manifests, [], {
      "@agent-native/core": "0.133.3",
      "@agent-native/frame": "0.1.154",
    });
    const plan = planRebaseline(
      root,
      workspaceManifests(root, ["packages/*"]),
      readUpstream,
    );
    // The manifest moved under the plan, so its recorded `from` is no longer in
    // the file. A half-applied pass is the tree this ticket exists to prevent.
    writeFileSync(
      path.join(root, "packages/core/package.json"),
      '{\n  "name": "@agent-native/core",\n  "version": "9.9.9"\n}\n',
    );
    const baselineBefore = readFileSync(
      path.join(root, ".changeset/pre.json"),
      "utf8",
    );

    assert.throws(() => applyRebaseline(root, plan), /not found/);

    assert.equal(
      readFileSync(path.join(root, ".changeset/pre.json"), "utf8"),
      baselineBefore,
    );
  });

  it("creates no baseline file when the workspace is not in pre mode", () => {
    const root = forkFixture(manifests);

    applyRebaseline(
      root,
      planRebaseline(
        root,
        workspaceManifests(root, ["packages/*"]),
        readUpstream,
      ),
    );

    assert.throws(
      () => readFileSync(path.join(root, ".changeset/pre.json"), "utf8"),
      /ENOENT/,
    );
  });
});
