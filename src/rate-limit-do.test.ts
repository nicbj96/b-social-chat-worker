import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class { ctx: any; constructor(ctx: any) { this.ctx = ctx; } } }));

import { RateLimitDurableObject } from "./rate-limit-do";
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

describe("RateLimitDurableObject.consume remaining", () => {
  it("reports remaining counting down 4,3,2 for consume(5)", async () => {
    const store = new Map<string, unknown>();
    const ctx = {
      storage: {
        transaction: async (fn: (t: any) => Promise<unknown>) =>
          fn({ get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => { store.set(k, v); } }),
      },
    };
    const doInstance = new RateLimitDurableObject(ctx as any, {} as any);
    const remaining: unknown[] = [];
    for (let i = 0; i < 3; i++) remaining.push((await doInstance.consume(5, 60_000)).remaining);
    expect(remaining).toEqual([4, 3, 2]);
  });
});
