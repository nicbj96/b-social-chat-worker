export type DiscoveryKind = "places" | "events" | "both";
export type ResponseLanguage = "da" | "en";

export type DiscoveryIntent = {
  kind: DiscoveryKind;
  city?: string;
  placeCategory?: string;
  eventCategory?: string;
  queryTag?: string;
  limit: number;
};

type PlaceResult = { id?: string; name?: string; city?: string; nearest_city?: string };
type EventResult = { id?: string; title?: string; location?: string; date?: string };

/**
 * Which language to answer in.
 *
 * The first version scored 12 English words against 12 Danish ones and let
 * Danish win every tie — including 0–0. Measured against ordinary phrasing it
 * answered 8 of 10 English messages in Danish: "hi", "hello, can you help
 * me?", "any good jazz concerts?", "something fun for kids" all scored zero on
 * both lists and fell through to Danish.
 *
 * Two changes:
 *   1. Danish ORTHOGRAPHY (æ ø å) is treated as decisive. Nothing else in
 *      either language looks like that, and it is present in most real Danish
 *      sentences.
 *   2. The word lists are DISTINCTIVE only. Words that genuinely exist in both
 *      languages — for, weekend, festival, park, jazz — are excluded rather
 *      than assigned to one side, because a shared word is evidence of nothing
 *      and was most of what the old lists contained. "to" and "at" are
 *      excluded for the same reason: both are ordinary Danish words. "find"
 *      went the same way on 2026-07-22: it is the Danish imperative of
 *      "finde", so "Find quidditch-turneringer i Thisted" scored English 1,
 *      Danish 0 and was answered in English. But
 *      in/of/on/from/with ARE distinctive — Danish uses i/af/på/fra/med, which
 *      are different tokens and cannot match a word-boundaried "in".
 *
 * Danish still wins a genuine tie: this is a Danish-first product, and
 * answering a Dane in English is the worse error.
 */

const DANISH_LETTERS = /[æøå]/iu;

const DANISH_WORDS =
  /\b(hvad|hvor|hvornår|hvilke|jeg|ikke|noget|sker|kan|vil|skal|der|det|den|og|på|til|er|en|et|som|har|gerne|lidt|mig|dig|min|din|vise|find(?:e)?r|steder|aften|weekenden|nær|tak|hej)\b/giu;

const ENGLISH_WORDS =
  /\b(the|is|are|was|what|where|when|how|why|you|your|yours|me|my|mine|want|any|good|some|something|anything|there|their|give|ideas|happening|free|help|hello|hi|hey|please|show|near|nearby|around|this|these|those|tonight|tomorrow|today|weekend|looking|recommend|suggest|can|could|would|should|do|does|did|going|go|out|about|thanks|thank|in|of|on|from|with)\b/giu;

export function inferResponseLanguage(message: string): ResponseLanguage {
  const text = String(message || "").toLocaleLowerCase("da-DK");
  if (!text.trim()) return "da";

  // Decisive: no English word contains these.
  if (DANISH_LETTERS.test(text)) return "da";

  const danish = text.match(DANISH_WORDS)?.length ?? 0;
  const english = text.match(ENGLISH_WORDS)?.length ?? 0;

  if (english > danish) return "en";
  if (danish > english) return "da";
  // Genuine tie, including 0–0: answer in Danish. Answering a Dane in English
  // is the worse of the two mistakes on a Danish-first product.
  return "da";
}

// Whatever is NOT in this list gets no city filter at all, which means the
// search runs unconstrained and answers from the whole planet. Live on
// 2026-07-22, "vandreture i Nordjylland" came back with a campsite in
// Chattogram, Bangladesh and one in Tozeur, Tunisia -- because "Nordjylland"
// matched nothing here, so the query simply stopped being about Denmark.
//
// city-bbox.ts already knows the ~25 Danish cities people actually type; this
// list had fourteen entries and duplicated it badly. Kept as display names
// rather than folded keys because supabase-queries matches with
// ilike('city', '%name%').
//
// Longest first: `.find()` takes the first hit, and "Frederiksberg" must not
// lose to a shorter substring of itself.
const KNOWN_CITIES = [
  // Denmark
  "Frederikshavn", "Frederiksberg", "Frederikssund", "Sønderborg", "Silkeborg",
  "Holstebro", "Svendborg", "Helsingør", "Helsingor", "Hillerød", "Næstved",
  "Naestved", "Roskilde", "Slagelse", "Esbjerg", "Randers", "Kolding",
  "Horsens", "Herning", "Viborg", "Skagen", "Hjørring", "Aabenraa", "Nykøbing",
  "København", "Copenhagen", "Aalborg", "Ålborg", "Aarhus", "Århus", "Odense",
  "Vejle", "Køge", "Koge", "Ribe", "Møn",
  // Added 2026-07-22 after "quidditch-turneringer i Thisted" answered with
  // Skagen, Rebild and Blokhus: a town missing from this list gets NO city
  // filter, so the question quietly stops being about that place.
  "Frederikssund", "Brønderslev", "Kalundborg", "Middelfart", "Fredericia",
  "Haderslev", "Nakskov", "Ringsted", "Thisted", "Holbæk", "Nyborg",
  "Grenaa", "Hobro", "Struer", "Varde", "Skive", "Ikast", "Sorø", "Rønne",
  // Nordic neighbours the chat is asked about
  "Stockholm", "Göteborg", "Goteborg", "Helsinki", "Bergen", "Malmö", "Malmo",
  "Oslo",
];

