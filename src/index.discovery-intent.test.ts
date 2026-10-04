import { describe, expect, it, vi } from "vitest";
vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import worker from "./index";
import fixtures from "./discovery-contract.fixtures.json";

describe("/chat explicit discovery_intent boundary", () => {
  for (const fixture of fixtures) it(fixture.name, async () => {
    const run = vi.fn(async () => ({response:"Hej"}));
    const response = await worker.fetch!(new Request("https://worker.test/chat", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({messages:[{role:"user",content:"hej"}], discovery_intent:fixture.intent}),
    }), {AI:{run}, SUPABASE_URL:"https://example.test", SUPABASE_KEY:"test"} as any,
    {waitUntil:vi.fn(),passThroughOnException:vi.fn(),props:{}} as any);
    expect(response.status).toBe(fixture.valid ? 422 : 400);
    const body = await response.json() as any;
    expect(body.error).toBe(fixture.valid ? "unsupported_discovery_intent" : "invalid_discovery_intent");
    expect(run).not.toHaveBeenCalled();
  });
});
