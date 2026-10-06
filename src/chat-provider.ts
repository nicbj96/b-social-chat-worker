// Plan §9 P186–191 / M41: finite budget, deadline and degradation contract on
// the chat path. Four named behaviours, all honest:
//
//   1. TURN DEADLINE — one wall-clock budget per /chat turn. Expiry is a NAMED
//      error (`turn_deadline_exceeded`), distinct from a model/upstream
//      failure and from the TurnBudget call caps. A turn that runs out of time
//      mid-tools gets an honest PARTIAL answer built only from what actually
//      came back — never an invented completion.
//
//   2. SESSION BUDGET LEDGER — per-account (or per-anon-actor) turn count
//      persisted through the existing Durable Object store, 24h window.
//      Exhaustion is NAMED (`session_budget_exhausted`) and returns 429 with
//      Retry-After and a Danish message. Missing/broken store fails OPEN
//      (same contract as the global daily budget: a budget-store outage must
//      never take chat down; the per-actor rate limiter still applies).
//
//   3. RESOURCE CAPS — embedding dimensions, collected rows and response
//      bytes are asserted. Over-cap is a named error/flag, never silently
//      truncated into a plausible-looking answer.
//
//   4. DEGRADATION CONTRACT — a degraded provider (429, timeout, other
//      upstream failure) answers fail-closed from the live deterministic DB
//      path with an explicit degradation notice and (for 429) Retry-After.
//      The fallback NEVER replays a cached/fabricated answer: it is rebuilt
//      from a fresh catalogue query on every degraded turn.
//
// Related plan lines: P188 (turn call budget — chat-budget.ts), P190
// (budget-exhausted/AI-failure keeps the deterministic catalogue; 429 carries
// Retry-After and a Danish message), P189 (atomic reservations / soft caps).

/** Wall-clock budget for one /chat turn. Configurable per environment via
 *  CHAT_TURN_DEADLINE_MS (tests use small values); production default 8s
 *  matches the release gate "chat p95 ≤8 s, fallback ≤10 s". */
export const CHAT_TURN_DEADLINE_MS = 8_000;

export function turnDeadlineMs(envValue: string | undefined): number {
  const n = Number(envValue);
  return Number.isFinite(n) && n > 0 ? n : CHAT_TURN_DEADLINE_MS;
}

export class TurnDeadlineExceeded extends Error {
  readonly code = "turn_deadline_exceeded";
  constructor() {
    super("turn_deadline_exceeded");
  }
}

export class TurnDeadline {
  private readonly startedAt: number;

  constructor(
    /** Wall-clock budget in milliseconds. */ readonly ms: number,
    now: number = Date.now(),
  ) {
    this.startedAt = now;
  }

  remainingMs(now: number = Date.now()): number {
    return this.ms - (now - this.startedAt);
  }

  expired(now: number = Date.now()): boolean {
    return this.remainingMs(now) <= 0;
  }

  /** Throws the NAMED deadline error when the turn is out of time. */
  check(now: number = Date.now()): void {
    if (this.expired(now)) throw new TurnDeadlineExceeded();
  }

  /** Race an awaited promise against the remaining wall clock. The timer is
   *  cleared when the promise wins, so a fast path leaves nothing behind. */
  race<T>(p: Promise<T>): Promise<T> {
    if (this.expired()) return Promise.reject(new TurnDeadlineExceeded());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      const wait = Math.max(0, this.remainingMs());
      timer = setTimeout(() => reject(new TurnDeadlineExceeded()), wait);
    });
    return Promise.race([
      p.finally(() => { if (timer !== undefined) clearTimeout(timer); }),
      timeout,
    ]);
  }
}

// ── Session budget ledger ────────────────────────────────────────────────────

export const CHAT_TIERS = { free: 5, plus: 200 } as const;
export type ChatTier = keyof typeof CHAT_TIERS;
export const SESSION_BUDGET_WINDOW_MS = 24 * 3_600_000;
/** @deprecated kept for old imports; equals the free tier. */
export const SESSION_CHAT_BUDGET = { turns: CHAT_TIERS.free, window_hours: 24 } as const;

