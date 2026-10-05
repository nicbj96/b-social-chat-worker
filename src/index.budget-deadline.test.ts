// Plan §9 P186–191 / M41 — worker.fetch-level RED probes for the finite
// budget/deadline vertical. Every probe drives the REAL /chat path with a
// mocked env.AI; the DB surface is mocked so nothing reaches the network.
// Adversarial set: deadline-during-tool-call, session budget exhausted,
// embedding cap, provider 429 and provider timeout.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { DB_EVENT } = vi.hoisted(() => ({
  DB_EVENT: { id: "00000000-0000-4000-8000-0000000000b1", title: "Jazz i Aarhus", location: "Musikhuset", date: "2026-10-10" },
}));

vi.mock("./supabase-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supabase-queries")>()),
  createSupabaseClient: vi.fn(() => ({})),
  searchPlaces: vi.fn(async () => ({ results: [] })),
  searchEvents: vi.fn(async () => ({ results: [DB_EVENT] })),
  searchRoutes: vi.fn(async () => ({ results: [] })),
}));

import * as queries from "./supabase-queries";
import worker from "./index";
import { __resetAiBreaker } from "./discovery-fallback";
import { __resetAiCost } from "./aiCost";

function executionContext(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
}
function baseEnv(aiRun: (...args: any[]) => any, extra: Record<string, unknown> = {}) {
  return {
    AI: { run: aiRun },
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_KEY: "test-service-key",
    ...extra,
  } as any;
}
function chatRequest(content: string): Request {
  return new Request("https://worker.example/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.90" },
    body: JSON.stringify({ messages: [{ role: "user", content }] }),
  });
}
function toolCallOnlyAi(toolCall: unknown): any {
  return vi
    .fn()
    .mockResolvedValueOnce({ tool_calls: [toolCall] });
}
const semanticSearchEvents = {
  id: "call-1",
  function: { name: "semantic_search", arguments: JSON.stringify({ kind: "events", query: "jazz i Aarhus" }) },
};

beforeEach(() => {
  __resetAiBreaker();
  __resetAiCost();
});

describe("budget/deadline — deadline during a tool call", () => {
  it("returns an honest PARTIAL answer when the wall clock expires mid-tools: named degradation, no second model call, no invented rows", async () => {
    // First model call returns a tool call; the embedding call HANGS past the
    // (short, env-configured) turn deadline.
    const aiRun = vi.fn()
      .mockResolvedValueOnce({ tool_calls: [semanticSearchEvents] })
      .mockImplementation((_model: string, input: any) =>
        input?.text
          ? new Promise(() => {}) // embedding never resolves
          : Promise.resolve({ response: "MODellEN SKAL ALDRIG SVARE" }),
      );
    const response = await worker.fetch!(
      chatRequest("jazz i Aarhus?"),
      baseEnv(aiRun, { CHAT_TURN_DEADLINE_MS: "120" }),
      executionContext(),
    );
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    // Named, distinct from a model/upstream failure:
    expect(body.degradation?.reason).toBe("turn_deadline_exceeded");
    expect(body.partial).toBe(true);
    // Honest: no invented completion, no events claimed as found.
    expect(body.event_ids).toEqual([]);
    expect(body.reply).toContain("Tidsgrænsen");
    expect(JSON.stringify(body)).not.toContain("MODellEN SKAL ALDRIG SVARE");
    // Exactly one model call — the follow-up is never spent on a lost turn.
    const modelCalls = (aiRun as any).mock.calls.filter((c: any[]) => String(c[0]).includes("llama"));
    expect(modelCalls).toHaveLength(1);
  });
});

// The fake DO namespace RESPECTS the name: every name owns its own counter,
// exactly like the real RateLimitDurableObject. `preset` seeds named
// counters; `failFor` makes the store throw for names matching a prefix.
function fakeNamespace(sessionBehavior?: { success: boolean; retryAfterSeconds: number }, opts: { preset?: Record<string, number>; failFor?: string } = {}) {
  const counters = new Map<string, number>(Object.entries(opts.preset ?? {}));
  const names: string[] = [];
  const consume = vi.fn(async (_cap: number, _window: number, _weight?: number) => ({ success: true, retryAfterSeconds: 0 }));
  const namespace = {
    getByName: (name: string) => {
      names.push(name);
      const isSession = name.startsWith("session-chat-budget:");
      return {
        consume: async (cap: number, window: number, weight = 1) => {
          consume(cap, window, weight);
          if (opts.failFor && name.startsWith(opts.failFor)) throw new Error("DO unavailable");
          if (isSession && sessionBehavior) return sessionBehavior;
          const used = (counters.get(name) ?? 0) + weight;
          if (used > cap) return { success: false, retryAfterSeconds: 300 };
          counters.set(name, used);
          return { success: true, retryAfterSeconds: 0 };
        },
        peek: async () => ({ success: true, retryAfterSeconds: 1 }),
      };
    },
  };
  return { consume, namespace, counters, names };
}

