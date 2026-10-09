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
    expect(seen.length).toBeGreaterThan(0);
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
    expect(r.reply).toContain("Jeg fandt ingen yoga-events i Aarhus");
    expect(r.reply).not.toContain("Mad & Comedy");
  });
  it("N4: fuzzy duplicate facts are not appended", () => {
    const src: any[] = [{ kind: "event", id: "1", verified_fields: { title: "Lørdagsrytmik 1-2 år", date: "2026-10-10T07:30:00Z", date_raw: "2026-10-10T07:30:00Z" } }, { kind: "event", id: "2", verified_fields: { title: "Real", date: "2026-10-10T09:00:00Z", date_raw: "2026-10-10T09:00:00Z" } }];
    const r = groundModelReply("Her er:\n* Lørdagsrytmik for 1-2 år kl. 9:30\n* Fake Event kl. 12:00", src as any, { lang: "da" });
    expect(r.grounding).toBe("corrected");
    expect((r.reply.match(/Lørdagsrytmik/g) || []).length).toBe(1);
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

import { inferResponseLanguage } from "./discovery-fallback";
describe("r21b", () => {
  it("English kids question is English", () => { expect(inferResponseLanguage("kids activities Aarhus Sunday")).toBe("en"); });
  it("empty result drops 'Her er nogle' intro", () => {
    const r = groundModelReply("Her er nogle jazz-events i København:\n\nIngen resultater fundet.", [], { lang: "da" });
    expect(r.reply).not.toMatch(/Her er nogle/);
  });
});

describe("r21c", () => {
  it("genre prefix in Danish compounds", () => {
    expect(rowIsGenre({ title: "BØLLE", description: "blander jazzmusikkens frihed" }, "jazz")).toBe(true);
    expect(rowIsGenre({ title: "Popular science" }, "pop")).toBe(false);
  });
});

describe("r21d", () => {
  it("bare bracket placeholder line removed", () => {
    expect(groundModelReply("Ingen resultater.\n\n[jazzklubber København]\n\nNoget andet?", [], { lang: "da" }).reply).not.toContain("[");
  });
});

describe("r22", () => {
  const n = new Date("2026-10-08T10:00:00Z");
  it("R22-2: 'hvad sker der dagen efter?' after an undated question = tomorrow", () => {
    const t = resolveTurnDiscovery(["jazz København", "hvad sker der dagen efter?"], undefined, n);
    expect(t.seeking).toBe(true);
    expect(t.intent.city).toBe("København");
    expect(t.intent.dateWindow?.label).toBe("i morgen");
  });
  it("R22-1: city-less relaxing carries country", async () => {
    const seen: any[] = [];
    await searchEventsRelaxing({ kind: "events", country: "DK", dateWindow: { from: "2026-10-08T15:00:00Z", to: "2026-10-08T22:00:00Z", label: "i aften" }, limit: 4 } as any, async (f) => { seen.push(f); return { results: [] }; });
    expect(seen.every((f) => f.country === "DK")).toBe(true);
  });
  it("R22-3: '* Ingen fundet' bullet replaced by verified rows", () => {
    const src: any[] = [{ kind: "event", id: "1", verified_fields: { title: "Børneteater", date: "2026-10-10T09:00:00Z", date_raw: "2026-10-10T09:00:00Z", price_amount: 0 } }];
    const r = groundModelReply("Her er et gratis event for børn i Aarhus:\n* Ingen fundet", src as any, { lang: "da" });
    expect(r.reply).not.toMatch(/Ingen fundet/);
    expect(r.reply).toContain("Børneteater");
  });
});

describe("r22b", () => {
  it("mid-chain category survives a city follow-up", () => {
    const t = resolveTurnDiscovery(["gratis i København i weekenden", "kun børn", "og i Aarhus?"], undefined, new Date("2026-10-08T10:00:00Z"));
    expect(t.intent.city).toBe("Aarhus");
    expect(t.intent.free).toBe(true);
    expect(t.intent.eventCategory).toBeTruthy();
  });
});

import { normalizeBullets } from "./grounded-answer";
describe("r22d N4", () => {
  it("one bullet style, no gaps inside lists, bold untouched", () => {
    expect(normalizeBullets("Her:\n\n* A\n\n• B\n- C\n\n**Fed** tekst")).toBe("Her:\n\n• A\n• B\n• C\n\n**Fed** tekst");
  });
});

import { topicWordHit } from "./discovery-fallback";
describe("r23", () => {
  it("'gratis events' is Danish", () => { expect(inferResponseLanguage("gratis events")).toBe("da"); });
  it("stand-up topic hit + synonyms", () => {
    expect(topicWordHit({ title: "Comedy night" }, "stand-up")).toBe(true);
    expect(topicWordHit({ title: "Vin & Vinyler" }, "stand-up")).toBe(false);
  });
});

import { honestEmptyReply } from "./discovery-fallback";
describe("r24", () => {
  it("empty answer names the right day from the window", () => {
    const t = resolveTurnDiscovery(["jazz København", "hvad sker der dagen efter?"], undefined, new Date("2026-10-08T10:00:00Z"));
    const r = honestEmptyReply(t.intent, "jazz", "da");
    expect(r).toContain("fredag den 9. oktober");
    expect(r).toContain("jazz-events i København");
    expect(r).not.toMatch(/lørdag/);
  });
  it("stand-up dagen efter = lørdag", () => {
    const t = resolveTurnDiscovery(["stand-up Aarhus i morgen", "og dagen efter?"], undefined, new Date("2026-10-08T10:00:00Z"));
    expect(honestEmptyReply(t.intent, null, "da")).toContain("stand-up-events i Aarhus lørdag den 10. oktober");
  });
});

import { looksUngroundedDiscoveryReply } from "./discovery-fallback";
describe("r24b", () => {
  it("foreign links are ungrounded", () => {
    expect(looksUngroundedDiscoveryReply("- [Meditation](https://www.bsocial.dk/search/events?category=meditation)")).toBe(true);
    expect(looksUngroundedDiscoveryReply("Se https://b-social.net/soeg")).toBe(false);
  });
  it("place topic hit uses name/tags", () => {
    expect(topicWordHit({ name: "Aarhus Teater", tags: ["kultur"] }, "teater")).toBe(true);
    expect(topicWordHit({ name: "Aarhus Zoologiske Have", tags: ["zoo"] }, "teater")).toBe(false);
  });
});

import { topicWordsOf } from "./discovery-fallback";
describe("r24c", () => {
  it("børneteater is a theatre topic", () => { expect(topicWordsOf("børneteater Aarhus")).toContain("børneteater"); });
  it("meditation tag tried first", async () => {
    const seen: any[] = [];
    await searchEventsRelaxing({ kind: "events", city: "København", topicWords: ["meditation"], limit: 4 } as any, async (f) => { seen.push(f); return { results: f.tags === "meditation" ? [{ id: "m" }] : [] }; });
    expect(seen[0].tags).toBe("meditation");
  });
});

describe("r24d", () => {
  it("børneteater excludes adult comedy tagged teater", () => {
    expect(topicWordsOf("børneteater Aarhus")).toEqual(["børneteater"]);
    expect(topicWordHit({ title: "Late Night Comedy", interest_tags: ["teater", "stand-up"] }, "børneteater")).toBe(false);
    expect(topicWordHit({ title: "Dukketeater: Rødhætte" }, "børneteater")).toBe(true);
  });
});

describe("r24e", () => {
  it("legepladser is a topic", () => { expect(topicWordsOf("legepladser i Odense")).toContain("legeplads"); });
});

describe("r24f", () => {
  it("place empty answer says places", () => {
    expect(honestEmptyReply({ kind: "places", city: "Odense", topicWords: ["legeplads"], limit: 4 } as any, null, "da")).toContain("steder med legeplads i Odense");
  });
});

describe("r24g", () => {
  it("topic rows only when some match", () => {
    const r = formatFallbackReply({ kind: "both", city: "København", topicWords: ["meditation"], limit: 4 } as any, [{ id: "p", name: "Supercykelsti", city: "København" } as any], [{ id: "e", title: "Meditation Session", location: "Østerbrohuset, København" } as any], "da", []);
    expect(r.reply).toContain("Meditation Session");
    expect(r.reply).not.toContain("Supercykelsti");
  });
});

import { topicTagList } from "./discovery-fallback";
describe("r25", () => {
  it("dans does not match dansk", () => {
    expect(topicWordHit({ title: "Forbudte stemmer", description: "en dansk aften" }, "dans")).toBe(false);
    expect(topicWordHit({ title: "Familiedans i Aarhus" }, "dans")).toBe(true);
  });
  it("comedy tags include stand-up", () => { expect(topicTagList(["comedy"])).toContain("stand-up"); });
  it("comedy hits stand-up row", () => { expect(topicWordHit({ title: "Ira Sylvester: Live Stand-Up Show", interest_tags: ["teater", "stand-up"] }, "comedy")).toBe(true); });
  it("markeder is a topic", () => { expect(topicWordsOf("markeder i weekenden")).toContain("marked"); });
  it("bar København and bare genre are discovery", () => {
    expect(isDiscoverySeekingMessage("bar København")).toBe(true);
    expect(isDiscoverySeekingMessage("techno")).toBe(true);
  });
  it("price follow-up sets priceAsked", () => {
    const t = resolveTurnDiscovery(["stand-up København i aften", "hvad koster billetterne?"], undefined, new Date("2026-10-08T10:00:00Z"));
    expect(t.intent.priceAsked).toBe(true);
  });
  it("relaxed date not labelled i aften", () => {
    const r = formatFallbackReply({ kind: "events", city: "København", topicWords: ["stand-up"], dateWindow: { from: "2026-10-08T15:00:00Z", to: "2026-10-08T22:00:00Z", label: "i aften" }, limit: 4 } as any, [], [{ id: "1", title: "Talentshow", location: "Knock Knock, København", date: "fredag" } as any], "da", ["date"] as any);
    expect(r.reply).not.toContain("(i aften)");
  });
  it("places empty uses human words", () => {
    expect(honestEmptyReply({ kind: "places", city: "København", queryTag: "mad_drikke", limit: 4 } as any, null, "da")).not.toContain("mad_drikke");
  });
});

describe("r25b", () => {
  it("café/bar topics", () => {
    expect(topicWordsOf("caféer i København")).toContain("café");
    expect(topicWordsOf("bar København")).toContain("bar");
    expect(topicWordsOf("Barcelona")).not.toContain("bar");
    expect(topicWordHit({ name: "Badekompagniet", tags: ["sauna"] }, "bar")).toBe(false);
    expect(topicWordHit({ name: "Restaurant Koefoed", tags: ["restaurant"] }, "café")).toBe(false);
  });
});

describe("r25c", () => {
  it("blanket restaurant tag set is not a café", () => {
    expect(topicWordHit({ name: "Morgenstedet", description: "restaurant in Copenhagen", tags: ["restaurant", "mad", "café", "bar"] }, "café")).toBe(false);
    expect(topicWordHit({ name: "Kaffebaren", tags: ["café"] }, "café")).toBe(true);
    expect(topicWordHit({ name: "Morgenstedet", tags: "restaurant, mad, café, bar" }, "bar")).toBe(false);
  });
});

import { placeNameNeedles } from "./discovery-fallback";
describe("r25d", () => { it("café name needles", () => { expect(placeNameNeedles(["café"])).toContain("kaffe"); }); });

import { placeTopicsOf } from "./discovery-fallback";
describe("r26", () => {
  it("Aalborg date question is Danish", () => { expect(inferResponseLanguage("events i Aalborg 20. oktober")).toBe("da"); expect(inferResponseLanguage("what's on in Aarhus tonight?")).toBe("en"); });
  it("film/biograf/weekend are discovery", () => {
    expect(isDiscoverySeekingMessage("film København")).toBe(true);
    expect(isDiscoverySeekingMessage("biograf København")).toBe(true);
    expect(isDiscoverySeekingMessage("hvad sker der i weekenden")).toBe(true);
  });
  it("techno is its own strict genre", () => {
    expect(namedGenre("techno")).toBe("techno");
    expect(rowIsGenre({ title: "Vin & Vinyler", description: "DJ spiller disco" }, "techno")).toBe(false);
  });
  it("place topics", () => { expect(placeTopicsOf(["museum København gratis"])).toEqual(["museum"]); expect(placeTopicsOf(["biograf København"])).toEqual(["biograf"]); });
});
describe("r26 text", () => {
  it("strips coords, headings and opening Men", () => {
    const r = normalizeBullets("Men her er noget:\n### Events\nlatitude: 55.68\n• A");
    expect(r).toBe("Her er noget:\nEvents:\n• A");
  });
});

describe("r26b", () => {
  it("date-only Danish question resolves to DK, no city, window", () => {
    const t = resolveTurnDiscovery(["hvad sker der i weekenden"], undefined, new Date("2026-10-09T10:00:00Z"));
    expect(t.seeking).toBe(true);
    expect(t.intent.city).toBeUndefined();
    expect(t.intent.dateWindow?.label).toBe("i weekenden");
  });
});

import { detailOrdinal, listedTitles, pickTitle } from "./detail-followup";
describe("r29 detail follow-up", () => {
  it("finds the ordinal", () => {
    expect(detailOrdinal("fortæl mig mere om den første")).toBe(0);
    expect(detailOrdinal("tell me more about the last one")).toBe(-1);
    expect(detailOrdinal("jazz København")).toBeNull();
  });
  it("reads titles from bullets and from a single-item reply", () => {
    expect(pickTitle(listedTitles("Her er nogle caféer i København:\n• Chillz Ice & Coffee\n• Kanal Caféen"), 0)).toBe("Chillz Ice & Coffee");
    expect(pickTitle(listedTitles("Her er nogle jazz-events:\n\n• BØLLE - koncert på Drop Inn lørdag den 10. oktober 2026 kl. 23.00"), 0)).toBe("BØLLE");
    expect(pickTitle(listedTitles("Her er et jazz-event i København:\nYoni Mayraz (UK) på KLEIN, København den 27. november kl. 20.30.\n\nVil du have flere?"), 0)).toBe("Yoni Mayraz");
  });
});

import { syncBulletsToItems } from "./card-sync";
import { citySearchNeedles } from "./supabase-queries";
describe("r30", () => {
  it("drops bullets for items that were never retrieved, and blanket claims", () => {
    const r = syncBulletsToItems("Her er nogle:\n• Guys and Dolls på Det Ny Teater, kl. 14.30\n• Pelles Fest, kl. 19.30\n\nBegge events er gratis og åbne for grupper. Vil du have mere?", [{ title: "Guys and Dolls" }]);
    expect(r).toContain("Guys and Dolls");
    expect(r).not.toContain("Pelles");
    expect(r).not.toContain("åbne for grupper");
    expect(r).toContain("Vil du have mere?");
  });
  it("keeps the reply when no bullet is recognisable", () => {
    expect(syncBulletsToItems("• X\n• Y", [{ title: "Helt andet" }])).toBe("• X\n• Y");
  });
  it("København includes its districts", () => { expect(citySearchNeedles("København")).toContain("Brønshøj"); });
});
import { idsNamedInReply } from "./card-sync";
describe("r30b", () => {
  it("cards follow bold and shortened titles", () => {
    const ids = idsNamedInReply([{ id: "a", title: "Ancestral Healing Workshop" }, { id: "b", title: "Akademisk litteratursøgning: Undervisning" }, { id: "c", title: "Andet" }], "• **Ancestral Healing Workshop** på X\n• **Akademisk litteratursøgning** på Y");
    expect(ids).toEqual(["a", "b"]);
  });
});
describe("r30c", () => {
  it("a generic title inside another bullet is not a card", () => {
    const ids = idsNamedInReply([{ id: "a", title: "Mosaik Workshop (begyndere)" }, { id: "g", title: "Workshop" }, { id: "j", title: "BØLLE" }], "• **Mosaik Workshop (begyndere/letøvede)** på Glad Sol\n• BØLLE - koncert på Drop Inn");
    expect(ids).toEqual(["a", "j"]);
  });
});
describe("r30d", () => {
  it("one card per title", () => {
    expect(idsNamedInReply([{ id: "a", title: "Mosaik Workshop" }, { id: "b", title: "Mosaik Workshop" }, { id: "c", title: "BØLLE" }], "• Mosaik Workshop på X\n• BØLLE på Y")).toEqual(["a", "c"]);
    expect(idsNamedInReply([{ id: "n1", title: "NOLA JAZZ JAM" }, { id: "b", title: "BØLLE" }, { id: "n2", title: "NOLA JAZZ JAM" }], "• BØLLE x\n• NOLA JAZZ JAM 13. okt\n• NOLA JAZZ JAM 10. nov")).toEqual(["b", "n1", "n2"]);
  });
});

import { titleCandidates } from "./detail-followup";
describe("r31", () => {
  it("detail lookup tries the title before ' - '", () => { expect(titleCandidates("Café Sorgenfri - en hyggelig café")).toContain("Café Sorgenfri"); });
  it("a bullet that names the full title mid-line gets its card", () => {
    expect(idsNamedInReply([{ id: "a", title: "Anders - Gadens Stemmer" }, { id: "f", title: "Familiedans" }], '• Lørdag den 10. oktober: "Anders - Gadens Stemmer" på Flakhaven\n• Familiedans — søn.', true)).toEqual(["a", "f"]);
  });
  it("strict: no bullet names an event → no event cards", () => {
    expect(idsNamedInReply([{ id: "e", title: "Halloween fest" }], "• Restaurant Koefoed\n• Alchemist", true)).toEqual([]);
  });
  it("inline coordinates are removed", () => {
    expect(normalizeBullets("Caféen ligger på adressen [latitude: 55.67, longitude: 12.57] i København.")).toBe("Caféen ligger i København.");
  });
});

describe("r32", () => {
  it("festival is a topic: concerts are not festivals", () => {
    expect(topicWordHit({ title: "Deep Purple", interest_tags: ["musik", "koncert"] }, "festival")).toBe(false);
    expect(topicWordHit({ title: "Aarhus Festuge 2027" }, "festival")).toBe(true);
  });
});

import { placeBulletsNameOnly } from "./card-sync";
describe("r33", () => {
  it("reggaeton is not electronic", () => { expect(rowIsGenre({ title: "REGGAETON x", description: "DJ spiller brasiliansk funk, pop og latin hits" }, "elektronisk")).toBe(false); });
  it("place bullets keep the catalogue name only", () => {
    expect(placeBulletsNameOnly("Her:\n• **Era Ora**: lækre retter\n• Café Sonja - hyggelig", [{ name: "Era Ora" }, { name: "Café Sonja" }])).toBe("Her:\n• Era Ora\n• Café Sonja");
  });
  it("prose item becomes a bullet; empty-colon line and festival claim go", () => {
    const r = syncBulletsToItems("Late Mic finder sted i Citizen kl. 23.00.\n\nAlle shows er en del af UP Comedy Festival 2026 og koster 135 kr.\n• Sebastian Dorset: Dyrenes konge — 135 DKK\n\nDu kan købe billetter på følgende links:\n\nVil du have mere?", [{ title: "Late Mic" }, { title: "Sebastian Dorset: Dyrenes konge" }]);
    expect(r).toContain("• Late Mic");
    expect(r).not.toContain("UP Comedy");
    expect(r).not.toContain("følgende links");
    expect(r).toContain("Vil du have mere?");
  });
});
describe("r33b", () => {
  it("prose items already listed are not duplicated", () => {
    const r = syncBulletsToItems("• Anders Morgenstierne har premiere på Citizen kl. 21.\n\n• Late Mic finder sted kl. 23.\n\n• Sebastian Dorset: Dyrenes konge — fre. 9. okt. kl. 18:45\n• Anders Morgenstierne: ONE SCOOP OF VANILLA — fre. 9. okt. kl. 21:00", [{ title: "Late Mic" }, { title: "Sebastian Dorset: Dyrenes konge" }, { title: "Anders Morgenstierne: ONE SCOOP OF VANILLA" }]);
    expect(r.split("\n").filter((l) => l.startsWith("•")).length).toBe(3);
    expect(r).toContain("Late Mic");
  });
});
