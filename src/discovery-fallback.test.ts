import { describe, expect, it } from "vitest";
import {
  claimsEmptyDiscovery,
  looksLikeRawToolCall,
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

describe("raw tool call leaking into the reply", () => {
  // Found by the golden-set eval (script/eval-chat.mjs) on 2026-07-22: asked
  // about a Beyoncé concert that does not exist, the model answered with the
  // literal string `semantic_search(query="Beyoncé koncert Skagen tirsdag",
  // kind="events", city="Skagen")`. The user saw machine internals, and the
  // discovery never ran.
  it("detects a tool call written as prose", () => {
    expect(looksLikeRawToolCall('semantic_search(query="Beyoncé koncert Skagen", kind="events")')).toBe(true);
    expect(looksLikeRawToolCall("search_places(city='Aarhus')")).toBe(true);
    expect(looksLikeRawToolCall('{"name": "search_events", "arguments": {}}')).toBe(true);
  });

  it("does not flag a normal answer that merely names something", () => {
    expect(looksLikeRawToolCall("Der er ingen Beyoncé-koncert i Skagen på tirsdag.")).toBe(false);
    expect(looksLikeRawToolCall("Her er hvad jeg fandt: • Jazz i Aalborg — 14/8")).toBe(false);
    expect(looksLikeRawToolCall("")).toBe(false);
  });

  it("routes such a reply into the grounded fallback", () => {
    expect(looksUngroundedDiscoveryReply('semantic_search(query="x")')).toBe(true);
  });
});

describe("inferResponseLanguage — ordinary phrasing, not just the happy case", () => {
  // The first version scored 12 English words against 12 Danish ones and let
  // Danish win every tie including 0–0. Measured, it answered 8 of these 10
  // English messages in Danish.
  const english = [
    "hi",
    "hello, can you help me?",
    "I want to go dancing",
    "any good jazz concerts?",
    "something fun for kids",
    "restaurants in Aarhus",
    "what's happening tomorrow",
    "give me ideas for saturday",
    "is there anything free",
    "Find events in Copenhagen this weekend",
  ];
  for (const m of english) {
    it(`answers in English: ${m}`, () => {
      expect(inferResponseLanguage(m)).toBe("en");
    });
  }

  const danish = [
    "Hvad sker der i weekenden",
    "find jazz i københavn",
    "vis mig noget sjovt",
    "er der noget for børn",
    "hvor kan jeg spise i aarhus",
    "hej, kan du hjælpe mig?",
  ];
  for (const m of danish) {
    it(`answers in Danish: ${m}`, () => {
      expect(inferResponseLanguage(m)).toBe("da");
    });
  }

  it("defaults an ambiguous message to Danish on a Danish-first product", () => {
    expect(inferResponseLanguage("ok")).toBe("da");
    expect(inferResponseLanguage("")).toBe("da");
    expect(inferResponseLanguage("jazz")).toBe("da");
  });

  it("treats Danish letters as decisive even among English words", () => {
    // "the" and "is" are English, but æ/ø/å are not.
    expect(inferResponseLanguage("is there noget i københavn")).toBe("da");
  });
});

// ---------------------------------------------------------------------------
// Danish plurals must reach their category.
// ---------------------------------------------------------------------------
// The music rule used a closing \b where every other rule used \w*, so
// "koncerter" -- the natural plural, and far more common than the singular --
// matched nothing and the reply came back with no category filter at all.
// Verified live before the fix: "koncerter i København" returned a meditation
// session and a running club, correctly located and entirely wrong.
describe("category rules survive Danish inflection", () => {
  // Asserts that SOME category was inferred, on whichever axis the query is
  // about. inferDiscoveryIntent deliberately sets eventCategory only for
  // event-seeking questions and placeCategory only for place-seeking ones, so
  // pinning the wrong field tests the router rather than the inflection.
  const cases = [
    "koncerter i København",
    "koncert i Aarhus",
    "musikken i byen",
    "festivaler til sommer",
    "museer i Roskilde",
    "udstillinger",
    "løbeklubber",
    "restauranter",
  ];
  for (const q of cases) {
    it(`"${q}" reaches a category`, () => {
      const intent = inferDiscoveryIntent(q);
      expect(
        intent.eventCategory ?? intent.placeCategory,
        `"${q}" matched no category rule — a Danish inflection is falling through`,
      ).toBeTruthy();
    });
  }

  it("maps concert plurals to music specifically, not just to something", () => {
    // The actual regression: "koncerter" must reach MUSIC, not merely match.
    const i = inferDiscoveryIntent("koncerter i København");
    expect(i.eventCategory ?? i.placeCategory).toContain("musik");
  });

  it("does not invent a category for an unrelated question", () => {
    // The rule must not become so loose that everything matches something.
    expect(inferDiscoveryIntent("hvad kan man lave i weekenden").eventCategory).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// A rule's tag must not be narrower than its category unless that tag is real.
// ---------------------------------------------------------------------------
// index.ts prefers a SPECIFIC tag over the category, so a tag no event carries
// silently empties the answer. Measured 2026-07-22 on live data: the tags
// "musik", "mad", "motion", "natur" and "familie" are carried by ZERO events,
// while "jazz" (77) and "kunst" (2.005) are real. The music rule used
// tag: "jazz", so every music question became a jazz question -- 0 results in
// København against 279 real music events.
describe("category rules do not route through empty tags", () => {
  const generalQueries = [
    "koncerter i København",
    "restauranter i Aarhus",
    "løbeklubber i Odense",
  ];
  for (const q of generalQueries) {
    it(`"${q}" routes to its category, not a narrower tag`, () => {
      const i = inferDiscoveryIntent(q);
      const cat = i.eventCategory ?? i.placeCategory;
      expect(cat).toBeTruthy();
      // Equal means index.ts uses the CATEGORY. Different means it uses the tag,
      // which is only safe when that tag is genuinely populated.
      if (i.queryTag && i.eventCategory) {
        expect(i.queryTag).toBe(i.eventCategory);
      }
    });
  }

  it("still honours an explicitly narrow request", () => {
    // "jazz" is real (77 events), so asking for it by name should use it.
    expect(inferDiscoveryIntent("jazz i København").queryTag).toBe("jazz");
  });
});

describe("shared words must not decide the language", () => {
  it("answers a Danish question in Danish even when it starts with 'Find'", () => {
    // "find" is the Danish imperative of "finde" as well as an English verb.
    // Counting it as English answered "Find quidditch-turneringer i Thisted"
    // in English, live, on 2026-07-22.
    expect(inferResponseLanguage("Find quidditch-turneringer i Thisted i morgen")).toBe("da");
    expect(inferResponseLanguage("Find koncerter i Aarhus")).toBe("da");
  });

  it("still detects genuinely English questions", () => {
    expect(inferResponseLanguage("what is happening this weekend?")).toBe("en");
    expect(inferResponseLanguage("show me something good nearby")).toBe("en");
  });
});

describe("towns that exist must not fall through to a global search", () => {
  for (const town of ["Thisted", "Holbæk", "Kalundborg", "Fredericia", "Rønne"]) {
    it(`${town} is recognised as a city`, () => {
      expect(inferDiscoveryIntent(`hvad sker der i ${town}`).city).toBe(town);
    });
  }
});

describe("a substitution is labelled as one", () => {
  const place = { id: "p1", name: "Thisted Hundeskov", city: "Thisted" };

  it("says it found no events when it shows only places for an event question", () => {
    const r = formatFallbackReply(
      { kind: "events", city: "Thisted", limit: 4 },
      [place], [], "da",
    );
    expect(r.reply).toMatch(/ingen events/i);
    expect(r.reply).not.toMatch(/^Her er resultater/);
  });

  it("uses the plain intro when it actually found events", () => {
    const r = formatFallbackReply(
      { kind: "events", city: "Aarhus", limit: 4 },
      [], [{ id: "e1", title: "Koncert", location: "Aarhus" }], "da",
    );
    expect(r.reply).toMatch(/^Her er resultater/);
  });

  it("does not label a places question as a substitution", () => {
    // Asking for places and getting places is not a substitution.
    const r = formatFallbackReply({ kind: "places", city: "Thisted", limit: 4 }, [place], [], "da");
    expect(r.reply).toMatch(/^Her er resultater/);
  });

  it("labels in English too", () => {
    const r = formatFallbackReply({ kind: "events", city: "Thisted", limit: 4 }, [place], [], "en");
    expect(r.reply).toMatch(/no events/i);
  });
});

describe("a town name must not look like a place signal", () => {
  it("Thisted is a town, not the word 'sted'", () => {
    // "sted" matched inside THIsted, so every Thisted question became a places
    // search. "koncerter i Thisted" asked for events and got parks.
    expect(inferDiscoveryIntent("koncerter i Thisted").kind).toBe("events");
  });

  it("Ringsted too", () => {
    expect(inferDiscoveryIntent("events i Ringsted").kind).toBe("events");
  });

  it("but the actual word still signals places", () => {
    expect(inferDiscoveryIntent("gode steder i Aarhus").kind).toBe("places");
    expect(inferDiscoveryIntent("restauranter i Odense").kind).toBe("places");
  });


});

describe("Danish compounds vs Danish town names", () => {
  it("routes town questions by what was asked, not by the town's name", () => {
    // "sted" lives inside THIsted and RINGsted. Unboundaried, every question
    // about either town became a places search.
    expect(inferDiscoveryIntent("koncerter i Thisted").kind).toBe("events");
    expect(inferDiscoveryIntent("events i Ringsted").kind).toBe("events");
  });

  it("still treats real compound place words as places", () => {
    // Adding \b alone fixed the towns and broke these, which are ordinary
    // Danish. No town ends in -steder, which is what separates them.
    for (const q of ["natursteder nær Frederikshavn", "spisesteder i Odense", "gode steder i Aarhus"]) {
      expect(inferDiscoveryIntent(q).kind, q).toBe("places");
    }
  });
});

describe("an event word added one at a time", () => {
  it("routes a tournament question to events", () => {
    expect(inferDiscoveryIntent("quidditch-turneringer i Thisted").kind).toBe("events");
  });

  it("leaves every place query exactly as it was", () => {
    // The batch widening that was reverted broke all of these.
    for (const q of ["gode steder i Aarhus", "restauranter i Odense", "natursteder nær Frederikshavn", "museer i Roskilde"]) {
      expect(inferDiscoveryIntent(q).kind, q).toBe("places");
    }
  });
});
