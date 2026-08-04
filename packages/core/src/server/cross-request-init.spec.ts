import { describe, expect, it } from "vitest";

import {
  INIT_POLL_INTERVAL_MS,
  INIT_POLL_MAX_INTERVAL_MS,
  nextPollInterval,
} from "./cross-request-init.js";

describe("nextPollInterval", () => {
  it("grows from the first interval up to the ceiling and stops", () => {
    const intervals: number[] = [INIT_POLL_INTERVAL_MS];
    while (intervals.length < 8) {
      intervals.push(nextPollInterval(intervals[intervals.length - 1]));
    }
    expect(intervals).toEqual([10, 20, 40, 80, 100, 100, 100, 100]);
    expect(nextPollInterval(INIT_POLL_MAX_INTERVAL_MS)).toBe(
      INIT_POLL_MAX_INTERVAL_MS,
    );
  });

  it("keeps a whole deadline's polling to a few hundred wakeups", () => {
    // A flat 10ms interval costs 2,500 wakeups per waiter across the default
    // 25s deadline, in the isolate that is trying to finish the init they are
    // all waiting on. Raising the deadline to 60s made cold starts strictly
    // worse in production, which is the cost this backoff exists to remove.
    let elapsed = 0;
    let interval = INIT_POLL_INTERVAL_MS;
    let wakeups = 0;
    while (elapsed < 25_000) {
      elapsed += interval;
      interval = nextPollInterval(interval);
      wakeups++;
    }
    expect(wakeups).toBeLessThan(300);
  });
});
