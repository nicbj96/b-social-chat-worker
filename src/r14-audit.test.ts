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

import { groundModelReply } from "./grounded-answer";
describe("negated free statement", () => {
  it("'ingen gratis events' is kept; 'er gratis' still needs evidence", () => {
    expect(groundModelReply("Der er desværre ingen gratis events i Aalborg denne uge.", [], { lang: "da" }).grounding).toBe("verified");
    expect(groundModelReply("Koncerten er gratis.", [], { lang: "da" }).grounding).toBe("corrected");
  });
});

import { resolveDateWindow } from "./date-window";
import { danishWhen } from "./semantic-narrow";
describe("r15 audit fixes", () => {
  const now2 = new Date("2026-10-08T10:00:00Z");
  it("N1: date from the middle of a follow-up chain is kept", () => {
    const t = resolveTurnDiscovery(["what's on in copenhagen tonight", "and tomorrow?", "only free ones"], undefined, now2);
    expect(t.intent.free).toBe(true);
    expect(t.intent.dateWindow?.label).toBe("i morgen");
  });
  it("N2: explicit dates are windows and survive 'kun gratis'", () => {
    expect(resolveDateWindow("events i aalborg den 15. oktober", now2)?.label).toBe("15. oktober");
    expect(resolveDateWindow("concerts on october 15", now2)?.label).toBe("15. oktober");
    expect(resolveDateWindow("noget d. 3/11", now2)?.label).toBe("3. november");
    expect(resolveDateWindow("1. januar", now2)?.from.startsWith("2026-12-31T23")).toBe(true);
    const t = resolveTurnDiscovery(["events i aalborg den 15. oktober", "kun gratis"], undefined, now2);
    expect(t.intent.dateWindow?.label).toBe("15. oktober");
  });
  it("N3: UTC-midnight sentinel is not rendered as 02:00", () => {
    expect(danishWhen("2026-10-10T00:00:00+00:00")).toContain("tidspunkt ukendt");
    expect(danishWhen("2026-10-10T18:00:00+00:00")).toContain("kl. 20.00");
  });
});

describe("L-B: outro after corrected bullets", () => {
  it("closing question moves below the verified list", () => {
    const src: any[] = [{ kind: "event", id: "e1", verified_fields: { title: "Real Gig", date: "2026-10-10T18:00:00Z", date_raw: "2026-10-10T18:00:00Z", price_amount: 100, currency: "DKK" } }];
    const r = groundModelReply("Here is live music in Aarhus:\n\n* Fake Band at 23:00\n\nWould you like more information about any of these events?", src as any, { lang: "en" });
    expect(r.grounding).toBe("corrected");
    const lines = r.reply.split("\n").filter(Boolean);
    expect(lines[lines.length - 1]).toMatch(/Would you like more information/);
    expect(r.reply.indexOf("Real Gig")).toBeLessThan(r.reply.indexOf("Would you like"));
  });
});

describe("r16 M1: bullet titles with full stops", () => {
  it("a bullet with a dotted title is one claim and survives intact", () => {
    const src: any[] = [{ kind: "event", id: "e1", verified_fields: { title: "AI & Digital Confidence. Futurists stronger together. // Networking - Career Club DK", date: "2026-10-08T15:30:00Z", date_raw: "2026-10-08T15:30:00Z" } }];
    const text = "Here is one:\n\n* **AI & Digital Confidence. Futurists stronger together. // Networking - Career Club DK** at Spaces, København, 5:30 PM\n\nWant more?";
    const r = groundModelReply(text, src as any, { lang: "en" });
    expect(r.reply).toContain("Futurists stronger together");
    expect(r.reply).not.toMatch(/\*\*AI & Digital Confidence\.\s*$/m);
  });
});
