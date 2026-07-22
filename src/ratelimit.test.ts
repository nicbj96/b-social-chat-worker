import { describe, expect, it } from "vitest";
import { enforceRateLimit, rateLimitActorKey, rateLimitBucketFor } from "./ratelimit";

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