// Regions are NOT cities and there is no region filter in searchPlaces, so a
// region name would otherwise fall through to a global search. Mapping each to
// its principal city keeps the answer in the right part of the country, which
// is far closer to what was asked than another continent. Recorded as an
// approximation on purpose -- the honest fix is a region filter in the query
// layer.
const REGION_TO_CITY: Record<string, string> = {
  nordjylland: "Aalborg",
  midtjylland: "Aarhus",
  syddanmark: "Odense",
  sydjylland: "Esbjerg",
  vestjylland: "Herning",
  østjylland: "Aarhus",
  ostjylland: "Aarhus",
  sjælland: "København",
  sjaelland: "København",
  hovedstaden: "København",
  fyn: "Odense",
  bornholm: "Rønne",
  jylland: "Aarhus",
};

const CATEGORY_RULES = [
  // \w* rather than a closing \b, matching every other rule here. With the
  // boundary, Danish plurals did not match their own singular: "koncerter" --
  // far more natural than "koncert" -- got NO category filter, so asking for
  // concerts in København returned a meditation session and a running club,
  // correctly located and entirely wrong. Also fixes musikken, festivaler and
  // jazzklub. Same failure the museum rule below already documents for
  // "museer"; music was simply left behind.
  // `tag` MUST equal `eventCategory` unless a narrower tag genuinely exists and
  // is populated. index.ts:888 prefers a specific tag over the category, so a
  // tag nobody carries silently empties the whole answer.
  //
  // This said tag: "jazz", so every music question became a jazz question.
  // Measured 2026-07-22: jazz-tagged events in København = 0, music-category
  // events in København = 279. The narrower tag is still used when the reader
  // actually says "jazz" — that is the branch below this list.
  { test: /\b(jazz|koncert|musik|festival)\w*/iu, placeCategory: "musik-lyd", eventCategory: "musik", tag: "musik" },
  { test: /\b(natur|outdoor|skov|park|vandring|hundeskov)\w*/iu, placeCategory: "natur-outdoor", eventCategory: "natur", tag: "natur" },
  { test: /\b(børn|barn|familie)\w*/iu, placeCategory: "børn-familie", eventCategory: "familie", tag: "familie" },
  // "musee" as well as "museum" -- same Danish stem change as the place signal
  // above. Without it "museer i Roskilde" matched no CATEGORY either, so the
  // reply was correctly located and still returned a festival and a mountain
  // bike trail.
  { test: /\b(kultur|kunst|museum|musee|udstilling)\w*/iu, placeCategory: "kultur-kunst", eventCategory: "kunst", tag: "kunst" },
  { test: /\b(mad|restaurant|café|cafe|drikke)\w*/iu, placeCategory: "mad-drikke", eventCategory: "mad_drikke", tag: "mad_drikke" },  // was "mad": 0 events carry it
  { test: /\b(motion|fitness|løb|cykel|sport)\w*/iu, placeCategory: "motion-fitness", eventCategory: "sport", tag: "sport" },  // was "motion": 0 events carry it
] as const;

