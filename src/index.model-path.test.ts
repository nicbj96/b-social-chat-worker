import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import worker from "./index";
import { defaultSearchIntent } from "./discovery-contract";

// Plan §6 P163–166 (M38) + §7 P168–174 (M39) + §9 P186–190: the model path
// proposes validated intent changes, answers only from retrieved evidence,
// and stays inside the ≤2 model / 1 embedding start budget with honest caps.
const UUID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const currentIntent = { ...defaultSearchIntent(), query: "jazz", queryShareable: true, kind: "event" as const };

const eventRow = { id: UUID, title: "Verified jazz", price: 25, price_currency: "EUR", date: "2026-10-10T19:00:00Z" };
function netStub() {
  return vi.fn(async (url: string | URL) => {
    const u = String(url);
    if (u.includes("/rpc/match_events")) return Response.json([eventRow]);
    return Response.json([]);
  });
}
function aiStub(responses: any[], opts: { embedThrow?: boolean } = {}) {
  let i = 0;
  return { run: vi.fn(async (model: string) => {
    if (model.includes("bge-m3")) { if (opts.embedThrow) throw new Error("quota"); return { data: [[0.1, 0.2]] }; }
    return responses[i++] ?? { response: "Svar" };
  }) };
}
async function chat(env: any, body: unknown) {
  return worker.fetch!(new Request("https://worker.test/chat", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  }), env, { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as any);
}
function envWith(ai: any, net: ReturnType<typeof netStub>) {
  return { AI: ai, SUPABASE_URL: "https://example.test", SUPABASE_KEY: "test" } as any;
}
afterEach(() => vi.unstubAllGlobals());

