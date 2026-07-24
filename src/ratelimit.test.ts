import { describe, expect, it } from "vitest";
import { chargeAiDailyBudget, enforceAiDailyBudget, enforceRateLimit, rateLimitActorKey, rateLimitBucketFor } from "./ratelimit";

describe("rateLimitBucketFor", () => {
  it("classifies expensive POST routes and leaves safe routes unlimited", () => {
    expect(rateLimitBucketFor("POST", "/chat")).toBe("public-ai");
    expect(rateLimitBucketFor("POST", "/embed")).toBe("public-ai");
    expect(rateLimitBucketFor("POST", "/search")).toBe("public-ai");
    expect(rateLimitBucketFor("POST", "/push/send")).toBe("push");
    expect(rateLimitBucketFor("POST", "/push/broadcast")).toBe("push");
    expect(rateLimitBucketFor("POST", "/admin/image")).toBe("admin");
    expect(rateLimitBucketFor("GET", "/health")).toBeNull();
    expect(rateLimitBucketFor("OPTIONS", "/chat")).toBeNull();
    expect(rateLimitBucketFor("POST", "/unknown")).toBeNull();
  });
});

describe("rateLimitActorKey", () => {
  it("returns stable opaque keys scoped by route and connecting IP", async () => {
    const first = new Request("https://worker.example/chat", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.7" },
    });
    const sameActor = new Request("https://worker.example/chat", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.7" },
    });
    const otherRoute = new Request("https://worker.example/search", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.7" },
    });
    const otherActor = new Request("https://worker.example/chat", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.8" },
    });

    const firstKey = await rateLimitActorKey(first, "/chat");
    expect(await rateLimitActorKey(sameActor, "/chat")).toBe(firstKey);
    expect(await rateLimitActorKey(otherRoute, "/search")).not.toBe(firstKey);
    expect(await rateLimitActorKey(otherActor, "/chat")).not.toBe(firstKey);
    expect(firstKey).toMatch(/^v1:[a-f0-9]{64}$/);
    expect(firstKey).not.toContain("203.0.113.7");
  });
});