export function inferDiscoveryIntent(message: string, contextCity?: string): DiscoveryIntent {
  const text = String(message || "").trim();
  const lower = text.toLocaleLowerCase("da-DK");
  // "museer" is the Danish plural of "museum" and it changes the stem, so the
  // trailing \w* cannot reach it the way it reaches "restauranter" or
  // "parker". Found by the golden set on 2026-07-22: "museer i Roskilde"
  // matched NO place signal, fell to the default kind, and "museer og events i
  // Odense" was read as events-only -- the museums half of the question was
  // silently dropped. Every other noun here pluralises by suffix and is fine.
  //
  // Danish compounds and Danish town names BOTH end in -sted, so neither a bare
  // substring nor a plain word boundary is enough on its own:
  //
  //   unboundaried  -> "sted" matches inside THIsted and RINGsted, so every
  //                    question about either town became a PLACES search.
  //                    "koncerter i Thisted" asked for events and got parks.
  //   \b(sted)      -> fixes the towns and breaks natursteder and spisesteder,
  //                    which are ordinary Danish place words.
  //
  // The asymmetry that separates them: no Danish town ends in -stedER. So
  // "sted" must stand at a word boundary, while "steder" may appear anywhere.
  const placeSignal = /(\b(sted|park|skov|museum|musee|museet|restaurant|café|cafe)\w*|steder)/iu.test(text);
  // Left as it was, deliberately. Widening this with turnering/kamp/
  // forestilling/udstilling and the time phrases made almost every message match
  // BOTH signals, which turned six passing tests into "both" and lost the
  // routing entirely. The bug found today was the missing boundary on the PLACE
  // signal, not a thin event vocabulary -- widening that is a separate change
  // and needs its own evidence. "turnering" is the single exception, added
  // after checking it in isolation: it is unambiguously an event word, and
  // it changes exactly one of the six routing cases (the quidditch query)
  // while leaving steder/restauranter/natursteder/museer untouched.
  const eventSignal = /(event|events|koncert|festival|jazz|aktivitet|aktiviteter|weekend|i aften|turnering)\w*/iu.test(text);
  const kind: DiscoveryKind = placeSignal && eventSignal ? "both" : placeSignal ? "places" : eventSignal ? "events" : "both";

/**
 * Fold a place name to a comparable form: lowercase, diacritics stripped, and
 * anything that is not a letter removed. "København" and "Koebenhavn" and
 * "KOBENHAVN" all become "kobenhavn".
 *
 * ø and Ø do NOT decompose under NFD -- they are distinct letters, not o with a
 * mark -- so they are replaced explicitly. Same for đ/ð/ł, which appear in
 * Nordic and Slavic place names our sources carry.
 */
function foldPlace(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/[øœ]/gu, "o")
    .replace(/[æ]/gu, "ae")
    .replace(/[đðᵭ]/gu, "d")
    .replace(/[ł]/gu, "l")
    .replace(/[^a-z]/gu, "");
}

/** Levenshtein distance, bounded: returns max+1 as soon as it cannot beat it. */
function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      if (cur[j] < best) best = cur[j];
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

/**
 * Resolve a near-miss city name: "Kbenhavn", "Kobenhaven", "Arhus".
 *
 * Why this is not a nicety. When no city resolves, `city` stays undefined and
 * searchPlaces runs with NO location filter at all -- so a single dropped letter
 * did not narrow the search, it removed the geography entirely. A mistyped
 * "Kbenhavn" answered with a Dock Manager's Office in London and a stadium in
 * Kuwait. Failing to recognise a place must never silently become "search the
 * whole planet".
 *
 * TOKEN-WISE, not against the whole message, because the message is long and a
 * distance-2 window over it would match almost anything.
 *
 * The thresholds are deliberately tight: a word must be at least 5 letters, and
 * only one edit is allowed below 8 letters. "Ry", "Ribe" and "Roskilde" are all
 * real Danish towns, and a loose threshold would silently answer for the wrong
 * one -- worse than admitting we did not recognise it.
 */