describe("budget/deadline — session budget ledger", () => {
  // The worker reuses one DO namespace for the per-actor rate limiter, the
  // global daily budget and the session ledger — each under its own key name.
  // The fake namespace routes by name so only the session ledger is scripted.
  it("a turn past the per-account cap is a named exhaustion: 429 + Retry-After + Danish message, model never called", async () => {
    const { consume, namespace } = fakeNamespace({ success: false, retryAfterSeconds: 300 });
    const aiRun = vi.fn();
    const env = baseEnv(aiRun, { RATE_LIMITER: namespace });
    const response = await worker.fetch!(chatRequest("jazz i Aarhus?"), env, executionContext());
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("300");
    const body = await response.json() as any;
    expect(body.error).toBe("session_budget_exhausted");
    // Danish, actionable message:
    expect(body.notice).toContain("dagens chat-kvota");
    expect(aiRun).not.toHaveBeenCalled();
  });

  it("charges the ledger once per turn when allowed (persisted account-scoped)", async () => {
    const { consume, namespace } = fakeNamespace({ success: true, retryAfterSeconds: 0 });
    const aiRun = vi.fn().mockRejectedValue(new Error("Workers AI 500 upstream"));
    const env = baseEnv(aiRun, { RATE_LIMITER: namespace });
    await worker.fetch!(chatRequest("godmorgen"), env, executionContext());
    // Exactly ONE charge carries the session cap (20 turns / 24h):
    const sessionCharges = (consume as any).mock.calls.filter((c: unknown[]) => c[0] === 20);
    expect(sessionCharges).toHaveLength(1);
    expect(typeof sessionCharges[0]![2]).toBe("number"); // weight 1 per turn
  });
});

describe("budget/deadline — resource caps", () => {
  it("an over-cap embedding vector is a named cap error — the RPC never fires and no rows are invented", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const aiRun = toolCallOnlyAi(semanticSearchEvents).mockImplementation((_m: string, input: any) =>
      input?.text
        ? Promise.resolve({ data: [new Array(4096).fill(0.5)] }) // over-cap vector
        : Promise.resolve({ response: "MODellEN SVARER" }),
    );
    const response = await worker.fetch!(chatRequest("jazz i Aarhus?"), baseEnv(aiRun), executionContext());
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    // The named cap error reaches the reader — never a fabricated result set:
    expect(body.reply).toContain("cap_exceeded_embedding_dims");
    expect(body.event_ids).toEqual([]);
    const rpcCalls = (fetchSpy as any).mock.calls.filter((c: any[]) => String(c[0]).includes("match_events"));
    expect(rpcCalls).toHaveLength(0);
    fetchSpy.mockRestore();
  });
});

describe("budget/deadline — degraded provider fallback contract", () => {
  it("provider 429: fail-closed deterministic DB answer with an explicit degradation notice and Retry-After — never a cached/fake answer", async () => {
    const aiRun = vi.fn().mockRejectedValue(new Error("429 quota exceeded"));
    const response = await worker.fetch!(chatRequest("jazz i Aarhus?"), baseEnv(aiRun), executionContext());
    expect(response.status).toBe(200);
    expect(response.headers.get("Retry-After")).toBeTruthy();
    const body = await response.json() as any;
    expect(body.degraded).toBe(true);
    expect(body.degradation.reason).toBe("provider_429");
    // Grounded in the real (mocked) DB row — not an invented completion:
    expect(body.reply).toContain("Jazz i Aarhus");
  });

  it("provider timeout: degradation reason provider_timeout with an explicit notice", async () => {
    const aiRun = vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
    const response = await worker.fetch!(chatRequest("jazz i Aarhus?"), baseEnv(aiRun), executionContext());
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.degraded).toBe(true);
    expect(body.degradation.reason).toBe("provider_timeout");
    expect(body.reply).toContain("Jazz i Aarhus");
  });
});

// ── Review-fix probes (request level) ───────────────────────────────────────

function authFetchMock() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input: any, init: any) => {
    const url = String(input);
    if (url.includes("/auth/v1/user")) {
      const auth = String(init?.headers?.Authorization ?? init?.headers?.authorization ?? "");
      const id = auth.replace("Bearer ", "");
      return new Response(JSON.stringify({ id }), { status: 200 });
    }
    return new Response("{}", { status: 200 });
  });
}
function authedChat(userId: string, content = "godmorgen"): Request {
  return new Request("https://worker.example/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.91", Authorization: `Bearer ${userId}` },
    body: JSON.stringify({ messages: [{ role: "user", content }] }),
  });
}
const toolCall = (name: string, args: Record<string, unknown>, id = "call-x") => ({ id, function: { name, arguments: JSON.stringify(args) } });