describe("enforceRateLimit", () => {
  it("returns a structured 429 from the Durable Object", async () => {
    const seenKeys: string[] = [];
    const env = {
      RATE_LIMITER: {
        getByName: (key: string) => {
          seenKeys.push(key);
          return {
            consume: async () => ({ success: false, retryAfterSeconds: 60 }),
          };
        },
      },
    } as any;
    const request = new Request("https://worker.example/chat", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.7" },
    });

    const response = await enforceRateLimit(request, env, "/chat", {
      "Access-Control-Allow-Origin": "https://b-social.net",
    });

    expect(response?.status).toBe(429);
    expect(response?.headers.get("Retry-After")).toBe("60");
    expect(response?.headers.get("Access-Control-Allow-Origin")).toBe("https://b-social.net");
    expect(await response?.json()).toEqual({ error: "rate_limited", retry_after_seconds: 60 });
    expect(seenKeys).toHaveLength(1);
    expect(seenKeys[0]).toMatch(/^v1:[a-f0-9]{64}$/);
  });

  it("falls back to an in-isolate budget when the binding is missing", async () => {
    const request = new Request("https://worker.example/chat", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.70" },
    });

    for (let index = 0; index < 30; index += 1) {
      expect(await enforceRateLimit(request, {}, "/chat", {})).toBeNull();
    }
    expect((await enforceRateLimit(request, {}, "/chat", {}))?.status).toBe(429);
  });

  it("falls back locally when the Durable Object throws", async () => {
    const env = {
      RATE_LIMITER: {
        getByName: () => ({
          consume: async () => {
            throw new Error("Durable Object unavailable");
          },
        }),
      },
    } as any;
    const request = new Request("https://worker.example/search", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.71" },
    });

    const response = await enforceRateLimit(request, env, "/search", {});

    expect(response).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 429s are recorded, and what is recorded is deliberately less than what is known.
//
// The actor key is sha256(pathname || connecting IP). That is opaque to read
// but NOT anonymous -- IPv4 is four billion values, so a full hash brute-forces
// back to an address in minutes. Persisting it whole would turn a monitoring
// feature into a table of visitor IPs. Only a 12-character prefix is stored.
// ---------------------------------------------------------------------------
describe("rate limit abuse logging", () => {
  const ENV_BASE = { SUPABASE_URL: "https://db.test", SUPABASE_KEY: "k" };
  const CORS = { "Access-Control-Allow-Origin": "*" };

  function post(ip = "203.0.113.9") {
    return new Request("https://w.test/chat", {
      method: "POST",
      headers: { "CF-Connecting-IP": ip },
    });
  }

  it("writes one row per 429 and never the full key or the IP", async () => {
    const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (u: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(u), body: JSON.parse(String(init?.body ?? "{}")) });
      return new Response("", { status: 201 });
    }) as typeof fetch;
    try {
      // No RATE_LIMITER binding -> local budget; exhaust it to force a 429.
      let last: Response | null = null;
      for (let i = 0; i < 40; i++) last = await enforceRateLimit(post(), ENV_BASE, "/chat", CORS);
      expect(last?.status).toBe(429);

      expect(sent.length).toBeGreaterThan(0);
      const row = sent[0].body as { actor_prefix: string; bucket: string; path: string };
      expect(sent[0].url).toContain("/rest/v1/rate_limit_events");
      expect(row.path).toBe("/chat");
      expect(row.bucket).toBe("public-ai");
      // A prefix, not the whole digest, and not the address.
      expect(row.actor_prefix).toHaveLength(12);
      expect(row.actor_prefix.startsWith("v1:")).toBe(false);
      expect(JSON.stringify(row)).not.toContain("203.0.113.9");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("still rate-limits when logging is impossible", async () => {
    // No credentials at all: the control must not depend on the record of it.
    let last: Response | null = null;
    for (let i = 0; i < 40; i++) last = await enforceRateLimit(post("198.51.100.4"), {}, "/chat", CORS);
    expect(last?.status).toBe(429);
  });
});

// ---------------------------------------------------------------------------
// Global daily AI cost ceiling. Distinct from the per-actor velocity limit: it
// consumes each route's estimated NEURON cost against one global daily window,
// and it fails OPEN so a budget-store outage never takes chat down.
// ---------------------------------------------------------------------------
describe("enforceAiDailyBudget", () => {
  const CORS = { "Access-Control-Allow-Origin": "https://b-social.net" };
  const post = (path = "/chat") =>
    new Request(`https://w.test${path}`, { method: "POST", headers: { "CF-Connecting-IP": "203.0.113.9" } });

  it("PEEKS the one global daily key and charges NOTHING when under budget", async () => {
    const calls: Array<{ key: string; method: string; args: unknown[] }> = [];
    const env = {
      RATE_LIMITER: {
        getByName: (key: string) => ({
          peek: async (...args: unknown[]) => { calls.push({ key, method: "peek", args }); return { success: true, retryAfterSeconds: 1 }; },
          consume: async (...args: unknown[]) => { calls.push({ key, method: "consume", args }); return { success: true, retryAfterSeconds: 1 }; },
        }),
      },
    } as any;
    expect(await enforceAiDailyBudget(post("/chat"), env, "/chat", CORS)).toBeNull();
    // The pre-dispatch gate must PEEK (read-only), never consume — that is the
    // whole DoS fix: an inbound request costs nothing until a model actually runs.
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("peek");
    expect(calls[0].key).toBe("global:ai-neurons-daily");
    expect(calls[0].args[0]).toBe(40_000); // default cap
  });

  it("returns a 429 ai_budget_exhausted when the global budget is spent", async () => {
    const env = { RATE_LIMITER: { getByName: () => ({ peek: async () => ({ success: false, retryAfterSeconds: 3600 }) }) } } as any;
    const res = await enforceAiDailyBudget(post("/chat"), env, "/chat", CORS);
    expect(res?.status).toBe(429);
    expect(res?.headers.get("Retry-After")).toBe("3600");
    expect(res?.headers.get("Access-Control-Allow-Origin")).toBe("https://b-social.net");
    expect(await res?.json()).toEqual({ error: "ai_budget_exhausted", retry_after_seconds: 3600 });
  });

  it("fails OPEN — no limiter, a DO error, and non-AI routes all proceed", async () => {
    expect(await enforceAiDailyBudget(post("/chat"), {} as any, "/chat", CORS)).toBeNull();
    const throwEnv = { RATE_LIMITER: { getByName: () => ({ peek: async () => { throw new Error("DO down"); } }) } } as any;
    expect(await enforceAiDailyBudget(post("/chat"), throwEnv, "/chat", CORS)).toBeNull();
    // /push/send is not a public-AI route, so the AI budget must not touch it.
    const spentEnv = { RATE_LIMITER: { getByName: () => ({ peek: async () => ({ success: false, retryAfterSeconds: 1 }) }) } } as any;
    expect(await enforceAiDailyBudget(post("/push/send"), spentEnv, "/push/send", CORS)).toBeNull();
  });

  it("honours a configured AI_DAILY_NEURON_BUDGET cap", async () => {
    const seenCaps: number[] = [];
    const env = {
      AI_DAILY_NEURON_BUDGET: "12345",
      RATE_LIMITER: { getByName: () => ({ peek: async (cap: number) => { seenCaps.push(cap); return { success: true, retryAfterSeconds: 1 }; } }) },
    } as any;
    await enforceAiDailyBudget(post("/embed"), env, "/embed", CORS);
    expect(seenCaps[0]).toBe(12345);
  });
});

describe("chargeAiDailyBudget", () => {
  it("consumes the real per-call neurons against the one global daily key", async () => {
    const calls: Array<{ key: string; args: unknown[] }> = [];
    const env = {
      RATE_LIMITER: {
        getByName: (key: string) => ({
          consume: async (...args: unknown[]) => { calls.push({ key, args }); return { success: true, retryAfterSeconds: 1 }; },
        }),
      },
    } as any;
    await chargeAiDailyBudget(env, 250); // e.g. an image generation
    expect(calls).toHaveLength(1);
    expect(calls[0].key).toBe("global:ai-neurons-daily");
    expect(calls[0].args[0]).toBe(40_000); // cap
    expect(calls[0].args[2]).toBe(250);    // the real cost, not a flat route weight
  });

  it("is a no-op with no limiter, a non-positive cost, or a DO error (never throws)", async () => {
    // No binding.
    await expect(chargeAiDailyBudget({} as any, 55)).resolves.toBeUndefined();
    // Zero / negative neurons cost nothing.
    const seen: unknown[][] = [];
    const env = { RATE_LIMITER: { getByName: () => ({ consume: async (...a: unknown[]) => { seen.push(a); return { success: true, retryAfterSeconds: 1 }; } }) } } as any;
    await chargeAiDailyBudget(env, 0);
    await chargeAiDailyBudget(env, -5);
    expect(seen).toHaveLength(0);
    // A DO error is swallowed — budget accounting must never break a chat answer.
    const throwEnv = { RATE_LIMITER: { getByName: () => ({ consume: async () => { throw new Error("DO down"); } }) } } as any;
    await expect(chargeAiDailyBudget(throwEnv, 55)).resolves.toBeUndefined();
  });
});
