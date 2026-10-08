import { describe, it, expect } from "vitest";
import { resolveTurnDiscovery, looksLikeEventListing } from "./discovery-fallback";
import { localizeSemanticRow, matchesTopic, idsByMention } from "./semantic-narrow";
import { buildGroundedSources, groundModelReply } from "./grounded-answer";

const now = new Date("2026-10-08T10:00:00Z");
describe("r13 audit fixes", () => {
  it("H2: follow-up inherits city/topic and replaces the date window", () => {
    const t = resolveTurnDiscovery(["what is on in copenhagen tonight", "og hvad med i morgen?"], undefined, now);
    expect(t.seeking).toBe(true);
    expect(t.followUp).toBe(true);
    expect(t.intent.city).toBe("København");
    expect(t.intent.dateWindow?.label).toBe("i morgen");
  });
  it("H2: a lone non-discovery message stays chit-chat", () => {
    expect(resolveTurnDiscovery(["hej, hvordan går det?"], undefined, now).seeking).toBe(false);
  });
  it("H2: a timed event listing without a tool call is detected", () => {
    expect(looksLikeEventListing("* The Black Madonna i The Jane kl. 20:00\n* The Black Madonna kl. 22:00")).toBe(true);
    expect(looksLikeEventListing("Hej! Jeg kan hjælpe med events og steder.")).toBe(false);
  });
  it("H1: semantic rows are localized to Danish wall time; raw kept for grounding", () => {
    const r: any = localizeSemanticRow({ id: "x", title: "FKJ", date: "2026-10-20T18:00:00+00:00" } as Record<string, any>);
    expect(r.date).toBe("tirsdag den 20. oktober 2026 kl. 20.00");
    expect(r.date_raw).toBe("2026-10-20T18:00:00+00:00");
  });
  it("H1: a UTC clock next to a named event is rejected even if another row has that time", () => {
    const s = buildGroundedSources([{ kind: "event", retrieved_at: "x", rows: [
      { id: "11111111-1111-4111-8111-111111111111", title: "Lis Sørensen og orkester koncert", date_raw: "2026-11-22T16:00:00+00:00" },
      { id: "22222222-2222-4222-8222-222222222222", title: "Anden ting", date_raw: "2026-11-22T15:00:00+00:00" },
    ] }]);
    expect(groundModelReply("* Lis Sørensen og orkester koncert den 22. november kl. 16.00", s, { lang: "da" }).grounding).toBe("corrected");
    expect(groundModelReply("* Lis Sørensen og orkester koncert den 22. november kl. 17.00", s, { lang: "da" }).grounding).toBe("verified");
  });
  it("M1: genre filter keeps only rows mentioning the genre", () => {
    expect(matchesTopic({ title: "NOLA JAZZ JAM" }, "jazz")).toBe(true);
    expect(matchesTopic({ title: "Deep Purple", description: "rock legends" }, "jazz")).toBe(false);
    expect(matchesTopic({ title: "X", interest_tags: ["jazz"] }, "jazz")).toBe(true);
  });
  it("M3: cards follow the prose", () => {
    const items = [{ id: "a", name: "Restaurant Kohalen" }, { id: "b", name: "Drivhuset" }, { id: "c", name: "Four Amigos" }];
    expect(idsByMention(items, "Prøv Drivhuset eller Four Amigos")).toEqual(["b", "c"]);
    expect(idsByMention(items, "Her er nogle steder")).toEqual(["a", "b", "c"]);
  });
});