describe("budget/deadline — EVERY tool call is raced against the deadline", () => {
  const modelThatMustNotFollowUp = (calls: unknown[]) =>
    vi.fn().mockResolvedValueOnce({ tool_calls: calls }).mockResolvedValue({ response: "MODellEN SKAL ALDRIG SVARE" });

  async function run(aiRun: any) {
    const started = Date.now();
    const response = await worker.fetch!(chatRequest("jazz i Aarhus?"), baseEnv(aiRun, { CHAT_TURN_DEADLINE_MS: "150" }), executionContext());
    return { response, elapsed: Date.now() - started, body: await response.json() as any };
  }

  it("a hanging searchPlaces stops at the deadline: 200 partial, no follow-up model call, rows only from what was retrieved", async () => {
    vi.mocked(queries.searchPlaces).mockImplementationOnce(() => new Promise(() => {}) as any);
    const aiRun = modelThatMustNotFollowUp([
      toolCall("search_events", { city: "Aarhus" }, "c1"),
      toolCall("search_places", { city: "Aarhus" }, "c2"),
    ]);
    const { response, elapsed, body } = await run(aiRun);
    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(1500);
    expect(body.partial).toBe(true);
    expect(body.degradation.reason).toBe("turn_deadline_exceeded");
    expect(body.reply).toContain("Tidsgrænsen");
    expect(body.reply).toContain("Jazz i Aarhus"); // retrieved BEFORE the hang
    expect(body.event_ids).toEqual(["00000000-0000-4000-8000-0000000000b1"]);
    expect(body.place_ids).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("SKAL ALDRIG");
    expect((aiRun as any).mock.calls.filter((c: any[]) => String(c[0]).includes("llama"))).toHaveLength(1);
  });

  it("a hanging searchRoutes stops at the deadline", async () => {
    vi.mocked(queries.searchRoutes).mockImplementationOnce(() => new Promise(() => {}) as any);
    const aiRun = modelThatMustNotFollowUp([toolCall("search_routes", { activity_type: "running" })]);
    const { response, elapsed, body } = await run(aiRun);
    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(1500);
    expect(body.partial).toBe(true);
    expect(body.degradation.reason).toBe("turn_deadline_exceeded");
    expect((aiRun as any).mock.calls.filter((c: any[]) => String(c[0]).includes("llama"))).toHaveLength(1);
  });

  it("a hanging match_events RPC (semantic_search) stops at the deadline", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input: any) =>
      String(input).includes("match_events") ? (new Promise(() => {}) as any) : Promise.resolve(new Response("{}", { status: 200 })));
    const aiRun = vi.fn()
      .mockResolvedValueOnce({ tool_calls: [toolCall("semantic_search", { kind: "events", query: "jazz" })] })
      .mockImplementation((_m: string, input: any) => input?.text ? Promise.resolve({ data: [new Array(1024).fill(0.1)] }) : Promise.resolve({ response: "SKAL ALDRIG" }));
    const { response, elapsed, body } = await run(aiRun);
    fetchSpy.mockRestore();
    expect(response.status).toBe(200);
    expect(elapsed).toBeLessThan(1500);
    expect(body.partial).toBe(true);
    expect(body.event_ids).toEqual([]);
    expect((aiRun as any).mock.calls.filter((c: any[]) => String(c[0]).includes("llama"))).toHaveLength(1);
  });

  it("a hanging write tool (RPC/event style fetch) stops at the deadline", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((input: any) =>
      String(input).includes("/auth/v1/user") ? Promise.resolve(new Response(JSON.stringify({ id: "user-A" }), { status: 200 }))
        : String(input).includes("event_rsvps") ? (new Promise(() => {}) as any) : Promise.resolve(new Response("{}", { status: 200 })));
    const aiRun = modelThatMustNotFollowUp([toolCall("rsvp_event", { event_id: "00000000-0000-4000-8000-0000000000b1", status: "going" })]);
    const req = new Request("https://worker.example/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.92", Authorization: "Bearer user-A" },
      body: JSON.stringify({ messages: [{ role: "user", content: "meld mig til" }] }),
    });
    const started = Date.now();
    const response = await worker.fetch!(req, baseEnv(aiRun, { CHAT_TURN_DEADLINE_MS: "150" }), executionContext());
    fetchSpy.mockRestore();
    expect(Date.now() - started).toBeLessThan(1500);
    expect(response.status).toBe(200);
    expect(((await response.json()) as any).partial).toBe(true);
  });
});