function fuzzyCity(text: string): string | undefined {
  const tokens = text.split(/[^\p{L}]+/u).filter((t) => t.length >= 5);
  if (!tokens.length) return undefined;
  for (const candidate of KNOWN_CITIES) {
    const folded = foldPlace(candidate);
    if (folded.length < 5) continue;
    const max = folded.length >= 8 ? 2 : 1;
    for (const token of tokens) {
      const ft = foldPlace(token);
      if (!ft || ft === folded) continue; // exact hits are handled before this
      if (editDistance(ft, folded, max) <= max) return candidate;
    }
  }
  return undefined;
}

  // City aliases for DB search (KBH/Cph → København). Keep full Copenhagen match as København.
  let city: string | undefined;
  if (/\b(kbh|cph|copenhagen)\b/iu.test(text)) city = "København";
  else {
    city = KNOWN_CITIES.find((candidate) => lower.includes(candidate.toLocaleLowerCase("da-DK")));
    if (!city) {
      // A region is not a city, but its principal city is a far better answer
      // than an unfiltered global search. See REGION_TO_CITY.
      const region = Object.keys(REGION_TO_CITY).find((r) => lower.includes(r));
      if (region) city = REGION_TO_CITY[region];
    }
    // Only after the exact and region passes have both failed: a typo should
    // cost the reader a slightly fuzzy match, not the entire location filter.
    if (!city) city = fuzzyCity(text);
    if (!city) city = contextCity?.trim() || undefined;
  }

  const category = CATEGORY_RULES.find((rule) => rule.test.test(text));
  const requested = Number(text.match(/\b([1-8])\b/u)?.[1] || 4);

  const intent: DiscoveryIntent = { kind, ...(city ? { city } : {}), limit: Math.min(8, Math.max(1, requested)) };
  if (category) {
    if (kind !== "events") intent.placeCategory = category.placeCategory;
    if (kind !== "places") intent.eventCategory = category.eventCategory;
    intent.queryTag = category.test.test(text) && /jazz/iu.test(text) ? "jazz" : category.tag;
  }
  return intent;
}

/** True when the user is asking us to look up places/events in the DB. */
export function isDiscoverySeekingMessage(message: string): boolean {
  const text = String(message || "").trim();
  if (!text) return false;
  const hasVerb = /\b(find|vis|søg|anbefal|show|recommend|search|looking for|hvad sker|hvad kan)\b/iu.test(text);
  const hasNoun = /\b(event|events|sted|steder|koncert|festival|jazz|aktivitet|aktiviteter|museum|restaurant|café|cafe|park|skov)\w*\b/iu.test(text);
  const hasCity = /\b(kbh|cph|københavn|copenhagen|aarhus|århus|aalborg|ålborg|odense|malmö|malmo|frederikshavn)\b/iu.test(text);
  return (hasVerb && (hasNoun || hasCity)) || (hasNoun && hasCity);
}

/** Placeholder / invented discovery prose without tool grounding. */
/**
 * True when the model wrote a TOOL CALL as prose instead of calling the tool —
 * e.g. it answered literally `semantic_search(query="Beyoncé koncert Skagen",
 * kind="events", city="Skagen")`. Caught by the golden-set eval on 2026-07-22,
 * where a user asking about a concert that does not exist got that string back
 * as their answer. It is never a legitimate reply: the user sees machine
 * internals, and the discovery never actually ran.
 */
