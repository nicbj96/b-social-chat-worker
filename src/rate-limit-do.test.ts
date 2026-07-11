import { describe, expect, it } from "vitest";
import { advanceRateLimitWindow } from "./rate-limit-window";

describe("advanceRateLimitWindow", () => {
  it("allows exactly the configured limit and resets after expiry", () => {
    const now = 10_000;
    const first = advanceRateLimitWindow(undefined, 2, 60_000, now);
    expect(first).toEqual({
      window: { count: 1, resetAt: 70_000 },
      success: true,
      retryAfterSeconds: 60,
    });

    const second = advanceRateLimitWindow(first.window, 2, 60_000, now + 1);
    expect(second.success).toBe(true);
    expect(second.window.count).toBe(2);

    const denied = advanceRateLimitWindow(second.window, 2, 60_000, now + 2);
    expect(denied.success).toBe(false);
    expect(denied.window.count).toBe(3);
    expect(denied.retryAfterSeconds).toBe(60);

    const reset = advanceRateLimitWindow(denied.window, 2, 60_000, 70_000);
    expect(reset.success).toBe(true);
    expect(reset.window).toEqual({ count: 1, resetAt: 130_000 });
  });
});
