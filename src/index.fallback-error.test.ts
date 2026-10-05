// Plan W2 Task 8 — fallback must tell a DB failure from an empty result.
// Drives the REAL /chat path with a failing env.AI; the DB surface is mocked.
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

describe("directDiscoveryFallback — DB error vs empty", () => {
  it("answers 'could not search' (not 'no results') when the DB errors", async () => {
    (queries.searchPlaces as any).mockResolvedValue({ results: [], error: "timeout" });
    (queries.searchEvents as any).mockResolvedValue({ results: [], error: "timeout" });
    const ai = vi.fn().mockRejectedValue(new Error("model down"));
    const res = await worker.fetch(chatRequest("jazz i København"), baseEnv(ai), executionContext());
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.reply.toLowerCase()).not.toContain("ingen resultater");
    expect(body.reply).toContain("kunne ikke søge");
    expect(body.retrieval_error).toBe(true);
    expect(body.degraded).toBe(true);
  });

  it("control: empty results without error still say 'ingen resultater'", async () => {
    (queries.searchPlaces as any).mockResolvedValue({ results: [] });
    (queries.searchEvents as any).mockResolvedValue({ results: [] });
    const ai = vi.fn().mockRejectedValue(new Error("model down"));
    const res = await worker.fetch(chatRequest("jazz i København"), baseEnv(ai), executionContext());
    const body: any = await res.json();
    expect(body.reply.toLowerCase()).toContain("ingen resultater");
    expect(body.retrieval_error).not.toBe(true);
  });
});
