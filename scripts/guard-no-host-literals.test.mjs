import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkLine,
  findHostLiteralViolations,
  inScope,
} from "./guard-no-host-literals.mjs";

const SCRIPTS_DIR = path.dirname(fileURLToPath(import.meta.url));

describe("host literal guard — what it detects", () => {
  it("flags a host name in a deciding position", () => {
    for (const line of [
      `  if (host === "cloudflare") {`,
      `  if ("netlify" !== platform) {`,
      `    case "vercel":`,
      `  if (preset.startsWith("cloudflare")) {`,
      `  if (navigator.userAgent === "Cloudflare-Workers") {`,
      `  if (targets.includes("aws-lambda")) {`,
    ]) {
      assert.ok(checkLine(line), `expected a violation for: ${line}`);
    }
  });

  it("does not flag a host name used as a name", () => {
    // Every one of these is a real line on trunk. A guard that conflates "the
    // string cloudflare appears" with "this module decides host behaviour"
    // fails on all six and stops being believed.
    for (const line of [
      `    id: "cloudflare",`,
      `    provider: "cloudflare",`,
      `    logoUrl: mcpIntegrationLogo("cloudflare"),`,
      `  preset("cloudflare"),`,
      `const PROVIDER_ID = "cloudflare";`,
      `  if (process.env.NETLIFY) return "netlify";`,
    ]) {
      assert.equal(checkLine(line), null, `unexpected violation for: ${line}`);
    }
  });

  it("honours the documented opt-out pragma", () => {
    assert.deepEqual(
      findHostLiteralViolations(
        "packages/core/src/server/example.ts",
        `if (host === "cloudflare") {} // guard:allow-host-literal — fixture`,
      ),
      [],
    );
    assert.deepEqual(
      findHostLiteralViolations(
        "packages/core/src/server/example.ts",
        `// guard:allow-host-literal — fixture\nif (host === "cloudflare") {}`,
      ),
      [],
    );
    assert.equal(
      findHostLiteralViolations(
        "packages/core/src/server/example.ts",
        `if (host === "cloudflare") {}`,
      ).length,
      1,
    );
  });
});

describe("host literal guard — scope and allow-list", () => {
  it("allows the Host seam and the one runtime-detection module", () => {
    assert.equal(inScope("packages/core/src/hosts/cloudflare/index.ts"), false);
    assert.equal(inScope("packages/core/src/shared/runtime.ts"), false);
  });

  it("leaves the build/deploy layer to name its own targets", () => {
    assert.equal(inScope("packages/core/src/deploy/build.ts"), false);
    assert.equal(inScope("packages/core/src/cli/create.ts"), false);
  });

  it("covers the rest of core's runtime code", () => {
    assert.equal(inScope("packages/core/src/db/client.ts"), true);
    assert.equal(inScope("packages/core/src/agent/run-manager.ts"), true);
    assert.equal(
      inScope("packages/core/src/server/agent-chat-plugin.ts"),
      true,
    );
  });

  it("ignores specs, so a spec may name a host freely", () => {
    assert.equal(inScope("packages/core/src/db/client.spec.ts"), false);
  });
});

/**
 * The proof that matters: the guard must FAIL on a literal this branch added,
 * and must NOT fail on the identical literal when it was already there. A
 * detector test cannot show either — only running the guard against a real
 * diff can.
 */
describe("host literal guard — end to end against a real diff", () => {
  const repos = [];

  after(() => {
    for (const dir of repos) rmSync(dir, { recursive: true, force: true });
  });

  function makeRepo() {
    const dir = mkdtempSync(path.join(tmpdir(), "host-literal-guard-"));
    repos.push(dir);
    const git = (...args) =>
      execFileSync("git", args, { cwd: dir, stdio: "ignore" });
    git("init", "-q", "-b", "main");
    git("config", "user.email", "guard@example.test");
    git("config", "user.name", "guard test");
    // The guard resolves its own repo root from its file location, so it has
    // to be run from a copy inside the fixture repo.
    mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
    cpSync(
      path.join(SCRIPTS_DIR, "guard-no-host-literals.mjs"),
      path.join(dir, "scripts", "guard-no-host-literals.mjs"),
    );
    cpSync(
      path.join(SCRIPTS_DIR, "lib", "changed-lines.mjs"),
      path.join(dir, "scripts", "lib", "changed-lines.mjs"),
    );
    mkdirSync(path.join(dir, "packages", "core", "src", "server"), {
      recursive: true,
    });
    return { dir, git };
  }

  function write(dir, relPath, source) {
    mkdirSync(path.dirname(path.join(dir, relPath)), { recursive: true });
    writeFileSync(path.join(dir, relPath), source);
  }

  function runGuard(dir) {
    return spawnSync(
      process.execPath,
      [path.join(dir, "scripts", "guard-no-host-literals.mjs")],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, GUARD_DIFF_BASE: "" },
      },
    );
  }

  const TARGET = "packages/core/src/server/scheduler.ts";
  const CLEAN = `export function pick(host: string) {\n  return host;\n}\n`;
  const DIRTY = `export function pick(host: string) {\n  if (host === "cloudflare") return "queue";\n  return host;\n}\n`;

  it("fails on a newly added host literal, and names the fix", () => {
    const { dir, git } = makeRepo();
    write(dir, TARGET, CLEAN);
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "feature");
    write(dir, TARGET, DIRTY);

    const result = runGuard(dir);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, /scheduler\.ts:2/);
    assert.match(result.stderr, /compared against a host name/);
    // Agent-facing failure text: it has to name where the fix goes, not just
    // the violation.
    assert.match(result.stderr, /packages\/core\/src\/hosts\/<host>\//);
    assert.match(result.stderr, /isCloudflareRuntime\(\)/);
    assert.match(result.stderr, /HOST_AWARE_MODULES/);
    assert.match(result.stderr, /guard:allow-host-literal/);
  });

  it("passes on the identical literal when it is pre-existing", () => {
    const { dir, git } = makeRepo();
    write(dir, TARGET, DIRTY);
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "feature");
    write(dir, "packages/core/src/server/other.ts", "export const x = 1;\n");

    const result = runGuard(dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /OK/);
  });

  it("passes when the newly added literal is inside the Host seam", () => {
    const { dir, git } = makeRepo();
    write(dir, TARGET, CLEAN);
    git("add", "-A");
    git("commit", "-qm", "base");
    git("checkout", "-qb", "feature");
    write(dir, "packages/core/src/hosts/cloudflare/queue.ts", DIRTY);

    const result = runGuard(dir);
    assert.equal(result.status, 0, result.stdout + result.stderr);
  });

  it("refuses to report a clean run when it cannot resolve a diff base", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "host-literal-guard-nogit-"));
    repos.push(dir);
    mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
    cpSync(
      path.join(SCRIPTS_DIR, "guard-no-host-literals.mjs"),
      path.join(dir, "scripts", "guard-no-host-literals.mjs"),
    );
    cpSync(
      path.join(SCRIPTS_DIR, "lib", "changed-lines.mjs"),
      path.join(dir, "scripts", "lib", "changed-lines.mjs"),
    );
    write(dir, TARGET, DIRTY);

    const result = runGuard(dir);
    assert.equal(result.status, 0);
    assert.doesNotMatch(result.stdout, /OK/);
    assert.match(result.stderr, /this is not a clean result/);
  });
});
