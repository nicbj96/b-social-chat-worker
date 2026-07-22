import { describe, expect, it } from "vitest";
import { inferDiscoveryIntent } from "./discovery-fallback";

const cityFor = (q: string) => inferDiscoveryIntent(q, undefined).city;

describe("a Danish place name must keep the answer in Denmark", () => {
  // Live on 2026-07-22 this returned a campsite in Chattogram, Bangladesh and
  // one in Tozeur, Tunisia, because "Nordjylland" matched no city and the
  // search then ran with no location filter at all.
  it("maps a region to its principal city rather than searching the planet", () => {
    expect(cityFor("vandreture i Nordjylland")).toBe("Aalborg");
    expect(cityFor("hvad sker der på Fyn")).toBe("Odense");
    expect(cityFor("koncerter på Sjælland")).toBe("København");
  });

  it.each([
    ["Skagen", "Skagen"], ["Roskilde", "Roskilde"], ["Esbjerg", "Esbjerg"],
    ["Helsingør", "Helsingør"], ["Næstved", "Næstved"], ["Silkeborg", "Silkeborg"],
    ["Frederiksberg", "Frederiksberg"],
  ])("recognises %s, which the 14-entry list did not", (query, expected) => {
    expect(cityFor(`ting at lave i ${query}`)).toBe(expected);
  });

  it("still resolves the aliases it always did", () => {
    expect(cityFor("hvad sker der i kbh")).toBe("København");
    expect(cityFor("events in Copenhagen")).toBe("København");
    expect(cityFor("koncerter i Århus")).toBe("Århus");
  });

  it("leaves a genuinely locationless query alone", () => {
    expect(cityFor("find noget sjovt at lave")).toBeUndefined();
  });
});
