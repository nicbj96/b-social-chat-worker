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

describe("directDiscoveryFallback — date + relaxation (audit #1)", () => {
  const KIDS = { id: "00000000-0000-4000-8000-0000000000c1", title: "Børneteater", location: "Aarhus", date: "2026-10-18" };

  it("'noget for børn på søndag i Aarhus' is answered, not 'kan ikke svare', and says what was loosened", async () => {
    (queries.searchPlaces as any).mockResolvedValue({ results: [] });
    const search = (queries.searchEvents as any);
    search.mockReset();
    search.mockImplementation(async (_s: unknown, args: any) =>
      args.date_from ? { results: [] } : { results: [KIDS] });
    const ai = vi.fn().mockRejectedValue(new Error("model down"));
    const res = await worker.fetch(chatRequest("noget for børn på søndag i Aarhus"), baseEnv(ai), executionContext());
    const body: any = await res.json();
    expect(body.reply).not.toContain("kan ikke svare");
    expect(body.reply).toContain("Børneteater");
    expect(body.reply).toContain("datoen");
    expect(body.event_ids).toEqual([KIDS.id]);
    // first call carried the Copenhagen window for Sunday
    expect(search.mock.calls[0][1].date_from).toMatch(/Z$/);
    expect(search.mock.calls[0][1].category).toBe("familie");
  });
});

describe("directDiscoveryFallback — weekend filter (audit #2)", () => {
  it("'jazz i Aarhus i weekenden' passes a Fri 17:00–Mon 00:00 window to the event query", async () => {
    const search = queries.searchEvents as any;
    search.mockReset();
    search.mockResolvedValue({ results: [{ id: "00000000-0000-4000-8000-0000000000d1", title: "Jazz", location: "Aarhus", date: "x" }] });
    (queries.searchPlaces as any).mockResolvedValue({ results: [] });
    const ai = vi.fn().mockRejectedValue(new Error("model down"));
    await worker.fetch(chatRequest("jazz i Aarhus i weekenden"), baseEnv(ai), executionContext());
    const args = search.mock.calls[0][1];
    expect(args.date_from).toBeTruthy();
    expect(args.date_to).toBeTruthy();
    const f = new Date(args.date_from), t = new Date(args.date_to);
    const cph = (d: Date) => new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", weekday: "short", hour: "2-digit", hourCycle: "h23" }).format(d);
    expect(cph(f)).toContain("Fri");
    expect(cph(f)).toContain("17");
    expect(cph(t)).toContain("Mon");
  });
});

describe("no-tool-call discovery turn is a good answer, not an outage", () => {
  it("returns catalogue results without degraded, keeps tool_calls_made for observability", async () => {
    (queries.searchPlaces as any).mockResolvedValue({ results: [] });
    (queries.searchEvents as any).mockReset();
    (queries.searchEvents as any).mockResolvedValue({ results: [DB_EVENT] });
    const ai = vi.fn().mockResolvedValue({ response: "Her er nogle forslag" });
    const res = await worker.fetch(chatRequest("jazz i København i weekenden"), baseEnv(ai), executionContext());
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.event_ids).toContain(DB_EVENT.id);
    expect(body.tool_calls_made).toEqual(["direct_discovery_fallback"]);
    expect(body.degraded).toBeUndefined();
  });
});
