import { describe, it, expect } from "vitest";
import { resolveTurnDiscovery, looksLikeUngroundedFact, searchEventsRelaxing } from "./discovery-fallback";
const now = new Date("2026-10-08T10:00:00Z");
describe("r14 audit fixes", () => {
  it("H-B: 'kun gratis ting' follow-up is a discovery turn with the free filter", () => {
    const t = resolveTurnDiscovery(["hvad sker der i aarhus i weekenden", "kun gratis ting"], undefined, now);
    expect(t.seeking).toBe(true);
    expect(t.intent.free).toBe(true);
    expect(t.intent.city).toBe("Aarhus");
  });
  it("M-B: free sticks when the follow-up only changes city", () => {
    const t = resolveTurnDiscovery(["er der noget gratis i odense i denne uge", "hvad med i Aalborg?"], undefined, now);
    expect(t.intent.city).toBe("Aalborg");
    expect(t.intent.free).toBe(true);
  });
  it("H-B: price follow-up is discovery-grounded", () => {
    expect(resolveTurnDiscovery(["jazz i københavn", "hvad koster det?"], undefined, now).seeking).toBe(true);
  });
  it("H-B: tool-less price/free claims are flagged", () => {
    expect(looksLikeUngroundedFact("Campusfest UCL er gratis!")).toBe(true);
    expect(looksLikeUngroundedFact("Billetten koster 100 kr.")).toBe(true);
    expect(looksLikeUngroundedFact("Hej! Hvordan kan jeg hjælpe?")).toBe(false);
  });
  it("free filter is carried into every relaxing step", async () => {
    const seen: any[] = [];
    await searchEventsRelaxing({ kind: "events", city: "Odense", free: true, queryTag: "jazz", eventCategory: "musik", limit: 4 }, async (f) => { seen.push(f); return { results: [] }; });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.every((f) => f.free === true)).toBe(true);
  });
});
