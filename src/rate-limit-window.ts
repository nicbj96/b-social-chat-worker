export interface RateLimitWindow {
  count: number;
  resetAt: number;
}

export interface RateLimitDecision {
  window: RateLimitWindow;
  success: boolean;
  retryAfterSeconds: number;
}

export function advanceRateLimitWindow(
  current: RateLimitWindow | undefined,
  limit: number,
  windowMs: number,
  now: number,
): RateLimitDecision {
  const window = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : { ...current };

  window.count += 1;
  return {
    window,
    success: window.count <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1_000)),
  };
}
