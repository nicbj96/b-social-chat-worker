import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import worker from "./index";
import fixtures from "./discovery-contract.fixtures.json";

afterEach(()=>vi.unstubAllGlobals());
describe("/chat explicit discovery_intent boundary", () => {
  for (const fixture of fixtures) it(fixture.name, async () => {
    const run = vi.fn(async () => ({response:"Hej"}));
    const net=vi.fn(async()=>Response.json({items:[],status:'complete',consistency:'live-keyset',hasMore:false,nextCursor:null,retrievedAt:'2026-10-04T12:00:00Z'}));
    vi.stubGlobal('fetch',net);
    const response = await worker.fetch!(new Request("https://worker.test/chat", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({messages:[{role:"user",content:"hej"}], discovery_intent:fixture.intent}),
    }), {AI:{run}, SUPABASE_URL:"https://example.test", SUPABASE_KEY:"test"} as any,
    {waitUntil:vi.fn(),passThroughOnException:vi.fn(),props:{}} as any);
    const region=fixture.intent.geography.kind==='region';
    expect(response.status).toBe(fixture.valid ? region?422:200 : 400);
    const body = await response.json() as any;
    expect(body.error).toBe(fixture.valid ? region?'unsupported_region_metadata':undefined : 'invalid_discovery_intent');
    expect(net).toHaveBeenCalledTimes(fixture.valid && !region?1:0);
    expect(run).not.toHaveBeenCalled();
  });
});
