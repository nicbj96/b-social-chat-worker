// Plan §9 P186–191 / M41 — worker.fetch-level RED probes for the finite
// budget/deadline vertical. Every probe drives the REAL /chat path with a
// mocked env.AI; the DB surface is mocked so nothing reaches the network.
// Adversarial set: deadline-during-tool-call, session budget exhausted,
// embedding cap, provider 429 and provider timeout.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { DB_EVENT } = vi.hoisted(() => ({
  DB_EVENT: { id: "evt-bd-1", title: "Jazz i Aarhus", location: "Musikhuset", date: "2026-10-10" },
}));

vi.mock("./supabase-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supabase-queries")>()),
  createSupabaseClient: vi.fn(() => ({})),
  searchPlaces: vi.fn(async () => ({ results: [] })),
  searchEvents: vi.fn(async () => ({ results: [DB_EVENT] })),
  searchRoutes: vi.fn(async () => ({ results: [] })),
}));

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

describe("budget/deadline — session budget ledger", () => {
  // The worker reuses one DO namespace for the per-actor rate limiter, the
  // global daily budget and the session ledger — each under its own key name.
  // The fake namespace routes by name so only the session ledger is scripted.
  function fakeNamespace(sessionBehavior: { success: boolean; retryAfterSeconds: number }) {
    const consume = vi.fn(async (_cap: number, _window: number, _weight?: number) =>
      _cap === 8_640_000 || _cap === 30 || _cap === 40_000
        ? { success: true, retryAfterSeconds: 0 }
        : sessionBehavior,
    );
    return { consume, namespace: { getByName: () => ({ consume, peek: async () => ({ success: true, retryAfterSeconds: 1 }) }) } };
  }

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
