import { DurableObject } from "cloudflare:workers";
import { advanceRateLimitWindow, type RateLimitWindow } from "./rate-limit-window";

export interface DurableRateLimitDecision {
  success: boolean;
  retryAfterSeconds: number;
}

export class RateLimitDurableObject extends DurableObject {
  async consume(limit: number, windowMs: number): Promise<DurableRateLimitDecision> {
    const now = Date.now();
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<RateLimitWindow>("window");
      const decision = advanceRateLimitWindow(current, limit, windowMs, now);
      await transaction.put("window", decision.window);
      return {
        success: decision.success,
        retryAfterSeconds: decision.retryAfterSeconds,
      };
    });
  }
}