describe("/chat model path — proposal, grounding, budget", () => {
  it("returns a validated intent_proposal for a model change without extra model calls beyond the budget", async () => {
    const net = netStub(); vi.stubGlobal("fetch", net);
    const ai = aiStub([
      { tool_calls: [{ id: "t1", function: { name: "propose_discovery_intent", arguments: JSON.stringify({ change: { kind: "place" } }) } }] },
      { response: "Her er forslaget." },
    ]);
    const res = await chat(envWith(ai, net), { messages: [{ role: "user", content: "vis steder i stedet for events" }], current_intent: currentIntent });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.intent_proposal).toMatchObject({
      version: 1,
      current: currentIntent,
      proposed: { ...currentIntent, kind: "place" },
    });
    expect(body.intent_proposal.changes.map((c: any) => c.field)).toEqual(["kind"]);
    expect(body.budget).toEqual({ model_calls: 2, embedding_calls: 0, caps: { model_calls: 2, embedding_calls: 1 } });
    expect(ai.run).toHaveBeenCalledTimes(2);
    expect(net).not.toHaveBeenCalled();
  });

  it("rejects Danish phrasing ('sted') without guessing and without a proposal envelope", async () => {
    const net = netStub(); vi.stubGlobal("fetch", net);
    const ai = aiStub([
      { tool_calls: [{ id: "t1", function: { name: "propose_discovery_intent", arguments: JSON.stringify({ change: { kind: "sted" } }) } }] },
      { response: "Forslaget var ugyldigt." },
    ]);
    const res = await chat(envWith(ai, net), { messages: [{ role: "user", content: "vis steder" }], current_intent: currentIntent });
    const body = await res.json() as any;
    expect(body.intent_proposal).toBeUndefined();
    expect(body.budget).toEqual({ model_calls: 2, embedding_calls: 0, caps: { model_calls: 2, embedding_calls: 1 } });
  });

  it("fills a city the model dropped from the reader's message before semantic_search", async () => {
    const net = netStub(); vi.stubGlobal("fetch", net);
    const ai = aiStub([
      { tool_calls: [{ id: "t1", function: { name: "semantic_search", arguments: JSON.stringify({ query: "jazz", kind: "events" }) } }] },
      { response: "Her er jazz." },
    ]);
    await chat(envWith(ai, net), { messages: [{ role: "user", content: "find jazz i København" }], current_intent: currentIntent });
    const rpc = net.mock.calls.find((c: any[]) => String(c[0]).includes("/rpc/match_events"));
    expect(rpc).toBeTruthy();
    const body = JSON.parse(String((rpc as any[])[1]?.body ?? "{}"));
    expect(body.filter_bbox_n).toBeTypeOf("number");
  });

  it("tops up a date-bounded semantic turn from the city+date search", async () => {
    const net = netStub(); vi.stubGlobal("fetch", net);
    const ai = aiStub([
      { tool_calls: [{ id: "t1", function: { name: "semantic_search", arguments: JSON.stringify({ query: "events", kind: "events", city: "Aarhus" }) } }] },
      { response: "Her er weekenden." },
    ]);
    await chat(envWith(ai, net), { messages: [{ role: "user", content: "hvad sker der i aarhus i weekenden" }], current_intent: currentIntent });
    const rest = net.mock.calls.map((c: any[]) => String(c[0])).filter((u: string) => u.includes("/rest/v1/events"));
    expect(rest.some((u: string) => u.includes("date=lt."))).toBe(true);
  });

  it("grounds the normal model reply: contradictory price corrected to the verified field with currency", async () => {
    const net = netStub(); vi.stubGlobal("fetch", net);
    const ai = aiStub([
      { tool_calls: [{ id: "t1", function: { name: "semantic_search", arguments: JSON.stringify({ query: "jazz", kind: "events" }) } }] },
      { response: "\"Verified jazz\" koster 250 kr. i døren." },
    ]);
    const res = await chat(envWith(ai, net), { messages: [{ role: "user", content: "find jazz" }], current_intent: currentIntent });
    const body = await res.json() as any;
    expect(body.event_ids).toEqual([UUID]);
    expect(body.reply).toMatch(/• Verified jazz — .* — 25 EUR/);
    expect(body.reply).not.toContain("i døren");
    expect(body.reply).not.toContain("250 kr");
    expect(body.reply).not.toBe(null);
    expect(body.budget).toEqual({ model_calls: 2, embedding_calls: 1, caps: { model_calls: 2, embedding_calls: 1 } });
  });

  it("a second embedding call is refused inside the budget with a named error, never a fake answer", async () => {
    const net = netStub(); vi.stubGlobal("fetch", net);
    const ai = aiStub([
      { tool_calls: [
        { id: "t1", function: { name: "semantic_search", arguments: JSON.stringify({ query: "jazz", kind: "events" }) } },
        { id: "t2", function: { name: "semantic_search", arguments: JSON.stringify({ query: "rock", kind: "events" }) } },
      ] },
      { response: "Fandt noget." },
    ]);
    const res = await chat(envWith(ai, net), { messages: [{ role: "user", content: "find jazz og rock" }], current_intent: currentIntent });
    const body = await res.json() as any;
    expect(body.event_ids).toEqual([UUID]);
    expect(net).toHaveBeenCalledTimes(1); // only the first embedding's RPC ran
    expect(ai.run).toHaveBeenCalledTimes(3); // 2 model + 1 embedding — never a 3rd model call or 2nd embedding
    expect(body.budget.embedding_calls).toBe(1);
  });

  it("a failed retrieval is an explicit error, never 'Ingen resultater' or null", async () => {
    const net = netStub(); vi.stubGlobal("fetch", net);
    const ai = aiStub([
      { tool_calls: [{ id: "t1", function: { name: "semantic_search", arguments: JSON.stringify({ query: "jazz", kind: "events" }) } }] },
      { response: "Ingen resultater." },
    ], { embedThrow: true });
    const res = await chat(envWith(ai, net), { messages: [{ role: "user", content: "find jazz" }], current_intent: currentIntent });
    const body = await res.json() as any;
    expect(body.reply).toContain("kunne ikke hente");
    expect(body.reply.toLowerCase()).not.toContain("ingen resultater");
  });
});
