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

describe("r16 L2n: tool-loop narration", () => {
  it("'Let me try searching again.' never reaches the reader", () => {
    const r = groundModelReply("I found no kids events.\nLet me try searching again.\nWant something else?", [], { lang: "en" });
    expect(r.reply).not.toMatch(/Let me try/i);
    expect(r.reply).toContain("I found no kids events.");
  });
});

import { formatFallbackReply } from "./discovery-fallback";
describe("r17", () => {
  it("M2: relaxed free fallback says it is still free and labels rows", () => {
    const r = formatFallbackReply({ kind: "events", city: "Odense", free: true, eventCategory: "musik", dateWindow: { from: "a", to: "b", label: "i weekenden" }, limit: 4 } as any, [], [{ id: "1", title: "X", location: "Odense", date: "27. okt" } as any], "da", ["date"]);
    expect(r.reply).toContain("gratis");
    expect(r.reply).toContain("stadig kun gratis");
    expect(r.reply).toContain("— Gratis");
  });
  it("L2n: mid-line narration removed", () => {
    const r = groundModelReply("No kids events found. Let me try searching again. Want something else?", [], { lang: "en" });
    expect(r.reply).not.toMatch(/Let me try/i);
  });
});

describe("r18", () => {
  const n = new Date("2026-10-08T10:00:00Z");
  it("M-1: 'kun musik' keeps city, weekend and free from the chain", () => {
    const t = resolveTurnDiscovery(["gratis koncerter i København i weekenden", "hvad med Aarhus?", "kun musik"], undefined, n);
    expect(t.seeking).toBe(true);
    expect(t.intent.city).toBe("Aarhus");
    expect(t.intent.free).toBe(true);
    expect(t.intent.dateWindow?.label).toBe("i weekenden");
    expect(t.intent.eventCategory).toBe("musik");
  });
  it("M-2: English reference follow-ups keep context", () => {
    for (const q of ["which one is cheapest?", "tell me more about the first one"]) {
      const t = resolveTurnDiscovery(["something for kids in Aarhus this weekend", q], undefined, n);
      expect(t.seeking).toBe(true);
      expect(t.intent.city).toBe("Aarhus");
    }
  });
});

describe("r18c", () => {
  it("'Let me try to search again.' removed", () => {
    expect(groundModelReply("Nothing found. Let me try to search again.", [], { lang: "en" }).reply).not.toMatch(/Let me/i);
  });
});

describe("r19", () => {
  it("N7: yoga with no yoga rows says so", () => {
    const r = formatFallbackReply({ kind: "events", city: "Aarhus", topicWords: ["yoga"], limit: 4 } as any, [], [{ id: "1", title: "Mad & Comedy", location: "Aarhus" } as any], "da", []);
    expect(r.reply).toContain('Jeg fandt ikke noget med "yoga"');
  });
  it("N4: fuzzy duplicate facts are not appended", () => {
    const src: any[] = [{ kind: "event", id: "1", verified_fields: { title: "Lørdagsrytmik 1-2 år", date: "2026-10-10T07:30:00Z", date_raw: "2026-10-10T07:30:00Z" } }, { kind: "event", id: "2", verified_fields: { title: "Real", date: "2026-10-10T09:00:00Z", date_raw: "2026-10-10T09:00:00Z" } }];
    const r = groundModelReply("Her er:\n* Lørdagsrytmik for 1-2 år kl. 9:30\n* Fake Event kl. 12:00", src as any, { lang: "da" });
    expect(r.grounding).toBe("corrected");
    expect(r.reply).not.toMatch(/• Lørdagsrytmik/);
  });
});

import { isDiscoverySeekingMessage } from "./discovery-fallback";
describe("r19b", () => {
  const n = new Date("2026-10-08T10:00:00Z");
  it("R19-2: 'og søndag?' after a city-less kids question is Sunday", () => {
    expect(isDiscoverySeekingMessage("børnearrangementer lørdag")).toBe(true);
    const t = resolveTurnDiscovery(["børnearrangementer lørdag", "og søndag?"], undefined, n);
    expect(t.seeking).toBe(true);
    expect(t.intent.dateWindow?.label).toMatch(/søndag/);
  });
});

import { searchEvents } from "./supabase-queries";
describe("r19c", () => {
  it("country filter reaches the query", async () => {
    const urls: string[] = [];
    const sb: any = { from: () => { const q: any = new Proxy({}, { get: (_t, k) => k === "then" ? (r: any) => r({ data: [], error: null }) : (...a: any[]) => { urls.push(`${String(k)}:${a.join(",")}`); return q; } }); return q; } };
    await searchEvents(sb, { country: "DK" } as any);
    expect(urls.some(u => u === "eq:country,DK")).toBe(true);
  });
});

describe("r20", () => {
  const n = new Date("2026-10-08T10:00:00Z");
  it("R20-1: 'og dagen efter?' keeps city/free and shifts the window", () => {
    const a = resolveTurnDiscovery(["gratis i København i morgen"], undefined, n).intent.dateWindow!;
    const t = resolveTurnDiscovery(["gratis i København i morgen", "og dagen efter?"], undefined, n);
    expect(t.seeking).toBe(true);
    expect(t.intent.city).toBe("København");
    expect(t.intent.free).toBe(true);
    expect(Date.parse(t.intent.dateWindow!.from) - Date.parse(a.from)).toBe(86_400_000);
  });
  it("R20-2: 'kun jazz' narrows to jazz", () => {
    const t = resolveTurnDiscovery(["gratis koncerter i København", "kun jazz"], undefined, n);
    expect(t.intent.queryTag).toBe("jazz");
    expect(t.intent.free).toBe(true);
  });
});

import { namedGenre, rowIsGenre, inferDiscoveryIntent } from "./discovery-fallback";
describe("r21", () => {
  const n = new Date("2026-10-08T10:00:00Z");
  it("R21-2: English kids Sunday is a dated kids discovery turn", () => {
    expect(isDiscoverySeekingMessage("kids activities Aarhus Sunday")).toBe(true);
    const i = inferDiscoveryIntent("kids activities Aarhus Sunday", undefined, n);
    expect(i.city).toBe("Aarhus");
    expect(i.dateWindow?.label).toBe("søndag");
    expect(i.eventCategory).toBe("familie");
  });
  it("R21-3: genre gate", () => {
    expect(namedGenre("elektronisk musik København")).toBe("elektronisk");
    expect(rowIsGenre({ title: "Sonic Ritual", description: "stoner doom" }, "elektronisk")).toBe(false);
    expect(rowIsGenre({ title: "Techno night", description: "" }, "elektronisk")).toBe(true);
    expect(rowIsGenre({ title: "Hip-hop jam" }, "hiphop")).toBe(true);
  });
  it("R21-1: placeholder removed", () => {
    expect(groundModelReply("Ingen jazz-events. [jazz_steder København]", [], { lang: "da" }).reply).not.toContain("[");
  });
});
