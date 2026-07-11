import type { RateLimitDurableObject } from "./rate-limit-do";

export type RateLimitBucket = "public-ai" | "push" | "admin";

const PUBLIC_AI_ROUTES = new Set(["/chat", "/embed", "/search"]);
const PUSH_ROUTES = new Set(["/push/send", "/push/broadcast"]);

export function rateLimitBucketFor(method: string, pathname: string): RateLimitBucket | null {
  if (method !== "POST") return null;
  if (PUBLIC_AI_ROUTES.has(pathname)) return "public-ai";
  if (PUSH_ROUTES.has(pathname)) return "push";
  if (pathname.startsWith("/admin/")) return "admin";
  return null;
}

export async function rateLimitActorKey(request: Request, pathname: string): Promise<string> {
  const connectingIp = request.headers.get("CF-Connecting-IP")?.trim()
    || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    || "unknown";
  const input = new TextEncoder().encode(`${pathname}\u0000${connectingIp}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `v1:${hex}`;
}

export interface RateLimitEnv {
  RATE_LIMITER?: DurableObjectNamespace<RateLimitDurableObject>;
}

const LIMITS: Record<RateLimitBucket, number> = {
  "public-ai": 30,
  push: 60,
  admin: 30,
};
const WINDOW_MS = 60_000;
const MAX_LOCAL_KEYS = 5_000;
const localWindows = new Map<string, { count: number; resetAt: number }>();

function consumeLocalBudget(key: string, bucket: RateLimitBucket, now = Date.now()): boolean {
  let window = localWindows.get(key);
  if (!window || window.resetAt <= now) {
    if (!window && localWindows.size >= MAX_LOCAL_KEYS) {
      const oldestKey = localWindows.keys().next().value as string | undefined;
      if (oldestKey) localWindows.delete(oldestKey);
    }
    window = { count: 0, resetAt: now + WINDOW_MS };
    localWindows.set(key, window);
  }
  window.count += 1;
  return window.count <= LIMITS[bucket];
}

function rateLimitedResponse(
  corsHeaders: Record<string, string>,
  retryAfterSeconds = 60,
): Response {
  return new Response(JSON.stringify({ error: "rate_limited", retry_after_seconds: retryAfterSeconds }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": String(retryAfterSeconds),
      ...corsHeaders,
    },
  });
}

export async function enforceRateLimit(
  request: Request,
  env: RateLimitEnv,
  pathname: string,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  const bucket = rateLimitBucketFor(request.method, pathname);
  if (!bucket) return null;

  const key = await rateLimitActorKey(request, pathname);
  if (!env.RATE_LIMITER) {
    return consumeLocalBudget(key, bucket) ? null : rateLimitedResponse(corsHeaders);
  }

  try {
    const stub = env.RATE_LIMITER.getByName(key);
    const decision = await stub.consume(LIMITS[bucket], WINDOW_MS);
    return decision.success ? null : rateLimitedResponse(corsHeaders, decision.retryAfterSeconds);
  } catch {
    console.error(JSON.stringify({ event: "durable_rate_limiter_unavailable", bucket, pathname, fallback: "local" }));
    return consumeLocalBudget(key, bucket) ? null : rateLimitedResponse(corsHeaders);
  }
}
