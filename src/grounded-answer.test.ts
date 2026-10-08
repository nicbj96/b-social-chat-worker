import { describe, expect, it } from "vitest";
import { buildGroundedSources, groundModelReply, renderGroundedFacts, type GroundedSource } from "./grounded-answer";

// Plan §7 P168–174 + M39: facts render only from evidence+sources; wrong or
// contradictory model text is corrected or flagged; failed retrieval is an
// error, never "no results"; retrieved_at is not the upstream update time.
const src = (patch: Partial<GroundedSource> & Record<string, unknown> = {}): GroundedSource => ({
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "event",
  url: "/event/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  verified_fields: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", title: "Verified jazz", price: 25, price_currency: "EUR", date: "2026-10-10T19:00:00Z", status: "scheduled" },
  retrieved_at: "2026-10-04T12:00:00Z", source_updated_at: null, ...patch,
});

describe("buildGroundedSources — evidence with distinct timestamps", () => {
  it("keeps retrieved_at and upstream source_updated_at as separate fields, provenance labelled", () => {
    const [s] = buildGroundedSources([{ kind: "event", retrieved_at: "2026-10-04T12:00:00Z", rows: [{ ...src().verified_fields, catalog_updated_at: "2026-10-01T12:00:00Z" }] }]);
    expect(s.retrieved_at).toBe("2026-10-04T12:00:00Z");
    expect(s.source_updated_at).toBe("2026-10-01T12:00:00Z");
    expect(s.url).toBe("/event/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
  });
  it("derives the internal URL per entity kind and keeps verified fields only", () => {
    const rows = buildGroundedSources([{ kind: "place", retrieved_at: "2026-10-04T12:00:00Z", rows: [{ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "Verified park" }] }]);
    expect(rows[0].url).toBe("/sted/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
    expect(rows[0].kind).toBe("place");
  });
});

describe("groundModelReply — adversarial model text", () => {
  const sources = [src()];

  it("lets an honest reply that matches evidence through with flags empty", () => {
    const out = groundModelReply("Jeg fandt \"Verified jazz\" den 10. oktober.", sources, { lang: "da" });
    expect(out.grounding).toBe("verified");
    expect(out.corrections).toEqual([]);
    expect(out.reply).toBe("Jeg fandt \"Verified jazz\" den 10. oktober.");
  });

  it("removes an invented entity sentence and flags it — model language cannot add facts", () => {
    const out = groundModelReply(
      "Jeg fandt \"Verified jazz\" og \"Mystisk kvægsalve-koncert\" med gratis champagne på Klub XYZ.",
      sources, { lang: "da" });
    expect(out.grounding).toBe("corrected");
    expect(out.corrections.length).toBeGreaterThan(0);
    expect(out.reply).toContain("Verified jazz");
    expect(out.reply).not.toContain("Mystisk kvægsalve-koncert");
    expect(out.reply).not.toContain("champagne");
  });

  it("corrects a contradictory price to the verified field with currency — no currency-free facts", () => {
    const out = groundModelReply(
      "\"Verified jazz\" koster 250 kr. i døren.", sources, { lang: "da" });
    expect(out.grounding).toBe("corrected");
    expect(out.reply).not.toContain("250 kr");
    expect(out.reply).toContain("25 EUR");
  });

  it("never presents a currency-free price as a fact", () => {
    const out = groundModelReply("Det er gratis at komme ind.", sources, { lang: "da" });
    expect(out.grounding).toBe("corrected");
    expect(out.reply.toLowerCase()).not.toContain("gratis");
    expect(out.reply).toContain("25 EUR");
  });

  it("rejects a currency-free numeric price claim", () => {
    const out = groundModelReply("Billetten koster 25.", sources, { lang: "da" });
    expect(out.grounding).toBe("corrected");
    expect(out.corrections.some(c => c.includes("price_without_verified_field"))).toBe(true);
  });

  it("flags a model time that contradicts the evidence instead of passing it", () => {
    const out = groundModelReply("\"Verified jazz\" klokken 07:00 om morgenen.", sources, { lang: "da" });
    expect(out.grounding === "corrected" || out.grounding === "flagged").toBe(true);
    expect(out.reply).toContain("21:00"); // evidence time, rendered in Europe/Copenhagen (19:00Z)
    expect(out.corrections.length).toBeGreaterThan(0);
  });

  it("a failed retrieval is an explicit error, never an empty/null answer or 'Ingen resultater'", () => {
    const out = groundModelReply("Der var ingen resultater.", [], { lang: "da", retrievalError: "discovery_unavailable" });
    expect(out.grounding).toBe("error");
    expect(out.corrections).toEqual([]);
    expect(out.reply).toContain("kunne ikke hente");
    expect(out.reply.toLowerCase()).not.toContain("ingen resultater");
  });

  it("renders facts deterministically from verified fields only (EN mirror)", () => {
    const da = renderGroundedFacts(sources, "da");
    expect(da.join("\n")).toContain("Verified jazz — 25 EUR");
    const en = renderGroundedFacts(sources, "en");
    expect(en.join("\n")).toContain("Verified jazz — 25 EUR");
    const unknown = renderGroundedFacts([src({ verified_fields: { id: src().id, title: "X" } })], "da");
    expect(unknown.join("\n")).toContain("Pris ukendt");
  });

  it("keeps retrieved_at distinct from source_updated_at when rendering provenance", () => {
    const known = renderGroundedFacts([src({ source_updated_at: "2026-10-01T12:00:00Z" })], "da");
    expect(known.join("\n")).toContain("2026-10-01T12:00:00Z");
    expect(known.join("\n")).toContain("2026-10-04T12:00:00Z");
    const unknown = renderGroundedFacts(sources, "da");
    expect(unknown.join("\n")).toContain("Kildens opdateringstid er ukendt");
  });

  it("correction prose has no provenance tail or 'Pris ukendt' noise", () => {
    const out = groundModelReply("Billetten koster 25.", [src({ verified_fields: { id: src().id, title: "X" } })], { lang: "da" });
    expect(out.grounding).toBe("corrected");
    expect(out.reply).toContain("• X");
    expect(out.reply).not.toContain("Hentet:");
    expect(out.reply).not.toContain("opdateringstid");
    expect(out.reply).not.toContain("Pris ukendt");
  });
});

describe("groundModelReply — Danish date/time prose", () => {
  const ev = (id: string, title: string, date: string): GroundedSource => ({
    id, kind: "event", url: `/event/${id}`, verified_fields: { id, title, date }, retrieved_at: "2026-10-04T12:00:00Z", source_updated_at: null,
  });
  const srcs = [
    ev("11111111-1111-4111-8111-111111111111", "BØLLE", "2026-10-10T21:00:00Z"),
    ev("22222222-2222-4222-8222-222222222222", "NOLA JAZZ JAM", "2026-10-13T20:00:00Z"),
  ];
  it("keeps a correct local-time multi-event list intact (no mid-date splits)", () => {
    const text = "Her er nogle jazzkoncerter:\n\n* BØLLE på Drop inn den 10. oktober kl. 23.00 - popjazz.\n* NOLA JAZZ JAM den 13. oktober kl. 22.00 - New Orleans.";
    const out = groundModelReply(text, srcs, { lang: "da" });
    expect(out.grounding).toBe("verified");
    expect(out.reply).toBe(text);
  });
  it("drops only the wrong line and keeps the rest readable", () => {
    const text = "Her er nogle jazzkoncerter:\n* BØLLE den 10. oktober kl. 23.00.\n* NOLA JAZZ JAM den 13. oktober kl. 07.00.";
    const out = groundModelReply(text, srcs, { lang: "da" });
    expect(out.grounding).toBe("corrected");
    expect(out.reply).toContain("* BØLLE den 10. oktober kl. 23.00.");
    expect(out.reply).not.toContain("kl. 07.00");
    expect(out.reply).not.toMatch(/den 10\.\noktober/);
  });
});

describe("grounding against search_events display rows", () => {
  const row = { id: "33333333-3333-4333-8333-333333333333", title: "Vin & Vinyler", date: "lørdag den 10. oktober 2026 kl. 22.00", date_raw: "2026-10-10T20:00:00+00:00", price: "Pris ukendt", price_amount: null, currency: null };
  const free = { id: "44444444-4444-4444-8444-444444444444", title: "DANS - FREE YOUR FEET", date: "x", date_raw: "2026-10-25T14:00:00+00:00", price: "100 DKK", price_amount: 100, currency: "DKK" };
  const sources = buildGroundedSources([{ kind: "event", retrieved_at: "2026-10-08T00:00:00Z", rows: [row, free] }]);
  it("accepts the correct Danish wall time from date_raw", () => {
    const out = groundModelReply("* Vin & Vinyler på Bellis lørdag den 10. oktober kl. 22.00 - god vin 🍷", sources, { lang: "da" });
    expect(out.grounding).toBe("verified");
  });
  it("a title containing FREE is not a free-price claim", () => {
    const out = groundModelReply("* DANS - FREE YOUR FEET søndag den 25. oktober kl. 15.00", sources, { lang: "da" });
    expect(out.grounding).toBe("verified");
  });
  it("still rejects a gratis claim and a wrong time", () => {
    expect(groundModelReply("DANS - FREE YOUR FEET er gratis.", sources, { lang: "da" }).grounding).toBe("corrected");
    expect(groundModelReply("Vin & Vinyler kl. 07.00.", sources, { lang: "da" }).grounding).toBe("corrected");
  });
  it("uses the numeric price with currency from the raw fields", () => {
    expect(sources[1].verified_fields.price).toBe(100);
    expect(sources[1].verified_fields.price_currency).toBe("DKK");
    expect(sources[0].verified_fields.price).toBeUndefined();
  });
});