/** The one store method the ledger needs — exactly the RateLimitDurableObject
 *  stub surface, so the existing DO is the production implementation. */
export interface SessionBudgetStore {
  consume(cap: number, windowMs: number, weight?: number): Promise<{ success: boolean; retryAfterSeconds: number }>;
}

export interface SessionBudgetDecision {
  allowed: boolean;
  retryAfterSeconds: number;
  /** false when no store is bound or the store failed — the charge did NOT
   *  persist, and the decision is fail-open, never fail-fake. */
  persisted: boolean;
}

/**
 * Account-scoped ledger key. Logged-in turns scope to the account id; anon
 * turns scope to the (hashed) actor key the rate limiter already computes.
 * The name is the persistence identity in the Durable Object store.
 */
export function sessionBudgetKey(userId: string | null, actorKey: string): string {
  const actor = actorKey.replace(/^v1:/, "");
  return userId ? `session-chat-budget:v2:account:${userId}` : `session-chat-budget:v2:anon:${actor}`;
}

/** Charge ONE chat turn against the account's session budget. */
export async function consumeSessionTurnBudget(
  store: SessionBudgetStore | undefined,
  key: string,
  weight = 1,
  cap: number = CHAT_TIERS.free,
): Promise<SessionBudgetDecision & { cap: number; remaining: number | null }> {
  if (!store) return { allowed: true, retryAfterSeconds: 0, persisted: false, cap, remaining: null };
  try {
    const d = await store.consume(cap, SESSION_BUDGET_WINDOW_MS, weight);
    return { allowed: d.success, retryAfterSeconds: d.retryAfterSeconds, persisted: true, cap, remaining: (d as { remaining?: number }).remaining ?? null };
  } catch (err) {
    // Fail-open by contract (CLAUDE.md): a budget-store outage must never take
    // chat down. Log it by name so the degradation is observable.
    console.error(JSON.stringify({ event: "session_budget_unavailable", fallback: "allow", detail: String(err instanceof Error ? err.message : err).slice(0, 120) }));
    return { allowed: true, retryAfterSeconds: 0, persisted: false, cap, remaining: null };
  }
}

// ── Resource caps ────────────────────────────────────────────────────────────

export const RESOURCE_CAPS = {
  embedding_dims: 1024, // bge-m3 is 1024-dim; anything else is not our model's output
  rows: 8, // one page of results per side, matching the catalogue contract
  response_bytes: 200_000,
} as const;

export class ResourceCapExceeded extends Error {
  constructor(readonly cap: string, readonly limit: number) {
    super(`cap_exceeded_${cap}`);
  }
}

/** Assert the embedding vector is real and within the dimension cap. */
export function assertEmbeddingDims(vec: unknown): void {
  if (!Array.isArray(vec) || vec.length === 0 || typeof vec[0] !== "number") {
    throw new ResourceCapExceeded("embedding_dims", RESOURCE_CAPS.embedding_dims);
  }
  if (vec.length > RESOURCE_CAPS.embedding_dims) {
    throw new ResourceCapExceeded("embedding_dims", RESOURCE_CAPS.embedding_dims);
  }
}

/** Cap a row collection; the flag is always surfaced, never swallowed. */
export function capRows<T>(rows: T[], cap: number = RESOURCE_CAPS.rows): { rows: T[]; capped: boolean } {
  if (rows.length <= cap) return { rows, capped: false };
  return { rows: rows.slice(0, cap), capped: true };
}

/** Cap the JSON byte size of a reply payload by shrinking the `reply` string.
 *  The truncation is flagged in the returned payload, so a caller can never
 *  mistake a cut answer for a complete one. */
