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
  weight = 1,
): RateLimitDecision {
  const window = !current || current.resetAt <= now
    ? { count: 0, resetAt: now + windowMs }
    : { ...current };

  // weight defaults to 1 (one request = one unit — the per-actor rate limiter's
  // behaviour, unchanged). A cost ceiling passes the call's estimated neuron
  // cost so an image generation counts far more than a chat turn.
  window.count += weight;
  return {
    window,
    success: window.count <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1_000)),
  };
}
