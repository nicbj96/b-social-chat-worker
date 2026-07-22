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

type PlaceResult = { id?: string; name?: string; city?: string };
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
 *      excluded for the same reason: both are ordinary Danish words. But
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
  /\b(the|is|are|was|what|where|when|how|why|you|your|yours|me|my|mine|want|any|good|some|something|anything|there|their|give|ideas|happening|free|help|hello|hi|hey|please|show|near|nearby|around|this|these|those|tonight|tomorrow|today|weekend|looking|find|recommend|suggest|can|could|would|should|do|does|did|going|go|out|about|thanks|thank|in|of|on|from|with)\b/giu;

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
  { test: /\b(jazz|koncert|musik|festival)\b/iu, placeCategory: "musik-lyd", eventCategory: "musik", tag: "jazz" },
  { test: /\b(natur|outdoor|skov|park|vandring|hundeskov)\w*/iu, placeCategory: "natur-outdoor", eventCategory: "natur", tag: "natur" },
  { test: /\b(børn|barn|familie)\w*/iu, placeCategory: "børn-familie", eventCategory: "familie", tag: "familie" },
  { test: /\b(kultur|kunst|museum|udstilling)\w*/iu, placeCategory: "kultur-kunst", eventCategory: "kunst", tag: "kunst" },
  { test: /\b(mad|restaurant|café|cafe|drikke)\w*/iu, placeCategory: "mad-drikke", eventCategory: "mad_drikke", tag: "mad" },
  { test: /\b(motion|fitness|løb|cykel|sport)\w*/iu, placeCategory: "motion-fitness", eventCategory: "sport", tag: "motion" },
] as const;

export function inferDiscoveryIntent(message: string, contextCity?: string): DiscoveryIntent {
  const text = String(message || "").trim();
  const lower = text.toLocaleLowerCase("da-DK");
  const placeSignal = /(sted|steder|park|skov|museum|restaurant|café|cafe)\w*/iu.test(text);
  const eventSignal = /(event|events|koncert|festival|jazz|aktivitet|aktiviteter|weekend|i aften)\w*/iu.test(text);
  const kind: DiscoveryKind = placeSignal && eventSignal ? "both" : placeSignal ? "places" : eventSignal ? "events" : "both";

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
        noResults: "I found no results",
        cityMissing: "city not specified",
        locationMissing: "location not specified",
        cityPrefix: "in",
        selectedFilters: "with the selected filters.",
      }
    : {
        intro: "Her er resultater direkte fra B-Social:",
        noResults: "Jeg fandt ingen resultater",
        cityMissing: "by ikke angivet",
        locationMissing: "sted ikke angivet",
        cityPrefix: "i",
        selectedFilters: "med de valgte filtre.",
      };
  const lines = [
    ...selectedPlaces.map((place) => `• ${place.name} — ${place.city || copy.cityMissing}`),
    ...selectedEvents.map((event) => `• ${event.title} — ${event.location || copy.locationMissing}${event.date ? ` (${event.date})` : ""}`),
  ].slice(0, intent.limit);

  return {
    reply: lines.length > 0
      ? `${copy.intro}\n${lines.join("\n")}`
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
