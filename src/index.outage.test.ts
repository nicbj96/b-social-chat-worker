// Third-party outage — chaos coverage for the grounding safety net.
//
// The worker's contract is that a Workers-AI outage degrades to a grounded
// database answer rather than an error or an empty apology (index.ts:1120-1130:
// "ANY AI failure falls back"). The circuit breaker's own mechanics are unit-
// tested in discovery-fallback.test.ts; what was missing is proof that the
// REQUEST PATH actually routes to the fallback when the model throws. This test
// simulates the outage (env.AI.run rejects) and asserts the /chat response is a
// grounded, degraded reply carrying the DB row — not a 5xx.
import { describe, expect, it, vi, beforeEach } from "vitest";

// index.ts imports "cloudflare:workers"; stub it exactly as index.test.ts does.
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

// Known DB row the fallback should surface. Hoisted so the vi.mock factory
// (which is itself hoisted above imports) can close over it.
const { OUTAGE_EVENT } = vi.hoisted(() => ({
  OUTAGE_EVENT: { id: "evt-outage-1", title: "Jazzkoncert i Aalborg", location: "Studenterhuset", date: "2026-08-01" },
}));

// Replace only the DB-query surface the grounded fallback reads from, so the
// outage path runs with known data and no network. Other exports stay real.
vi.mock("./supabase-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supabase-queries")>()),
  createSupabaseClient: vi.fn(() => ({})),
  searchPlaces: vi.fn(async () => ({ results: [] })),
  searchEvents: vi.fn(async () => ({ results: [OUTAGE_EVENT] })),
  searchRoutes: vi.fn(async () => ({ results: [] })),
}));

import { searchEvents, searchPlaces } from "./supabase-queries";
import worker from "./index";
import { __resetAiBreaker } from "./discovery-fallback";

function executionContext(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
}
function environment(aiRun: (...args: any[]) => any) {
  return { AI: { run: aiRun }, SUPABASE_URL: "https://example.supabase.co", SUPABASE_KEY: "test-service-key" } as any;
}
function chatRequest(content: string): Request {
  return new Request("https://worker.example/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.77" },
    body: JSON.stringify({ messages: [{ role: "user", content }] }),
  });
}

describe("third-party outage — Workers AI down", () => {
  // Start each test with a CLOSED breaker so the model is actually attempted
  // (an already-open breaker would skip the call and never exercise the catch).
  beforeEach(() => __resetAiBreaker());

  it("an AI failure still returns a grounded, degraded DB answer — never a 5xx", async () => {
    const aiRun = vi.fn().mockRejectedValue(new Error("Workers AI 500 upstream"));
    const response = await worker.fetch!(chatRequest("koncerter i Aalborg?"), environment(aiRun), executionContext());

    // It tried the model — this is the AI-failure path, not a pre-AI early return.
    expect(aiRun).toHaveBeenCalled();
    // ...and degraded gracefully rather than surfacing the outage.
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.degraded).toBe(true); // took the direct-discovery fallback branch
    expect(body.event_ids).toContain("evt-outage-1"); // grounded in the mocked DB row
    expect(String(body.reply)).toContain("Jazzkoncert i Aalborg");
  });

  // Live golden-set 2026-08-22 (eval:chat vs SHA 5b6869f): these three
  // prompts returned HTTP 503 with the outage copy. isDiscoverySeekingMessage
  // is false for all three, so the outer catch skipped the DB fallback and
  // surfaced a 5xx. A parsed /chat turn must not do that.
  it("golden-set prompts that are not classified as discovery still do not 503 when AI is down", async () => {
    vi.mocked(searchEvents).mockResolvedValue({ results: [] });
    vi.mocked(searchPlaces).mockResolvedValue({ results: [] });
    const aiRun = vi.fn().mockRejectedValue(new Error("Workers AI 500 upstream"));
    const env = environment(aiRun);
    const prompts = [
      "Er der en Beyoncé-koncert i Skagen på tirsdag?",
      "Find quidditch-turneringer i Thisted i morgen",
      "Gem at jeg elsker jazz",
    ];
    for (const content of prompts) {
      const response = await worker.fetch!(chatRequest(content), env, executionContext());
      expect(response.status, content).toBe(200);
      const body: any = await response.json();
      expect(body.error, content).toBeUndefined();
      expect(Array.isArray(body.event_ids), content).toBe(true);
      expect(Array.isArray(body.place_ids), content).toBe(true);
      expect(String(body.reply || ""), content).not.toMatch(/har gemt|er gemt/i);
    }
  });

  it("malformed tool-call JSON must not 503 a valid /chat turn", async () => {
    // Live 503s were the OUTER catch: the model answered, then
    // JSON.parse(toolCall.function.arguments) threw, and
    // isDiscoverySeekingMessage was false so the catch skipped fallback.
    const aiRun = vi.fn().mockResolvedValue({
      response: "",
      tool_calls: [
        {
          id: "call_1",
          function: { name: "search_events", arguments: "{not-json" },
        },
      ],
    });
    const env = environment(aiRun);
    const response = await worker.fetch!(
      chatRequest("Er der en Beyoncé-koncert i Skagen på tirsdag?"),
      env,
      executionContext(),
    );
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.error).toBeUndefined();
    expect(Array.isArray(body.event_ids)).toBe(true);
    expect(Array.isArray(body.place_ids)).toBe(true);
  });
});