export function capReplyBytes<P extends { reply?: string }>(payload: P, cap: number = RESOURCE_CAPS.response_bytes): { payload: P & { response_truncated?: number }; capped: boolean } {
  const size = () => JSON.stringify(payload).length;
  if (size() <= cap) return { payload, capped: false };
  const out: P & { response_truncated?: number } = { ...payload };
  const reply = typeof out.reply === "string" ? out.reply : "";
  let lo = 0;
  let hi = reply.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi + 1) / 2);
    out.reply = reply.slice(0, mid);
    if (size() <= cap) lo = mid;
    else hi = mid - 1;
  }
  out.reply = reply.slice(0, lo);
  out.response_truncated = RESOURCE_CAPS.response_bytes;
  return { payload: out, capped: true };
}

// ── Provider degradation contract ────────────────────────────────────────────

export type DegradationReason =
  | "provider_429"
  | "provider_timeout"
  | "provider_error"
  | "turn_deadline_exceeded"
  | "session_budget_exhausted"
  | "plus_fair_use_exhausted";

const DANISH_NOTICES: Record<DegradationReason, string> = {
  provider_429: "Der er midlertidigt travlt på AI-tjenesten. Prøv igen om lidt — kataloget under Udforsk virker som altid.",
  provider_timeout: "AI-tjenesten svarede ikke i tid. Svaret her er hentet direkte fra B-Socials katalog.",
  provider_error: "AI-tjenesten svarer ikke lige nu. Svaret her er hentet direkte fra B-Socials katalog.",
  turn_deadline_exceeded: "Tidsgrænsen for svaret udløb. Her er det, der nåede at blive hentet — intet er gættet.",
  session_budget_exhausted: "Du har brugt dine 5 gratis AI-søgninger i dag. Få 200 AI-søgninger om dagen med B-Social Plus (39 kr/md) — eller prøv igen i morgen. Almindelig søgning virker som altid.",
  plus_fair_use_exhausted: "Du har nået dagens fair-use-grænse for AI. Prøv igen i morgen.",
};

export function degradationNotice(
  reason: DegradationReason,
  retryAfterSeconds?: number,
): { degraded: true; reason: DegradationReason; notice: string; retry_after_seconds?: number } {
  return {
    degraded: true,
    reason,
    notice: DANISH_NOTICES[reason],
    ...(typeof retryAfterSeconds === "number" && retryAfterSeconds > 0 ? { retry_after_seconds: retryAfterSeconds } : {}),
  };
}

/** Classify an upstream provider failure into a distinct named reason. */
export function classifyProviderFailure(err: unknown): "provider_429" | "provider_timeout" | "provider_error" {
  // Structured signals ONLY: HTTP status, error code and error name (also on
  // `cause`). Free-text message matching misclassified ids/names that merely
  // contained "429" or "timeout".
  const sources: any[] = [err, (err as any)?.cause, (err as any)?.response].filter((x) => x && typeof x === "object");
  const statuses = sources.flatMap((o) => [o.status, o.statusCode]).filter((n) => typeof n === "number");
  const codes = sources.flatMap((o) => [o.code, o.type]).filter((c) => typeof c === "string").map((c: string) => c.toLowerCase());
  const names = sources.map((o) => o.name).filter((n) => typeof n === "string");
  if (statuses.includes(429) || codes.some((c) => c === "429" || c.includes("rate_limit") || c.includes("quota") || c === "too_many_requests")) {
    return "provider_429";
  }
  if (
    statuses.some((n) => n === 408 || n === 504) ||
    names.includes("AbortError") || names.includes("TimeoutError") ||
    codes.some((c) => c.includes("timeout") || c.includes("timedout") || c === "etimedout" || c === "econnaborted")
  ) {
    return "provider_timeout";
  }
  // Workers AI surfaces its errors as plain Error("<code>: <text>") with a
  // numeric leading code; accept ONLY that exact leading-token shape.
  const msg = String(err instanceof Error ? err.message : err).trim().toLowerCase();
  const lead = /^(\d{3})\b/.exec(msg)?.[1];
  if (lead === "429" && !statuses.length) return "provider_429";
  if (/^(quota|rate limit)\b/.test(msg) || /^(3040|3036): /.test(msg)) return "provider_429";
  if (/^operation timed out\b/.test(msg)) return "provider_timeout";
  return "provider_error";
}
