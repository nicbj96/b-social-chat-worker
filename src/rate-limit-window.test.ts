import { describe, expect, it } from "vitest";
import { advanceRateLimitWindow, type RateLimitWindow } from "./rate-limit-window";

const now = 1_000_000;

describe("advanceRateLimitWindow", () => {
  it("defaults to weight 1 — the per-request rate-limit behaviour, unchanged", () => {
    let w: RateLimitWindow | undefined;
    for (let i = 1; i <= 3; i += 1) {
      const d = advanceRateLimitWindow(w, 3, 60_000, now);
      w = d.window;
      expect(w.count).toBe(i);
      expect(d.success).toBe(true);
    }
    expect(advanceRateLimitWindow(w, 3, 60_000, now).success).toBe(false); // 4th over limit 3
  });

  it("adds the given weight, so a costly call eats more of the budget than a cheap one", () => {
    const first = advanceRateLimitWindow(undefined, 100, 60_000, now, 58);
    expect(first.window.count).toBe(58);
    expect(first.success).toBe(true);
    const second = advanceRateLimitWindow(first.window, 100, 60_000, now, 58);
    expect(second.window.count).toBe(116);
    expect(second.success).toBe(false); // 116 > 100
  });

  it("starts a fresh window once the old one has expired", () => {
    const a = advanceRateLimitWindow(undefined, 10, 1_000, now, 8);
    const b = advanceRateLimitWindow(a.window, 10, 1_000, now + 2_000, 8);
    expect(b.window.count).toBe(8); // not 16 — the window reset
    expect(b.success).toBe(true);
  });
});
