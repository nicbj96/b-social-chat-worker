/**
 * A labelled set of things people actually ask the chat, with what a correct
 * reading of each looks like.
 *
 * This exists because on 2026-07-22 "vandreture i Nordjylland" answered with a
 * campsite in Bangladesh, and it had presumably been doing so for months. Unit
 * tests could not catch it: every individual rule was behaving exactly as
 * written. What was missing was anyone asking "does the whole thing still give
 * a sensible answer to a normal question?"
 *
 * Cases are deliberately written as INTENT expectations rather than expected
 * reply text. Reply wording changes with the model and the data; whether a
 * Danish question stays in Denmark does not.
 *
 * `city: null` means "no city should be inferred" -- an assertion in its own
 * right, because inventing a location is as wrong as losing one.
 */
export type GoldenCase = {
  /** What the user typed. */
  query: string;
  /** Expected city, or null when the query names no place. */
  city: string | null;
  /** Expected discovery kind, when the query clearly implies one. */
  kind?: "places" | "events" | "both";
  /** Why this case is in the set -- shown when it fails. */
  note: string;
};

export const GOLDEN_SET: GoldenCase[] = [
  // ── Regions. The Nordjylland failure and its neighbours. ──────────────────
  { query: "vandreture i Nordjylland", city: "Aalborg", note: "THE regression: answered with Chattogram, Bangladesh on 2026-07-22" },
  { query: "hvad sker der på Fyn", city: "Odense", note: "region, not a city" },
  { query: "koncerter på Sjælland", city: "København", note: "region, not a city" },
  { query: "ting at lave i Midtjylland", city: "Aarhus", note: "region, not a city" },

  // ── Cities the 14-entry list used to miss entirely. ───────────────────────
  { query: "ting at lave i Skagen", city: "Skagen", note: "fell through to a global search before 2026-07-22" },
  { query: "museer i Roskilde", city: "Roskilde", kind: "places", note: "fell through before" },
  { query: "restauranter i Esbjerg", city: "Esbjerg", kind: "places", note: "fell through before" },
  { query: "hvad sker der i Helsingør", city: "Helsingør", note: "fell through before" },
  { query: "cafeer i Silkeborg", city: "Silkeborg", kind: "places", note: "fell through before" },
  { query: "events i Frederiksberg", city: "Frederiksberg", kind: "events", note: "must not lose to a shorter substring of itself" },

  // ── Aliases and spellings that must keep working. ─────────────────────────
  { query: "hvad sker der i kbh", city: "København", note: "alias" },
  { query: "events in Copenhagen", city: "København", kind: "events", note: "English name folds to the Danish one" },
  { query: "koncerter i Århus", city: "Århus", note: "Å spelling" },
  { query: "koncerter i Aarhus", city: "Aarhus", note: "Aa spelling" },

  // ── No location named. Inventing one would be its own bug. ────────────────
  { query: "find noget sjovt at lave", city: null, note: "no place named -- must not invent one" },
  { query: "hvad kan du hjælpe med?", city: null, note: "meta question, no place" },
  { query: "jazz", city: null, kind: "events", note: "category only, no place" },

  // ── Kind detection. ───────────────────────────────────────────────────────
  { query: "gode restauranter i Odense", city: "Odense", kind: "places", note: "clearly places" },
  { query: "koncerter i Aalborg på lørdag", city: "Aalborg", kind: "events", note: "clearly events" },
  { query: "museer og events i Odense", city: "Odense", kind: "both", note: "both signals present" },
];

/** Score a run of the set. Returns per-case results plus totals. */
export function scoreGoldenSet(
  infer: (query: string) => { city?: string; kind: string },
): {
  total: number;
  passed: number;
  failures: { query: string; field: string; expected: unknown; got: unknown; note: string }[];
} {
  const failures: { query: string; field: string; expected: unknown; got: unknown; note: string }[] = [];
  for (const c of GOLDEN_SET) {
    const got = infer(c.query);
    const gotCity = got.city ?? null;
    if (gotCity !== c.city) {
      failures.push({ query: c.query, field: "city", expected: c.city, got: gotCity, note: c.note });
    }
    if (c.kind && got.kind !== c.kind) {
      failures.push({ query: c.query, field: "kind", expected: c.kind, got: got.kind, note: c.note });
    }
  }
  return { total: GOLDEN_SET.length, passed: GOLDEN_SET.length - failures.length, failures };
}
