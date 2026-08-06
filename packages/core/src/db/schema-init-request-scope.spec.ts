import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Schema initialisation must be triggered by a request, never at plugin-init.
 *
 * A runtime that ties a promise to its creating request cancels the promise
 * when that request answers. An init started outside any request therefore has
 * no request to hold it open, and every later caller that joins it waits on a
 * promise that will never settle: no error, no log, the request simply never
 * answers. The stores all initialise lazily on first use inside a request, so
 * the fix is that nothing fires them earlier — not a stronger memo.
 */

const SRC_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.includes(".spec.")) {
      out.push(full);
    }
  }
  return out;
}

describe("schema init stays inside a request", () => {
  it("has no store-init call in any server plugin module", () => {
    const offenders: string[] = [];
    for (const file of collectSourceFiles(SRC_ROOT)) {
      if (!path.basename(file).includes("plugin")) continue;
      const source = fs.readFileSync(file, "utf8");
      source.split("\n").forEach((line, index) => {
        if (/\bensure[A-Za-z]*Tables\s*\(/.test(line)) {
          offenders.push(
            `${path.relative(SRC_ROOT, file)}:${index + 1}: ${line.trim()}`,
          );
        }
      });
    }

    expect(offenders).toEqual([]);
  });

  it("does not touch the database while the observability plugin mounts", async () => {
    vi.resetModules();
    const execute = vi.fn(async () => ({ rows: [] }));
    vi.doMock("./client.js", async (importOriginal) => ({
      ...((await importOriginal()) as object),
      getDbExec: () => ({ execute }),
    }));
    vi.doMock("../server/core-routes-plugin.js", () => ({
      FRAMEWORK_ROUTE_PREFIX: "/_agent-native",
    }));
    const use = vi.fn();
    vi.doMock("../server/framework-request-handler.js", () => ({
      awaitBootstrap: vi.fn(async () => {}),
      getH3App: () => ({ use }),
    }));
    vi.doMock("../observability/cleanup-job.js", () => ({
      startTraceCleanupJob: vi.fn(),
    }));
    vi.doMock("../observability/routes.js", () => ({
      createObservabilityHandler: () => "handler",
    }));

    const { createObservabilityPlugin } =
      await import("../observability/plugin.js");
    await createObservabilityPlugin()({});

    // Mounting is all this plugin may do. A single statement here is a schema
    // init with no request to keep it alive.
    expect(use).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("makes the audit cleanup job run its own init, since it has no request", async () => {
    vi.resetModules();
    const ensureAuditTables = vi.fn(async () => {});
    const deleteOldAuditEvents = vi.fn(async () => 3);
    vi.doMock("../audit/store.js", () => ({
      ensureAuditTables,
      deleteOldAuditEvents,
    }));

    const { runAuditCleanupOnce } = await import("../audit/cleanup-job.js");
    await expect(runAuditCleanupOnce()).resolves.toBe(3);

    // It ticks on a timer, so nothing above it ever initialised the table for
    // it — and it must not go back to depending on a startup init that would
    // reintroduce the outside-a-request trigger.
    expect(ensureAuditTables).toHaveBeenCalledTimes(1);
    expect(deleteOldAuditEvents).toHaveBeenCalledTimes(1);
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});
