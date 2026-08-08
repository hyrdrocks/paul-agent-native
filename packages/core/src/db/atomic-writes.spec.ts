import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { runAtomicWrites } from "./atomic-writes.js";
import * as client from "./client.js";

function query(label: string, log: string[]): PromiseLike<unknown> {
  return {
    then(onFulfilled: any) {
      log.push(label);
      return Promise.resolve(label).then(onFulfilled);
    },
  } as PromiseLike<unknown>;
}

/** Stand in for a dialect with no interactive transactions (today, D1). */
function withoutInteractiveTransactions(): void {
  vi.spyOn(client, "supportsInteractiveTransactions").mockReturnValue(false);
}

/** Stand in for the interactive dialects (SQLite/libSQL, Postgres). */
function withInteractiveTransactions(): void {
  vi.spyOn(client, "supportsInteractiveTransactions").mockReturnValue(true);
}

describe("runAtomicWrites", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("batches every statement in one call without interactive transactions", async () => {
    withoutInteractiveTransactions();
    const log: string[] = [];
    const batch = vi.fn(async () => []);
    const db = { batch, transaction: vi.fn() };

    await runAtomicWrites(db, (exec) => {
      expect(exec).toBe(db);
      return [query("a", log), query("b", log)];
    });

    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0][0]).toHaveLength(2);
    expect(db.transaction).not.toHaveBeenCalled();
    // Nothing may be awaited before batch() — awaiting sends the statement on
    // its own, outside the implicit transaction.
    expect(log).toEqual([]);
  });

  it("names the wiring when a non-interactive client cannot batch", async () => {
    withoutInteractiveTransactions();
    const transaction = vi.fn();

    await expect(
      runAtomicWrites({ transaction }, () => [query("a", [])]),
    ).rejects.toThrow(/no batch\(\)/);
    // Falling through would fail on BEGIN and blame the wrong thing.
    expect(transaction).not.toHaveBeenCalled();
  });

  it("runs the statements in order inside one transaction elsewhere", async () => {
    withInteractiveTransactions();
    const log: string[] = [];
    const tx = { marker: "tx" };
    const db = {
      batch: vi.fn(),
      transaction: vi.fn(async (fn: any) => fn(tx)),
    };

    await runAtomicWrites(db, (exec) => {
      expect(exec).toBe(tx);
      return [query("a", log), query("b", log)];
    });

    expect(db.batch).not.toHaveBeenCalled();
    expect(log).toEqual(["a", "b"]);
  });

  it("keeps using a transaction on an interactive dialect whose client can also batch", async () => {
    // A batching client is not on its own a reason to give up the interactive
    // guarantee: the capability decides the shape, not the client's surface.
    withInteractiveTransactions();
    const log: string[] = [];
    const tx = { marker: "tx" };
    const db = {
      batch: vi.fn(async () => []),
      transaction: vi.fn(async (fn: any) => fn(tx)),
    };

    await runAtomicWrites(db, () => [query("a", log)]);

    expect(db.batch).not.toHaveBeenCalled();
    expect(db.transaction).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty plan rather than reporting a write that never happened", async () => {
    withoutInteractiveTransactions();
    const batch = vi.fn(async () => []);

    await expect(runAtomicWrites({ batch }, () => [])).rejects.toThrow(
      /no statements/,
    );
    expect(batch).not.toHaveBeenCalled();
  });

  it("rejects an empty plan on the interactive path too", async () => {
    withInteractiveTransactions();
    const tx = { marker: "tx" };
    const db = { transaction: vi.fn(async (fn: any) => fn(tx)) };

    await expect(runAtomicWrites(db, () => [])).rejects.toThrow(
      /no statements/,
    );
  });

  it("runs on the real dialect the process resolved when nothing is stubbed", async () => {
    // Guards the wiring itself: the helper must consult the capability
    // predicate rather than carry its own idea of the dialect.
    const spy = vi.spyOn(client, "supportsInteractiveTransactions");
    const tx = { marker: "tx" };
    const db = { transaction: vi.fn(async (fn: any) => fn(tx)) };

    await runAtomicWrites(db, () => [query("a", [])]);

    expect(spy).toHaveBeenCalled();
  });
});
