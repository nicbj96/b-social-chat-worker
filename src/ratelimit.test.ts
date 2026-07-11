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
  it("returns a structured 429 from the matching native binding", async () => {
    const seenKeys: string[] = [];
    const env = {
      PUBLIC_AI_RATE_LIMITER: {
        limit: async ({ key }: { key: string }) => {
          seenKeys.push(key);
          return { success: false };
        },
      },
    };
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

  it("fails closed when the configured route binding is missing", async () => {
    const request = new Request("https://worker.example/chat", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.7" },
    });

    const response = await enforceRateLimit(request, {}, "/chat", {});

    expect(response?.status).toBe(503);
    expect(response?.headers.get("X-BSocial-Rate-Limit-State")).toBe("binding_missing");
    expect(await response?.json()).toEqual({ error: "rate_limiter_unavailable" });
  });

  it("fails closed when the native binding throws", async () => {
    const env = {
      PUBLIC_AI_RATE_LIMITER: {
        limit: async () => {
          throw new Error("binding unavailable");
        },
      },
    };
    const request = new Request("https://worker.example/search", {
      method: "POST",
      headers: { "CF-Connecting-IP": "203.0.113.7" },
    });

    const response = await enforceRateLimit(request, env, "/search", {});

    expect(response?.status).toBe(503);
    expect(response?.headers.get("X-BSocial-Rate-Limit-State")).toBe("binding_error");
    expect(await response?.json()).toEqual({ error: "rate_limiter_unavailable" });
  });
});
