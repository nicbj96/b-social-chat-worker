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
  SUPABASE_URL?: string;
  SUPABASE_KEY?: string;
  // rate_limit_events grants INSERT to service_role only (anon-write on an abuse
  // log would let anyone spam it). The rest of the worker uses the anon key with
  // per-user JWTs; the abuse-log write is the one place that needs service_role,
  // so it gets its own binding rather than elevating SUPABASE_KEY everywhere.
  SUPABASE_SERVICE_KEY?: string;
}

/**
 * Record one 429 so abuse is reviewable.
 *
 * Only the first 12 hex characters of the actor key are stored. The full key is
 * sha256(pathname || connecting IP), which is opaque to read but NOT anonymous:
 * IPv4 has four billion values, so a complete hash brute-forces back to an
 * address in minutes. Persisting it whole would quietly turn a monitoring
 * feature into a table of visitor IP addresses.
 *
 * A prefix still groups a repeat offender within a window, which is the only
 * question abuse review actually asks, while leaving reversal ambiguous.
 *
 * Fire-and-forget and failure-silent: a logging outage must never turn into a
 * rate-limiting outage.
 */
async function recordRateLimitHit(
  env: RateLimitEnv,
  key: string,
  bucket: RateLimitBucket,
  pathname: string,
): Promise<void> {
  // Opaque actor prefix: first 12 hex chars of sha256(path||IP). Same value the
  // DB stores (privacy-reviewed) -- NOT a raw address, so it is safe to log.
  const actorPrefix = key.replace(/^v1:/, "").slice(0, 12);

  // ALWAYS emit a structured trail line, independent of the Supabase write. This
  // is the answer to "is anyone abusing this": every 429 is now reviewable in
  // Cloudflare Workers Logs (tail + retained observability) with zero credential
  // required. The rate_limit_events INSERT below is the richer, queryable store
  // (feeds rate_limit_offenders) and lights up the moment a service_role key is
  // set -- but abuse is reviewable NOW, from the worker's own logs.
  console.log(JSON.stringify({ event: "rate_limit_hit", actor_prefix: actorPrefix, bucket, path: pathname }));

  // Prefer the service_role key (granted INSERT on rate_limit_events); fall back
  // to the anon key so the worker degrades to "logs loudly" rather than crashing
  // if the secret is not set yet.
  const writeKey = env.SUPABASE_SERVICE_KEY || env.SUPABASE_KEY;
  if (!env.SUPABASE_URL || !writeKey) return;
  try {
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rate_limit_events`, {
      method: "POST",
      headers: {
        apikey: writeKey,
        Authorization: `Bearer ${writeKey}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        actor_prefix: actorPrefix,
        bucket,
        path: pathname,
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) {
      // Loud in the logs, harmless to the request. Verified 2026-07-22: six real
      // 429s produced zero rows, because this worker's SUPABASE_KEY is the ANON
      // key and rate_limit_events grants INSERT to service_role only -- which is
      // correct, since granting anon write on an abuse log would let anyone fill
      // it with noise or simply fill the disk.
      //
      // Left failing LOUDLY rather than removed. A silent no-op in production is
      // the exact "looks like it works" state worth avoiding, and this starts
      // working the moment the worker is given a service_role key -- which means
      // setting a secret, and that is the owner's to do, not mine.
      console.error(JSON.stringify({
        event: "rate_limit_audit_write_failed",
        status: res.status,
        hint: "SUPABASE_KEY likely lacks INSERT on rate_limit_events (service_role required)",
      }));
    }
  } catch (err) {
    console.error(JSON.stringify({
      event: "rate_limit_audit_write_threw",
      detail: String(err instanceof Error ? err.message : err).slice(0, 120),
    }));
  }
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
  // Every 429 goes through here, so there is exactly one place to forget.
  const blocked = (retryAfterSeconds?: number): Response => {
    void recordRateLimitHit(env, key, bucket, pathname);
    return rateLimitedResponse(corsHeaders, retryAfterSeconds);
  };

  if (!env.RATE_LIMITER) {
    return consumeLocalBudget(key, bucket) ? null : blocked();
  }

  try {
    const stub = env.RATE_LIMITER.getByName(key);
    const decision = await stub.consume(LIMITS[bucket], WINDOW_MS);
    return decision.success ? null : blocked(decision.retryAfterSeconds);
  } catch {
    console.error(JSON.stringify({ event: "durable_rate_limiter_unavailable", bucket, pathname, fallback: "local" }));
    return consumeLocalBudget(key, bucket) ? null : blocked();
  }
}

