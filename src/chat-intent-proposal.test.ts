import { describe, expect, it } from "vitest";
import { defaultSearchIntent, parseSearchIntent, searchIntentKey, type SearchIntent } from "./discovery-contract";
import { proposeIntentChange, INTENT_PROPOSAL_VERSION } from "./chat-intent-proposal";

// Plan §6 P163–166 + M38: full model-derived intent proposal — every change
// field validated against the shared SearchIntent contract; invalid/unknown
// fields and DA/EN phrasing are rejected, never guessed; identical proposals
// are idempotent (no_change), repeats yield the same proposalId.
const current = (): SearchIntent =>
  parseSearchIntent({ ...defaultSearchIntent(), query: "jazz", queryShareable: true, kind: "event" });

describe("proposeIntentChange — validated model change", () => {
  it("proposes a validated date+price change and diffs only the changed fields", () => {
    const out = proposeIntentChange(current(), {
      date: { from: "2026-10-10T00:00:00Z", to: "2026-10-12T00:00:00Z", timezone: "Europe/Copenhagen" },
      price: { mode: "range", min: 0, max: 200, currency: "DKK", unknown: "exclude" },
    });
    if (!out.accepted) throw new Error("expected acceptance, got " + JSON.stringify(out));
    expect(out.proposal.version).toBe(INTENT_PROPOSAL_VERSION);
    expect(searchIntentKey(out.proposal.current)).toBe(searchIntentKey(current()));
    expect(searchIntentKey(out.proposal.proposed)).toBe(
      searchIntentKey(parseSearchIntent({ ...current(),
        date: { from: "2026-10-10T00:00:00Z", to: "2026-10-12T00:00:00Z", timezone: "Europe/Copenhagen" },
        price: { mode: "range", min: 0, max: 200, currency: "DKK", unknown: "exclude" } })));
    const fields = out.proposal.changes.map(c => c.field).sort();
    expect(fields).toEqual(["date", "price"]);
    for (const c of out.proposal.changes) {
      expect(c.label.da.length).toBeGreaterThan(0);
      expect(c.label.en.length).toBeGreaterThan(0);
    }
  });

  it("proposes tags and geography country changes", () => {
    const out = proposeIntentChange(current(), {
      tags: { selected: ["loeb", "maraton"] },
      geography: { kind: "country", country: "DK" },
    });
    if (!out.accepted) throw new Error("expected acceptance");
    expect(out.proposal.proposed.tags!.selected).toEqual(["loeb", "maraton"]);
    expect(out.proposal.proposed.geography).toEqual({ kind: "country", country: "DK" });
  });

  it("redacts private GPS coordinates from the shown diff while proposing the exact radius", () => {
    const withGps = parseSearchIntent({ ...current(),
      geography: { kind: "radius", lat: 57.123456, lng: 9.123456, radiusKm: 15, source: "gps", shareable: false } });
    const out = proposeIntentChange(withGps, { query: "mtb" });
    if (!out.accepted) throw new Error("expected acceptance");
    const shown = JSON.stringify(out.proposal.changes);
    expect(shown).not.toContain("57.123456");
    expect(out.proposal.proposed.geography).toEqual(withGps.geography);
  });

  it("rejects kind in Danish/English phrasing — validated values only, no guessing", () => {
    for (const phrasing of ["sted", "places", "venue", "events", "begge"]) {
      const out = proposeIntentChange(current(), { kind: phrasing });
      expect(out.accepted, phrasing).toBe(false);
      if (!out.accepted) expect(out.reason).toBe("invalid_proposed_intent");
    }
  });

  it("rejects unknown fields instead of guessing their meaning", () => {
    const out = proposeIntentChange(current(), { city: "Aarhus" });
    expect(out.accepted).toBe(false);
    if (!out.accepted) { expect(out.reason).toBe("unknown_fields"); expect(out.invalid_fields).toEqual(["city"]); }
  });

  it("rejects a non-ISO currency alias like 'kr' — no guessed expansion", () => {
    const out = proposeIntentChange(current(), {
      price: { mode: "range", min: 0, max: 100, currency: "kr", unknown: "exclude" } });
    expect(out.accepted).toBe(false);
  });

  it("rejects partial price and date objects — full validated shapes only", () => {
    expect(proposeIntentChange(current(), { price: { min: 50 } }).accepted).toBe(false);
    expect(proposeIntentChange(current(), { date: { from: "2026-10-10" } }).accepted).toBe(false);
    expect(proposeIntentChange(current(), { date: { from: "not-a-time", to: "2026-10-12T00:00:00Z", timezone: "Europe/Copenhagen" } }).accepted).toBe(false);
  });

  it("rejects invalid sort/date ordering and radius limits through the shared contract", () => {
    expect(proposeIntentChange(current(), {
      geography: { kind: "radius", lat: 0, lng: 0, radiusKm: 99999, source: "manual", shareable: true } }).accepted).toBe(false);
    expect(proposeIntentChange(current(), { sort: "distance" }).accepted).toBe(false); // not radius geography
    expect(proposeIntentChange(current(), {
      date: { from: "2026-10-12T00:00:00Z", to: "2026-10-10T00:00:00Z", timezone: "Europe/Copenhagen" } }).accepted).toBe(false);
  });

  it("is idempotent: proposing the unchanged intent is no_change and repeats give the same proposalId", () => {
    expect(proposeIntentChange(current(), {}).accepted).toBe(false);
    const a = proposeIntentChange(current(), { kind: "place" });
    const b = proposeIntentChange(current(), { kind: "place" });
    expect(a.accepted && b.accepted).toBe(true);
    if (a.accepted && b.accepted) expect(a.proposal.proposalId).toBe(b.proposal.proposalId);
  });

  it("rejects a malformed current intent and non-object input fail-closed", () => {
    expect(proposeIntentChange({ version: 9 }, { kind: "place" }).accepted).toBe(false);
    expect(proposeIntentChange(current(), "weekend i Aarhus").accepted).toBe(false);
    expect(proposeIntentChange(current(), null).accepted).toBe(false);
  });
});
