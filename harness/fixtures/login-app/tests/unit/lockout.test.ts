import { describe, it, expect } from "vitest";
import { recordFailure } from "../../src/lockout.js";

describe("lockout · recordFailure", () => {
  it("5번째 연속 실패에서 지금부터 10분 뒤까지 잠근다", () => {
    const now = 1_000_000;
    const account = { passwordHash: "x", failCount: 4, lockedUntil: null as number | null };

    recordFailure(account, now);

    expect(account.failCount).toBe(5);
    expect(account.lockedUntil).toBe(now + 10 * 60 * 1000);
  });
});
