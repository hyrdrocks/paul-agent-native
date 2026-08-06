import { afterEach, describe, expect, it, vi } from "vitest";

import { runCompareAndSwap } from "./atomic-compare-and-swap.js";

const supportsInteractiveTransactions = vi.hoisted(() => vi.fn(() => true));
vi.mock("./client.js", () => ({ supportsInteractiveTransactions }));

/** Records the order of operations so the atomic unit's contents are visible. */
function recorder() {
  const order: string[] = [];
  const query = (label: string, value?: unknown) => {
    const promise: PromiseLike<unknown> & { label: string } = {
      label,
      then(resolve: any) {
        order.push(label);
        return Promise.resolve(value).then(resolve);
      },
    } as never;
    return promise;
  };
  return { order, query };
}

afterEach(() => {
  supportsInteractiveTransactions.mockReturnValue(true);
});

describe("runCompareAndSwap", () => {
  it("runs read, write, and confirm inside one transaction on interactive dialects", async () => {
    const { order, query } = recorder();
    const tx = { marker: "tx" };
    const db = {
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
        order.push("begin");
        const result = await fn(tx);
        order.push("commit");
        return result;
      },
    };

    const result = await runCompareAndSwap(db, {
      read: async (exec) => {
        expect(exec).toBe(tx);
        order.push("read");
        return { revision: 1 };
      },
      plan: (exec, current) => {
        expect(exec).toBe(tx);
        expect(current).toEqual({ revision: 1 });
        return {
          write: query("write"),
          confirm: query("confirm", [{ data: "next" }]),
        };
      },
    });

    expect(order).toEqual(["begin", "read", "write", "confirm", "commit"]);
    expect(result.current).toEqual({ revision: 1 });
    expect(result.confirmed).toEqual([{ data: "next" }]);
  });

  it("keeps the transaction on an interactive dialect whose client can also batch", async () => {
    // The capability decides the shape. A client that happens to expose
    // batch() must not silently lose the interactive guarantee.
    const { order, query } = recorder();
    const tx = { marker: "tx" };
    const batch = vi.fn();
    const db = {
      batch,
      transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(tx),
    };

    await runCompareAndSwap(db, {
      read: async () => {
        order.push("read");
        return null;
      },
      plan: () => ({ write: query("write"), confirm: query("confirm") }),
    });

    expect(batch).not.toHaveBeenCalled();
    expect(order).toEqual(["read", "write", "confirm"]);
  });

  it("batches the write and its confirmation without interactive transactions", async () => {
    supportsInteractiveTransactions.mockReturnValue(false);
    const { order, query } = recorder();
    const batched: unknown[] = [];
    const db = {
      batch: async (queries: readonly unknown[]) => {
        order.push("batch");
        batched.push(...queries);
        return [{ rowsAffected: 1 }, [{ data: "next" }]];
      },
    };

    const result = await runCompareAndSwap(db, {
      read: async (exec) => {
        expect(exec).toBe(db);
        order.push("read");
        return { revision: 1 };
      },
      plan: () => ({
        write: query("write"),
        confirm: query("confirm"),
      }),
    });

    // The read is outside the atomic unit there — the CAS predicate and the
    // confirmation read are what cover the gap — but the write and confirm are
    // handed to batch() together and never awaited separately.
    expect(order).toEqual(["read", "batch"]);
    expect(batched).toHaveLength(2);
    expect(result.confirmed).toEqual([{ data: "next" }]);
  });

  it("never falls back to a transaction the dialect cannot hold open", async () => {
    supportsInteractiveTransactions.mockReturnValue(false);
    const transaction = vi.fn();
    await expect(
      runCompareAndSwap(
        { transaction },
        {
          read: async () => null,
          plan: () => ({ write: {} as never, confirm: {} as never }),
        },
      ),
      // A bare BEGIN is what such a dialect rejects; falling through would name
      // the wrong cause and read as a database error rather than a wiring one.
    ).rejects.toThrow(/no batch\(\)/);
    expect(transaction).not.toHaveBeenCalled();
  });

  it("propagates a read failure before anything is written", async () => {
    supportsInteractiveTransactions.mockReturnValue(false);
    const batch = vi.fn();
    await expect(
      runCompareAndSwap(
        { batch },
        {
          read: async () => {
            throw new Error("row not found");
          },
          plan: () => ({ write: {} as never, confirm: {} as never }),
        },
      ),
    ).rejects.toThrow("row not found");
    expect(batch).not.toHaveBeenCalled();
  });

  it("propagates a read failure on the interactive path too", async () => {
    const transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({}),
    );
    await expect(
      runCompareAndSwap(
        { transaction },
        {
          read: async () => {
            throw new Error("row not found");
          },
          plan: () => ({ write: {} as never, confirm: {} as never }),
        },
      ),
    ).rejects.toThrow("row not found");
  });
});
