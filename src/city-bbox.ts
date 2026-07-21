// ---------------------------------------------------------------------------
// city-bbox.ts — turn "jeg bor i Aalborg" into an actual search filter
// ---------------------------------------------------------------------------
// MEASURED FAILURE (2026-07-22): asked "Jeg bor i Aalborg — hvad kan jeg lave
// her i weekenden?", the assistant answered with three København events. Not a
// model failure: `semantic_search` had no city or radius parameter at all, so
// where the person is could never reach the query. The database side is fixed
// (match_events/match_places both take a bounding box); this is the vocabulary
// that turns a city NAME into one.
//
// Boxes are generous on purpose — roughly the commuting area, not the municipal
// boundary — because someone in Aalborg will happily go to Nørresundby, and a
// box that is slightly too big only re-orders results, while one that is too
// small hides real options. Under-filtering is the safe direction.
// ---------------------------------------------------------------------------

export interface BBox {
  /** north, south, east, west in WGS84 degrees. */
  n: number;
  s: number;
  e: number;
  w: number;
  /** ISO country the box sits in. Used to keep coordinate-less rows honest:
   *  they survive a box filter (their feed simply omitted a point), but only
   *  inside the same country — otherwise an Aalborg search returns a Finnish
   *  festival that happens to lack coordinates, which is exactly what happened
   *  on the first live probe of this feature. */
  country: string;
}

/** ~35 km half-height / ~55 km half-width around the city centre. */
function box(lat: number, lng: number, country = "DK", padLat = 0.32, padLng = 0.55): BBox {
  return { n: lat + padLat, s: lat - padLat, e: lng + padLng, w: lng - padLng, country };
}

const CITIES: Record<string, BBox> = {
  // Denmark — the 15 biggest, plus the ones people actually name in chat.
  kobenhavn: box(55.6761, 12.5683),
  frederiksberg: box(55.6786, 12.5313),
  aarhus: box(56.1629, 10.2039),
  odense: box(55.4038, 10.4024),
  aalborg: box(57.0488, 9.9217),
  esbjerg: box(55.4765, 8.4594),
  randers: box(56.4607, 10.0369),
  kolding: box(55.4904, 9.4722),
  horsens: box(55.8607, 9.8503),
  vejle: box(55.7090, 9.5357),
  roskilde: box(55.6415, 12.0803),
  herning: box(56.1362, 8.9767),
  helsingor: box(56.0361, 12.6136),
  silkeborg: box(56.1697, 9.5451),
  naestved: box(55.2297, 11.7609),
  viborg: box(56.4530, 9.4020),
  koge: box(55.4580, 12.1820),
  holstebro: box(56.3600, 8.6160),
  taastrup: box(55.6500, 12.3000),
  slagelse: box(55.4029, 11.3540),
  hillerod: box(55.9300, 12.3100),
  sonderborg: box(54.9139, 9.7920),
  svendborg: box(55.0600, 10.6100),
  hjorring: box(57.4640, 9.9820),
  frederikshavn: box(57.4410, 10.5340),
  // Nearby Nordic capitals, for the "hvad med Malmø?" case.
  malmo: box(55.6050, 13.0038, "SE"),
  stockholm: box(59.3293, 18.0686, "SE"),
  oslo: box(59.9139, 10.7522, "NO"),
  goteborg: box(57.7089, 11.9746, "SE"),
};

/** Fold Danish spelling variants down to the map's ascii keys. */
function fold(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/æ/g, "ae")
    .replace(/ø/g, "o")
    .replace(/å/g, "a")
    .replace(/ö/g, "o")
    .replace(/ä/g, "a")
    .replace(/[^a-z]/g, "");
}

const ALIASES: Record<string, string> = {
  copenhagen: "kobenhavn",
  cph: "kobenhavn",
  kbh: "kobenhavn",
  kbenhavn: "kobenhavn",
  cituofcopenhagen: "kobenhavn",
  arhus: "aarhus",
  aarhusc: "aarhus",
  alborg: "aalborg",
  aalborgo: "aalborg",
  elsinore: "helsingor",
  malmoe: "malmo",
  gothenburg: "goteborg",
};

/**
 * Resolve a city name to a search box, or null when we do not know it (null
 * means "do not filter", never an empty result).
 */
export function cityToBBox(city: string | null | undefined): BBox | null {
  if (!city) return null;
  const key = fold(city);
  if (!key) return null;
  if (CITIES[key]) return CITIES[key];
  const alias = ALIASES[key];
  if (alias && CITIES[alias]) return CITIES[alias];
  // "Aalborg Øst", "København K", "Aarhus N" — a known city with a suffix.
  const prefixed = Object.keys(CITIES).find((c) => key.startsWith(c) && c.length >= 5);
  return prefixed ? CITIES[prefixed] : null;
}

/** All city keys we can resolve — used to tell the model what it may pass. */
export const KNOWN_CITIES = Object.keys(CITIES);