// ── Global daily AI cost ceiling ──
//
// The per-actor limiter above caps VELOCITY (30 public-AI req/min per IP) but not
// cumulative daily SPEND: many actors each under 30/min still sum to unbounded
// neurons over a day, and Cloudflare bills in neurons (10.000/day free). This
// caps the aggregate against ONE global daily window.
//
// TWO PHASES, and this split is the security fix (audit 2026-07-24):
//   • enforceAiDailyBudget() PEEKS before dispatch — it only REJECTS when the
//     ceiling is already spent, and charges NOTHING. Previously it consumed the
//     route's full weight on every inbound POST, BEFORE body validation, so an
//     attacker could exhaust the whole day's budget with ~690 malformed,
//     model-free requests (one IP in ~23 min) and 429 the chat for everyone for
//     up to 24h. A request that never reaches a model must cost nothing.
//   • chargeAiDailyBudget() DEDUCTS the real per-call neuron cost, called from
//     the aiCost usage reporter — i.e. only when env.AI.run actually fires. This
//     also makes the ceiling reflect true spend across ALL models (image=250,
//     vision=60, chat=55+embed), not a flat per-route pre-estimate.
//
// FAIL-OPEN by contract (CLAUDE.md): a budget-store outage must never take chat
// down. On any Durable Object error, or with no limiter bound, the request
// proceeds — the per-actor limiter still applies, and the ceiling is a secondary
// backstop, not the primary gate.
const DAY_MS = 86_400_000;
const DEFAULT_DAILY_NEURON_BUDGET = 40_000; // ~4x the 10k/day free tier: a runaway catch, not a throttle
const AI_BUDGET_KEY = "global:ai-neurons-daily";

export interface AiBudgetEnv extends RateLimitEnv {
  AI_DAILY_NEURON_BUDGET?: string;
}

function aiBudgetCap(env: AiBudgetEnv): number {
  return Number(env.AI_DAILY_NEURON_BUDGET) > 0
    ? Number(env.AI_DAILY_NEURON_BUDGET)
    : DEFAULT_DAILY_NEURON_BUDGET;
}

/**
 * Pre-dispatch gate. Rejects a public-AI request ONLY when the global daily
 * neuron budget is already spent. Charges nothing — a malformed or model-free
 * request that gets this far costs zero, so it cannot be used to drain the cap.
 */
export async function enforceAiDailyBudget(
  request: Request,
  env: AiBudgetEnv,
  pathname: string,
  corsHeaders: Record<string, string>,
): Promise<Response | null> {
  if (request.method !== "POST" || !PUBLIC_AI_ROUTES.has(pathname)) return null;
  if (!env.RATE_LIMITER) return null; // no global store — fail open (per-actor limit still guards)

  try {
    const stub = env.RATE_LIMITER.getByName(AI_BUDGET_KEY);
    const decision = await stub.peek(aiBudgetCap(env), DAY_MS);
    if (decision.success) return null;
    return new Response(
      JSON.stringify({ error: "ai_budget_exhausted", retry_after_seconds: decision.retryAfterSeconds }),
      {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(decision.retryAfterSeconds), ...corsHeaders },
      },
    );
  } catch {
    console.error(JSON.stringify({ event: "ai_daily_budget_unavailable", pathname, fallback: "allow" }));
    return null; // fail-open: never take chat down for a budget-store outage
  }
}

/**
 * Deduct the real neuron cost of ONE model call from the global daily window.
 * Called from the aiCost usage reporter, so only actual env.AI.run() calls move
 * the meter. Fire-and-forget: budget accounting must never delay or break an
 * answer, and a lost increment is an undercount, not an outage.
 */
export async function chargeAiDailyBudget(env: AiBudgetEnv, neurons: number): Promise<void> {
  if (!env.RATE_LIMITER || !(neurons > 0)) return;
  try {
    const stub = env.RATE_LIMITER.getByName(AI_BUDGET_KEY);
    await stub.consume(aiBudgetCap(env), DAY_MS, neurons);
  } catch {
    console.error(JSON.stringify({ event: "ai_daily_budget_charge_failed", neurons }));
  }
}