describe("budget/deadline — row caps are visible on the chat RESPONSE", () => {
  const manyEvents = Array.from({ length: 12 }, (_, i) => ({ id: `evt-${i}`, title: `Event ${i}`, location: "X", date: "2026-10-10" }));
  const manyPlaces = Array.from({ length: 11 }, (_, i) => ({ id: `plc-${i}`, name: `Sted ${i}`, city: "Aarhus" }));

  it("search_events over the row cap: payload carries rows_capped and only 8 events", async () => {
    vi.mocked(queries.searchEvents).mockResolvedValueOnce({ results: manyEvents } as any);
    const aiRun = vi.fn().mockResolvedValueOnce({ tool_calls: [toolCall("search_events", { city: "Aarhus" })] }).mockResolvedValue({ response: "Her er events" });
    const response = await worker.fetch!(chatRequest("events i Aarhus?"), baseEnv(aiRun), executionContext());
    const body = await response.json() as any;
    expect(body.rows_capped).toBe(8);
    expect(body.event_ids).toHaveLength(8);
  });

  it("search_places over the row cap is capped and flagged too (not only events)", async () => {
    vi.mocked(queries.searchPlaces).mockResolvedValueOnce({ results: manyPlaces } as any);
    const aiRun = vi.fn().mockResolvedValueOnce({ tool_calls: [toolCall("search_places", { city: "Aarhus" })] }).mockResolvedValue({ response: "Her er steder" });
    const response = await worker.fetch!(chatRequest("steder i Aarhus?"), baseEnv(aiRun), executionContext());
    const body = await response.json() as any;
    expect(body.rows_capped).toBe(8);
    expect(body.place_ids).toHaveLength(8);
  });

  it("within the cap: no rows_capped flag", async () => {
    const aiRun = vi.fn().mockResolvedValueOnce({ tool_calls: [toolCall("search_events", { city: "Aarhus" })] }).mockResolvedValue({ response: "Her er events" });
    const body = await (await worker.fetch!(chatRequest("events i Aarhus?"), baseEnv(aiRun), executionContext())).json() as any;
    expect(body.rows_capped).toBeUndefined();
  });
});

describe("budget/deadline — response byte cap on ALL reply paths", () => {
  it("plain (no-tool) model reply over the cap is truncated and flagged", async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: "x".repeat(300_000) });
    const response = await worker.fetch!(chatRequest("godmorgen"), baseEnv(aiRun), executionContext());
    const text = await response.text();
    expect(text.length).toBeLessThanOrEqual(200_000);
    expect(JSON.parse(text).response_truncated).toBe(200_000);
  });

  it("degraded fallback path is byte-capped and flagged too", async () => {
    vi.mocked(queries.searchEvents).mockResolvedValueOnce({ results: [{ ...DB_EVENT, title: "T".repeat(300_000) }] } as any);
    const aiRun = vi.fn().mockRejectedValue(new Error("Workers AI 500 upstream"));
    const response = await worker.fetch!(chatRequest("jazz i Aarhus?"), baseEnv(aiRun), executionContext());
    const text = await response.text();
    expect(text.length).toBeLessThanOrEqual(200_000);
    const body = JSON.parse(text);
    expect(body.response_truncated).toBe(200_000);
    expect(body.degraded).toBe(true);
  });

  it("a normal-size reply carries no response_truncated", async () => {
    const aiRun = vi.fn().mockResolvedValue({ response: "Hej!" });
    const body = await (await worker.fetch!(chatRequest("godmorgen"), baseEnv(aiRun), executionContext())).json() as any;
    expect(body.response_truncated).toBeUndefined();
  });
});

describe("budget/deadline — account-key isolation at /chat level (name-respecting DO)", () => {
  it("account A exhausted does not exhaust account B; each charge uses its own account key", async () => {
    const fetchSpy = authFetchMock();
    const { namespace, names } = fakeNamespace(undefined, { preset: { "session-chat-budget:v1:account:user-A": 20 } });
    const aiRun = vi.fn().mockResolvedValue({ response: "Hej!" });
    const env = baseEnv(aiRun, { RATE_LIMITER: namespace });
    const a = await worker.fetch!(authedChat("user-A"), env, executionContext());
    expect(a.status).toBe(429);
    const b = await worker.fetch!(authedChat("user-B"), env, executionContext());
    fetchSpy.mockRestore();
    expect(b.status).toBe(200);
    expect(names).toContain("session-chat-budget:v1:account:user-A");
    expect(names).toContain("session-chat-budget:v1:account:user-B");
  });

  it("store outage for the session key fails OPEN at request level (200, model called)", async () => {
    const { namespace } = fakeNamespace(undefined, { failFor: "session-chat-budget:" });
    const aiRun = vi.fn().mockResolvedValue({ response: "Hej!" });
    const response = await worker.fetch!(chatRequest("godmorgen"), baseEnv(aiRun, { RATE_LIMITER: namespace }), executionContext());
    expect(response.status).toBe(200);
    expect(aiRun).toHaveBeenCalled();
  });
});
