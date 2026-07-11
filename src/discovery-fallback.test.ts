import { describe, expect, it } from "vitest";
import { formatFallbackReply, inferDiscoveryIntent, isAiQuotaError } from "./discovery-fallback";

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
    );
    expect(response.reply).toContain("Bangsbo hundeskov — Frederikshavn");
    expect(response.reply).toContain("Strandby hundeskov — Frederikshavn");
    expect(response.place_ids).toEqual(["p1", "p2"]);
    expect(response.event_ids).toEqual([]);
    expect(response.degraded).toBe(true);
  });

  it("is honest when a scoped search returns nothing", () => {
    const response = formatFallbackReply(inferDiscoveryIntent("events i Malmö"), [], []);
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
    );
    expect(response.reply.match(/Odense Zoo/g)).toHaveLength(1);
    expect(response.place_ids).toEqual(["p1"]);
  });
});

describe("isAiQuotaError", () => {
  it("recognizes Cloudflare Workers AI allocation exhaustion", () => {
    expect(isAiQuotaError(new Error("4006: used up your daily free allocation of 10,000 neurons"))).toBe(true);
    expect(isAiQuotaError(new Error("ordinary upstream failure"))).toBe(false);
  });
});
