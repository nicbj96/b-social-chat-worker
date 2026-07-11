export type DiscoveryKind = "places" | "events" | "both";

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
  const eventSignal = /\b(event|events|koncert|festival|jazz|aktivitet|aktiviteter|weekend|i aften)\w*/iu.test(text);
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

export function formatFallbackReply(intent: DiscoveryIntent, places: PlaceResult[], events: EventResult[]) {
  const selectedPlaces = places.slice(0, intent.limit).filter((place) => place.id && place.name);
  const remaining = Math.max(0, intent.limit - selectedPlaces.length);
  const selectedEvents = events.slice(0, remaining || intent.limit).filter((event) => event.id && event.title);
  const lines = [
    ...selectedPlaces.map((place) => `• ${place.name} — ${place.city || "by ikke angivet"}`),
    ...selectedEvents.map((event) => `• ${event.title} — ${event.location || "sted ikke angivet"}${event.date ? ` (${event.date})` : ""}`),
  ].slice(0, intent.limit);

  return {
    reply: lines.length > 0
      ? `Her er resultater direkte fra B-Social:\n${lines.join("\n")}`
      : `Jeg fandt ingen resultater${intent.city ? ` i ${intent.city}` : ""} med de valgte filtre.`,
    tool_calls_made: ["direct_discovery_fallback"],
    place_ids: selectedPlaces.map((place) => String(place.id)).slice(0, intent.limit),
    event_ids: selectedEvents.map((event) => String(event.id)).slice(0, Math.max(0, intent.limit - selectedPlaces.length) || intent.limit),
    suggested_tag_slugs: intent.placeCategory ? [intent.placeCategory] : [],
    degraded: true,
  };
}

export function isAiQuotaError(error: unknown): boolean {
  const message = String((error as { message?: string })?.message || error || "");
  return /4006|daily free allocation|used up.*neurons/i.test(message);
}
