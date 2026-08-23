// ---------------------------------------------------------------------------
// category-vocabulary.ts — map whatever the model says to what the data uses
// ---------------------------------------------------------------------------
// MEASURED FAILURE (2026-07-22): the assistant's tool schema and system prompt
// advertised a category vocabulary that no longer exists in the database —
// places were described as "natur, aktiv_sport, mad_hangout" and events as
// "sport, musik, festival, kunst, comedy…", while the real values are the
// tag-tree slugs (natur-outdoor, mad-drikke, kultur-kunst, musik-lyd,
// motion-fitness, børn-familie, …). Every category-filtered search therefore
// returned ZERO rows: "places to eat in Aarhus" found nothing although 557
// Aarhus places exist.
//
// Two things fix that, and both are needed:
//   1. Tell the model the truth (see tools.ts / system-prompt.ts).
//   2. Never trust it anyway. An LLM will keep emitting "musik", "concert" or
//      "food" no matter what the schema says, so every category argument passes
//      through here first. Unknown input returns null = "do not filter", which
//      degrades to a broader search instead of an empty one — an unfiltered
//      answer is recoverable, an empty one is not.
// ---------------------------------------------------------------------------

/** The real top-level slugs, verified against production data 2026-07-22. */
export const REAL_CATEGORY_SLUGS = [
  "musik-lyd",
  "kultur-kunst",
  "natur-outdoor",
  "mad-drikke",
  "motion-fitness",
  "sport-tilskuer",
  "social-hobby",
  "sundhed-wellness",
  "børn-familie",
  "rejser-eventyr",
  "gaming-tech",
  "mode-skønhed",
  "dyr-natur",
  "motor-køretøjer",
  "film-medier",
] as const;

export type CategorySlug = (typeof REAL_CATEGORY_SLUGS)[number];

/** Loose word (any language, any legacy spelling) → real slug. */
const ALIASES: Record<string, CategorySlug> = {
  // legacy vocabulary this worker used to advertise
  aktiv_sport: "motion-fitness",
  "aktiv-sport": "motion-fitness",
  mad_hangout: "mad-drikke",
  "mad-hangout": "mad-drikke",
  mad_drikke: "mad-drikke",
  natur: "natur-outdoor",
  friluftsliv: "natur-outdoor",
  outdoor: "natur-outdoor",
  // music
  musik: "musik-lyd",
  music: "musik-lyd",
  koncert: "musik-lyd",
  concert: "musik-lyd",
  concerts: "musik-lyd",
  livemusik: "musik-lyd",
  festival: "musik-lyd",
  // culture
  kunst: "kultur-kunst",
  art: "kultur-kunst",
  kultur: "kultur-kunst",
  culture: "kultur-kunst",
  museum: "kultur-kunst",
  museums: "kultur-kunst",
  teater: "kultur-kunst",
  theatre: "kultur-kunst",
  theater: "kultur-kunst",
  comedy: "kultur-kunst",
  "stand-up": "kultur-kunst",
  foredrag: "kultur-kunst",
  udstilling: "kultur-kunst",
  exhibition: "kultur-kunst",
  // food
  mad: "mad-drikke",
  food: "mad-drikke",
  eat: "mad-drikke",
  restaurant: "mad-drikke",
  restaurants: "mad-drikke",
  spise: "mad-drikke",
  spisested: "mad-drikke",
  spisesteder: "mad-drikke",
  cafe: "mad-drikke",
  "café": "mad-drikke",
  drinks: "mad-drikke",
  bar: "mad-drikke",
  // fitness / sport
  sport: "motion-fitness",
  sports: "motion-fitness",
  fitness: "motion-fitness",
  træning: "motion-fitness",
  traening: "motion-fitness",
  løb: "motion-fitness",
  lob: "motion-fitness",
  run: "motion-fitness",
  running: "motion-fitness",
  yoga: "sundhed-wellness",
  wellness: "sundhed-wellness",
  // spectator sport
  fodbold: "sport-tilskuer",
  football: "sport-tilskuer",
  kamp: "sport-tilskuer",
  stadion: "sport-tilskuer",
  // family
  børn: "børn-familie",
  born: "børn-familie",
  kids: "børn-familie",
  children: "børn-familie",
  familie: "børn-familie",
  family: "børn-familie",
  // social / other
  social: "social-hobby",
  hobby: "social-hobby",
  gaming: "gaming-tech",
  tech: "gaming-tech",
  film: "film-medier",
  movie: "film-medier",
  cinema: "film-medier",
  bio: "film-medier",
  rejser: "rejser-eventyr",
  travel: "rejser-eventyr",
  natteliv: "musik-lyd",
  nightlife: "musik-lyd",
};

function fold(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9æøå_-]/g, "");
}

/**
 * Normalise a model-supplied category to a real slug, or null when we cannot
 * map it (null = search WITHOUT a category filter, never an empty result).
 */
export function normalizeCategory(input: string | null | undefined): CategorySlug | null {
  if (!input) return null;
  const raw = fold(input);
  if (!raw) return null;
  if ((REAL_CATEGORY_SLUGS as readonly string[]).includes(raw)) return raw as CategorySlug;
  if (ALIASES[raw]) return ALIASES[raw];
  // Underscore/dash confusion is the single most common model slip.
  const dashed = raw.replace(/_/g, "-");
  if ((REAL_CATEGORY_SLUGS as readonly string[]).includes(dashed)) return dashed as CategorySlug;
  if (ALIASES[dashed]) return ALIASES[dashed];
  // Last resort: a real slug that starts with what was said ("musik" → musik-lyd).
  const prefixed = REAL_CATEGORY_SLUGS.find((s) => s.startsWith(dashed + "-"));
  return prefixed ?? null;
}