export function looksLikeRawToolCall(reply: string): boolean {
  const text = String(reply || "").trim();
  if (!text) return false;
  // A tool name immediately followed by an argument list, anywhere in the text.
  // Written as a LITERAL regex on purpose: building it from a template string
  // turned "\b" into a backspace character and silently produced an invalid
  // pattern (caught by the unit test below).
  const CALLISH =
    /\b(semantic_search|search_events|search_places|search_routes|save_user_tags|save_user_prefs|rsvp_event|save_place|send_to_team)\s*\(/i;
  if (CALLISH.test(text)) return true;
  // Some models emit the JSON envelope instead.
  if (/^\s*\{\s*"(name|function|tool_call|tool)"\s*:/i.test(text)) return true;
  return false;
}

export function looksUngroundedDiscoveryReply(reply: string): boolean {
  const text = String(reply || "");
  if (!text.trim()) return false;
  if (looksLikeRawToolCall(text)) return true;
  if (/\(\s*search result\s*\)/i.test(text)) return true;
  if (/\b(placeholder|lorem ipsum|TODO|\[result\])\b/i.test(text)) return true;
  // Claims to have found things with no concrete place/event bullet lines.
  const claimsFound = /\b(her er (hvad|nogle|resultater)|found (some|these)|jeg fandt)\b/iu.test(text);
  const hasConcreteBullet = /[•\-\*]\s+\S+/.test(text) || /\d+\.\s+\S+/.test(text);
  if (claimsFound && !hasConcreteBullet) return true;
  return false;
}

export function formatFallbackReply(
  intent: DiscoveryIntent,
  places: PlaceResult[],
  events: EventResult[],
  language: ResponseLanguage,
) {
  const seenPlaces = new Set<string>();
  const uniquePlaces = places.filter((place) => {
    if (!place.id || !place.name) return false;
    const key = `${place.name}|${place.city || ""}`.trim().toLocaleLowerCase("da-DK");
    if (seenPlaces.has(key)) return false;
    seenPlaces.add(key);
    return true;
  });
  const seenEvents = new Set<string>();
  const uniqueEvents = events.filter((event) => {
    if (!event.id || !event.title) return false;
    const key = `${event.title}|${event.location || ""}|${event.date || ""}`.trim().toLocaleLowerCase("da-DK");
    if (seenEvents.has(key)) return false;
    seenEvents.add(key);
    return true;
  });
  const selectedPlaces = uniquePlaces.slice(0, intent.limit);
  const remaining = Math.max(0, intent.limit - selectedPlaces.length);
  const eventCapacity = intent.kind === "events" ? intent.limit : remaining;
  const selectedEvents = uniqueEvents.slice(0, eventCapacity);
  const copy = language === "en"
    ? {
        intro: "Here are results directly from B-Social:",
        // Asked for events, got only places. Saying so is the difference
        // between an answer and a substitution presented as one.
        placesInstead: "I found no events for that, but here are places",
        noResults: "I found no results",
        cityMissing: "city not specified",
        nearCity: "near",
        locationMissing: "location not specified",
        cityPrefix: "in",
        selectedFilters: "with the selected filters.",
      }
    : {
        intro: "Her er resultater direkte fra B-Social:",
        placesInstead: "Jeg fandt ingen events til det, men her er steder",
        noResults: "Jeg fandt ingen resultater",
        cityMissing: "by ikke angivet",
        nearCity: "nær",
        locationMissing: "sted ikke angivet",
        cityPrefix: "i",
        selectedFilters: "med de valgte filtre.",
      };
  const lines = [
    // Show the DERIVED city when there is no real one, marked as approximate.
    // Matching on nearest_city while printing "by ikke angivet" made a place we
    // had just located look like one we knew nothing about.
    ...selectedPlaces.map((place) => {
      const where = place.city
        ? place.city
        : place.nearest_city
          ? `${copy.nearCity} ${place.nearest_city}`
          : copy.cityMissing;
      return `• ${place.name} — ${where}`;
    }),
    ...selectedEvents.map((event) => `• ${event.title} — ${event.location || copy.locationMissing}${event.date ? ` (${event.date})` : ""}`),
  ].slice(0, intent.limit);

  // The reader asked for EVENTS and we are about to show only PLACES. Calling
  // that "results directly from B-Social" presents a substitution as an answer:
  // "quidditch-turneringer i Thisted" came back listing nature spots under that
  // heading. Same rule as the widened-radius label on the feed — when the answer
  // is not the thing that was asked for, say so.
  const substituting =
    intent.kind === "events" && selectedEvents.length === 0 && selectedPlaces.length > 0;

  return {
    reply: lines.length > 0
      ? `${substituting ? `${copy.placesInstead}${intent.city ? ` ${copy.cityPrefix} ${intent.city}` : ""}:` : copy.intro}\n${lines.join("\n")}`
      : `${copy.noResults}${intent.city ? ` ${copy.cityPrefix} ${intent.city}` : ""} ${copy.selectedFilters}`,
    tool_calls_made: ["direct_discovery_fallback"],
    place_ids: selectedPlaces.map((place) => String(place.id)).slice(0, intent.limit),
    event_ids: selectedEvents.map((event) => String(event.id)),
    suggested_tag_slugs: intent.placeCategory ? [intent.placeCategory] : [],
    degraded: true,
  };
}

export function isAiQuotaError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || error || "");
  return /4006|daily free allocation|used up.*neurons/i.test(message);
}

/** Model claimed empty while tools returned rows — prose must not contradict IDs. */
const EMPTY_CLAIM_RE =
  /\b(ingen.{0,40}(resultater|events?|koncerter|steder)|fandt (ikke|ingen)|could(?:\s*not|n't) find|no (results?|events?|concerts?|places?)|desværre ikke finde|kunne desværre ikke)\b/iu;

export function claimsEmptyDiscovery(reply: string): boolean {
  return EMPTY_CLAIM_RE.test(String(reply || ""));
}

export function repairContradictoryGroundedReply(
  reply: string,
  places: PlaceResult[],
  events: EventResult[],
  language: ResponseLanguage = "da",
): string {
  const hasRows = places.some((p) => p.id) || events.some((e) => e.id);
  if (!hasRows) return reply;
  if (String(reply || "").trim() && !claimsEmptyDiscovery(reply)) return reply;
  return formatFallbackReply(
    { kind: "both", limit: Math.min(8, Math.max(places.length + events.length, 1)) },
    places,
    events,
    language,
  ).reply;
}
