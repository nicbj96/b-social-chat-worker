import { describe, expect, it } from "vitest";
import {
  claimsEmptyDiscovery,
  formatFallbackReply,
  inferDiscoveryIntent,
  inferResponseLanguage,
  isAiQuotaError,
  isDiscoverySeekingMessage,
  looksUngroundedDiscoveryReply,
  repairContradictoryGroundedReply,
} from "./discovery-fallback";

describe("inferResponseLanguage", () => {
  it("recognizes English discovery requests and defaults ambiguous text to Danish", () => {
    expect(inferResponseLanguage("Find events in Copenhagen this weekend")).toBe("en");
    expect(inferResponseLanguage("Find events i København denne weekend")).toBe("da");
    expect(inferResponseLanguage("ok")).toBe("da");
  });
});

describe("inferDiscoveryIntent", () => {
  it("infers a bounded nearby nature-place search", () => {
    expect(inferDiscoveryIntent("Find 2 natursteder nær Frederikshavn.")).toEqual({
      kind: "places",
      city: "Frederikshavn",
      placeCategory: "natur-outdoor",
      queryTag: "natur",
      limit: 2,
    });
  });

  it("keeps Malmö and Aarhus requests geographically scoped", () => {
    expect(inferDiscoveryIntent("steder i Malmö").city).toBe("Malmö");
    expect(inferDiscoveryIntent("jazz i Aarhus i weekenden")).toMatchObject({
      kind: "events",
      city: "Aarhus",
      eventCategory: "musik",
      queryTag: "jazz",
    });
  });

  it("uses context city only when the message names no city", () => {
    const intent = inferDiscoveryIntent("find familieaktiviteter", "Odense");
    expect(intent.city).toBe("Odense");
    expect(intent.kind).toBe("events");
  });
});

describe("formatFallbackReply", () => {
  it("mentions only returned rows and emits matching structured IDs", () => {
    const response = formatFallbackReply(
      inferDiscoveryIntent("Find 2 natursteder nær Frederikshavn."),
      [{ id: "p1", name: "Bangsbo hundeskov", city: "Frederikshavn" }, { id: "p2", name: "Strandby hundeskov", city: "Frederikshavn" }],
      [],
      "da",
    );
    expect(response.reply).toContain("Bangsbo hundeskov — Frederikshavn");
    expect(response.reply).toContain("Strandby hundeskov — Frederikshavn");
    expect(response.place_ids).toEqual(["p1", "p2"]);
    expect(response.event_ids).toEqual([]);
    expect(response.degraded).toBe(true);
  });

  it("is honest when a scoped search returns nothing", () => {
    const response = formatFallbackReply(inferDiscoveryIntent("events i Malmö"), [], [], "da");
    expect(response.reply).toContain("ingen resultater");
    expect(response.place_ids).toEqual([]);
    expect(response.event_ids).toEqual([]);
  });

  it("deduplicates equivalent venue names before returning IDs", () => {
    const response = formatFallbackReply(
      inferDiscoveryIntent("Find familiesteder i Odense"),
      [
        { id: "p1", name: "Odense Zoo", city: "Odense Municipality" },
        { id: "p2", name: "Odense Zoo", city: "Odense Municipality" },
      ],
      [],
      "da",
    );
    expect(response.reply.match(/Odense Zoo/g)).toHaveLength(1);
    expect(response.place_ids).toEqual(["p1"]);
  });

  it("renders English fallback copy for English requests", () => {
    const response = formatFallbackReply(
      inferDiscoveryIntent("Show me places in Copenhagen"),
      [{ id: "p1", name: "The Lakes" }],
      [],
      "en",
    );
    expect(response.reply).toContain("Here are results directly from B-Social");
    expect(response.reply).toContain("city not specified");
    expect(response.reply).not.toContain("Her er resultater");
    expect(response.reply).not.toContain("by ikke angivet");
  });

  it("renders English empty-result copy with an English city preposition", () => {
    const response = formatFallbackReply(
      inferDiscoveryIntent("Show events in Copenhagen"),
      [],
      [],
      "en",
    );
    expect(response.reply).toBe("I found no results in København with the selected filters.");
  });
});

describe("isDiscoverySeekingMessage / ungrounded replies", () => {
  it("detects discovery asks including KBH aliases", () => {
    expect(isDiscoverySeekingMessage("Find jazz i København")).toBe(true);
    expect(isDiscoverySeekingMessage("Find jazz i KBH")).toBe(true);
    expect(isDiscoverySeekingMessage("hej")).toBe(false);
  });

  it("flags invented placeholder discovery prose", () => {
    expect(looksUngroundedDiscoveryReply("Her er hvad jeg fandt:\n(search result)")).toBe(true);
    expect(looksUngroundedDiscoveryReply("Her er resultater direkte fra B-Social:\n• Real Event — CPH")).toBe(false);
  });

  it("maps KBH/Cph to København for discovery intent", () => {
    expect(inferDiscoveryIntent("Find jazz i KBH").city).toBe("København");
    expect(inferDiscoveryIntent("events in Cph").city).toBe("København");
  });
});

describe("isAiQuotaError", () => {
  it("recognizes Cloudflare Workers AI allocation exhaustion", () => {
    expect(isAiQuotaError(new Error("4006: used up your daily free allocation of 10,000 neurons"))).toBe(true);
    expect(isAiQuotaError(new Error("ordinary upstream failure"))).toBe(false);
  });
});

describe("repairContradictoryGroundedReply", () => {
  it("rewrites empty-claim prose when structured event rows exist", () => {
      const reply = "Jeg kunne desværre ikke finde nogle koncerter i København denne uge.";
      expect(claimsEmptyDiscovery(reply)).toBe(true);
      const fixed = repairContradictoryGroundedReply(
        reply,
        [],
        [{ id: "e1", title: "Jazz på Blågårds Plads", location: "København", date: "2026-07-18" }],
        "da",
      );
      expect(fixed).toContain("Jazz på Blågårds Plads");
      expect(fixed).not.toMatch(/desværre ikke finde/i);
    });

    it("rewrites 'fandt ingen jazz-events' / 'fandt ikke' empty claims", () => {
      expect(claimsEmptyDiscovery("Jeg fandt ikke nogle jazz-events i København lige nu.")).toBe(true);
      const fixed = repairContradictoryGroundedReply(
        "Jeg fandt ingen jazz-events i København (KBH).",
        [],
        [{ id: "e1", title: "Jazz Night", location: "København" }],
        "da",
      );
      expect(fixed).toContain("Jazz Night");
    });

  it("leaves honest replies alone when tools found nothing", () => {
    const reply = "Jeg fandt ingen events i aften.";
    expect(repairContradictoryGroundedReply(reply, [], [], "da")).toBe(reply);
  });

  it("leaves grounded non-empty replies alone", () => {
    const reply = "Her er Jazz på Blågårds Plads i aften.";
    expect(
      repairContradictoryGroundedReply(
        reply,
        [],
        [{ id: "e1", title: "Jazz på Blågårds Plads", location: "København" }],
        "da",
      ),
    ).toBe(reply);
  });
});
