import { afterEach, describe, expect, it } from "vitest";

import { createInitMemo } from "./init-memo.js";

/**
 * Make `isCloudflareRuntime()` true for one test. The detector reads
 * `globalThis.__cf_env`, so a real global is closer to the runtime under test
 * than mocking the module that reads it.
 */
function enterWorkersRuntime(): void {
  (globalThis as Record<string, unknown>).__cf_env = {};
}

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__cf_env;
});

/** A promise that never settles — an init abandoned with its request. */
function never(): Promise<void> {
  return new Promise<void>(() => {});
}

describe("createInitMemo", () => {
  it("runs the init once and reuses the settled result", async () => {
    let runs = 0;
    const memo = createInitMemo(async () => {
      runs++;
    });

    await memo();
    await memo();
    await memo();

    expect(runs).toBe(1);
  });

  it("shares one in-flight init between concurrent callers off Workers", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const memo = createInitMemo(async () => {
      runs++;
      await gate;
    });

    const first = memo();
    const second = memo();
    release();
    await Promise.all([first, second]);

    expect(runs).toBe(1);
  });

  it("re-runs after a failure instead of caching the rejection", async () => {
    let runs = 0;
    const memo = createInitMemo(async () => {
      runs++;
      if (runs === 1) throw new Error("table create failed");
    });

    await expect(memo()).rejects.toThrow("table create failed");
    await expect(memo()).resolves.toBeUndefined();
    expect(runs).toBe(2);
  });

  it("re-runs after reset", async () => {
    let runs = 0;
    const memo = createInitMemo(async () => {
      runs++;
    });

    await memo();
    memo.reset();
    await memo();

    expect(runs).toBe(2);
  });

  it("re-runs after a reset issued while an init is still in flight", async () => {
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const memo = createInitMemo(async () => {
      runs++;
      if (runs === 1) await gate;
    });

    const first = memo();
    memo.reset();
    release();
    await first;
    await memo();

    expect(runs).toBe(2);
  });

  it("hands the init promise to the creating request's waitUntil", async () => {
    const kept: Array<Promise<unknown>> = [];
    const event = { waitUntil: (p: Promise<unknown>) => kept.push(p) };
    const memo = createInitMemo(async () => {});

    await memo(event);

    expect(kept).toHaveLength(1);
  });

  describe("on Workers", () => {
    it("lets a waiter observe the creator's success without awaiting its promise", async () => {
      enterWorkersRuntime();
      let runs = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const memo = createInitMemo(async () => {
        runs++;
        await gate;
      });

      const creator = memo();
      const waiter = memo();
      release();
      await Promise.all([creator, waiter]);

      expect(runs).toBe(1);
    });

    it("tells a waiter that the attempt ran and failed instead of waiting out the deadline", async () => {
      enterWorkersRuntime();
      let release!: (err: Error) => void;
      const gate = new Promise<void>((_resolve, reject) => {
        release = reject;
      });
      const memo = createInitMemo(async () => gate, { waitMs: 60_000 });

      const creator = memo();
      const waiter = memo();
      release(new Error("d1 unreachable"));

      await expect(creator).rejects.toThrow("d1 unreachable");
      // The waiter learns the outcome; a memo that could only see "not ready
      // yet" would sit here until the 60s deadline instead.
      await expect(waiter).rejects.toThrow("d1 unreachable");
    });

    it("does not replay a failed attempt to later callers", async () => {
      enterWorkersRuntime();
      let runs = 0;
      const memo = createInitMemo(async () => {
        runs++;
        if (runs === 1) throw new Error("d1 unreachable");
      });

      await expect(memo()).rejects.toThrow("d1 unreachable");
      await expect(memo()).resolves.toBeUndefined();
      await expect(memo()).resolves.toBeUndefined();

      expect(runs).toBe(2);
    });

    it("starts its own attempt when the one it is watching goes quiet", async () => {
      // The Workers failure this exists for: the creating request answered, so
      // its init promise can never settle. A waiter must stop watching and run
      // its own idempotent attempt rather than report success or hang.
      enterWorkersRuntime();
      let runs = 0;
      const memo = createInitMemo(
        async () => {
          runs++;
          if (runs === 1) await never();
        },
        { waitMs: 30 },
      );

      void memo();
      await memo();

      expect(runs).toBe(2);
    });

    it("does not report success while an attempt is still running", async () => {
      enterWorkersRuntime();
      let settled = false;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const memo = createInitMemo(async () => gate, { waitMs: 60_000 });

      const creator = memo();
      const waiter = memo().then(() => {
        settled = true;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(settled).toBe(false);

      release();
      await Promise.all([creator, waiter]);
      expect(settled).toBe(true);
    });
  });
});
