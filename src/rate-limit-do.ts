import { DurableObject } from "cloudflare:workers";
import { advanceRateLimitWindow, type RateLimitWindow } from "./rate-limit-window";

export interface DurableRateLimitDecision {
  success: boolean;
  retryAfterSeconds: number;
}

export class RateLimitDurableObject extends DurableObject {
  async consume(limit: number, windowMs: number, weight = 1): Promise<DurableRateLimitDecision> {
    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<RateLimitWindow>("window");
      const decision = advanceRateLimitWindow(current, limit, windowMs, now, weight);
      await transaction.put("window", decision.window);
      return {
        success: decision.success,
        retryAfterSeconds: decision.retryAfterSeconds,
      };
    });
  }

  // Read-only check: is the window already at/over the limit? Charges NOTHING.
  // Used to gate a request WITHOUT counting it, so an invalid or model-free
  // request cannot burn the budget just by arriving — the actual cost is charged
  // via consume() only when a real model call happens.
  async peek(limit: number, windowMs: number): Promise<DurableRateLimitDecision> {
    const now = Date.now();
    const current = await this.ctx.storage.get<RateLimitWindow>("window");
    const active = current && current.resetAt > now ? current : null;
    const count = active ? active.count : 0;
    const resetAt = active ? active.resetAt : now + windowMs;
    return {
      success: count < limit,
      retryAfterSeconds: Math.max(1, Math.ceil((resetAt - now) / 1_000)),
    };
  }
}
