import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import worker from "./index";
import { __resetAiBreaker } from "./discovery-fallback";

beforeEach(() => __resetAiBreaker());
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
let ip = 0;

async function rsvpTurn(status: "going" | "interested" | "not_going", outcome: "ok" | "error" | "throw" = "ok") {
  const writes: any[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/auth/v1/user") return Response.json({ id: "fixture-user" });
    if (url.pathname === "/rest/v1/event_rsvps") {
      writes.push(JSON.parse(String(init?.body)));
      if (outcome === "throw") throw new Error("offline");
      return new Response(outcome === "error" ? "write failed" : null, { status: outcome === "error" ? 500 : 204 });
    }
    return Response.json([]);
  }));
  let toolResult: any, instructions: any;
  const run = vi.fn(async (_model: string, payload: any) => {
    const tool = payload.messages.find((message: any) => message.role === "tool");
    if (tool) {
      toolResult = JSON.parse(tool.content);
      return { response: toolResult.message || toolResult.error || "Du er tilmeldt." };
    }
    instructions = JSON.parse(JSON.stringify(payload));
    return { tool_calls: [{ id: "rsvp", function: { name: "rsvp_event", arguments: JSON.stringify({ event_id: "event-1", status }) } }] };
  });
  const response = await worker.fetch!(new Request("https://worker.example/chat", {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer fixture-jwt", "CF-Connecting-IP": `198.51.100.${++ip}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "Markér min deltagelse" }] }),
  }), { AI: { run }, SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_KEY: "test-key" } as any,
  { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext);
  expect(response.status).toBe(200);
  return { result: toolResult, body: await response.json() as any, writes, instructions };
}

describe("RSVP wording through the actual /chat caller", () => {
  it.each(["going", "interested", "not_going"] as const)("%s is only a participation marker, never a ticket/reservation", async (status) => {
    const { result, body, writes, instructions } = await rsvpTurn(status);
    expect(writes).toEqual([{ user_id: "fixture-user", event_id: "event-1", status }]);
    expect(result).toMatchObject({ ok: true, event_id: "event-1", status, action: "participation_marker" });
    expect(result.message).toContain("deltagelsesmarkering");
    expect(result.message).toContain("ikke billetkøb eller reservation");
    expect(body.reply).toContain(result.message);
    const definition = instructions.tools.find((tool: any) => tool.function.name === "rsvp_event").function.description;
    expect(definition).toContain("deltagelsesmarkering");
    expect(definition).not.toContain("'reservér plads'");
    expect(instructions.messages[0].content).toContain("ikke billetkøb eller reservation");
    expect(instructions.messages[0].content).not.toContain('"reservér plads" →');
  });

  it.each(["error", "throw"] as const)("%s does not describe failure as event registration", async (outcome) => {
    const { result, body } = await rsvpTurn("going", outcome);
    expect(result.ok).not.toBe(true);
    expect(result.error).toBe("Kunne ikke gemme deltagelsesmarkering");
    expect(body.reply).not.toMatch(/tilmelde|tilmeldt|reserveret|købt/i);
  });
});
