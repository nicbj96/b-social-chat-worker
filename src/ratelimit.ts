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

type RateLimitBinding = {
  limit(input: { key: string }): Promise<{ success: boolean }>;
};

export interface RateLimitEnv {
  PUBLIC_AI_RATE_LIMITER?: RateLimitBinding;
  PUSH_RATE_LIMITER?: RateLimitBinding;
  ADMIN_RATE_LIMITER?: RateLimitBinding;
}

function rateLimiterUnavailable(corsHeaders: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: "rate_limiter_unavailable" }), {
    status: 503,
    headers: { "Content-Type": "application/json", ...corsHeaders },
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

  const binding = bucket === "public-ai"
    ? env.PUBLIC_AI_RATE_LIMITER
    : bucket === "push"
    ? env.PUSH_RATE_LIMITER
    : env.ADMIN_RATE_LIMITER;
  if (!binding) return rateLimiterUnavailable(corsHeaders);

  let success = false;
  try {
    ({ success } = await binding.limit({ key: await rateLimitActorKey(request, pathname) }));
  } catch {
    console.error(JSON.stringify({ event: "rate_limiter_unavailable", bucket, pathname }));
    return rateLimiterUnavailable(corsHeaders);
  }
  if (success) return null;

  return new Response(JSON.stringify({ error: "rate_limited", retry_after_seconds: 60 }), {
    status: 429,
    headers: {
      "Content-Type": "application/json",
      "Retry-After": "60",
      ...corsHeaders,
    },
  });
}
