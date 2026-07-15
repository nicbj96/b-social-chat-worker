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

export function inferResponseLanguage(message: string): ResponseLanguage {
  const text = String(message || "").toLocaleLowerCase("da-DK");
  const englishScore = text.match(/\b(show|places?|near|in|this|tonight|around|with|please|recommend|what|where)\b/gu)?.length || 0;
  const danishScore = text.match(/\b(vis|steder?|nær|i|denne|aften|omkring|med|venligst|anbefal|hvad|hvor)\b/gu)?.length || 0;
  return englishScore > danishScore ? "en" : "da";
}

const KNOWN_CITIES = [
  "Frederikshavn", "København", "Copenhagen", "Aarhus", "Århus", "Aalborg", "Ålborg",
  "Odense", "Malmö", "Malmo", "Stockholm", "Göteborg", "Oslo", "Bergen", "Helsinki",
];

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
  const placeSignal = /(sted|steder|park|skov|museum|restaurant|café|cafe)\w*/iu.test(text);
  const eventSignal = /(event|events|koncert|festival|jazz|aktivitet|aktiviteter|weekend|i aften)\w*/iu.test(text);
  const kind: DiscoveryKind = placeSignal && eventSignal ? "both" : placeSignal ? "places" : eventSignal ? "events" : "both";
  const city = KNOWN_CITIES.find((candidate) => text.toLocaleLowerCase("da-DK").includes(candidate.toLocaleLowerCase("da-DK"))) || contextCity?.trim() || undefined;
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
  /\b(ingen (resultater|events?|koncerter|steder)|could(?:\s*not|n't) find|no (results?|events?|concerts?|places?)|desværre ikke finde|kunne desværre ikke)\b/iu;

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
