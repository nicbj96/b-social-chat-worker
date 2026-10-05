import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { explicitCurrency, eventPriceLabel } from "./event-price";
import type { ToolCallArgs } from "./tools";
import { normalizeCategory } from "./category-vocabulary";

// Create a Supabase client from env vars
export function createSupabaseClient(url: string, key: string): SupabaseClient {
  return createClient(url, key);
}

/**
 * Spellings that must hit the same city in the catalogue.
 *
 * Live 2026-08-23: "Find restauranter i Aarhus" returned 0 rows while the same
 * query in København returned places. The catalogue stores Århus; a single
 * ilike on Aarhus misses every row. Same trap for København/Copenhagen on
 * events.location.
 */
const CITY_SPELLING_ALIASES: Record<string, string[]> = {
  aarhus: ["Aarhus", "Århus"],
  århus: ["Aarhus", "Århus"],
  aalborg: ["Aalborg", "Ålborg"],
  ålborg: ["Aalborg", "Ålborg"],
  københavn: ["København", "Copenhagen"],
  copenhagen: ["København", "Copenhagen"],
};

export function citySearchNeedles(city: string | undefined | null): string[] {
  const cleaned = String(city || "").replace(/[%,()]/g, "").trim();
  if (!cleaned) return [];
  const extras = CITY_SPELLING_ALIASES[cleaned.toLocaleLowerCase("da-DK")];
  return extras ? [...new Set(extras)] : [cleaned];
}

// Search events with optional filters
export async function searchEvents(
  supabase: SupabaseClient,
  args: ToolCallArgs["search_events"]
) {
  // Bounds are instants, not offset-less local dates. Unknown event timezone
  // cannot safely supply an offset for the caller's calendar day.
  const parseBound = (value: unknown): string | null => {
    if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) return null;
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return null;
    // Date.parse rolls February 29/30 and 24:00 into another day. Validate the
    // literal calendar/clock first instead of silently repairing the request.
    const local = new Date(`${value.slice(0, 19)}Z`);
    if (Number.isNaN(local.getTime()) || local.toISOString().slice(0, 19) !== value.slice(0, 19)) return null;
    return new Date(timestamp).toISOString();
  };
  const from = args.date_from === undefined ? undefined : parseBound(args.date_from);
  const to = args.date_to === undefined ? undefined : parseBound(args.date_to);
  let displayTimezone = "UTC";
  try {
    if (args.timezone !== undefined) {
      if (typeof args.timezone !== "string" || !args.timezone.trim()) throw new Error("invalid timezone");
      displayTimezone = new Intl.DateTimeFormat("da-DK", { timeZone: args.timezone }).resolvedOptions().timeZone;
    }
  } catch {
    return { results: [], error: "Ugyldig visningstidszone" };
  }
  if (from === null || to === null || (from && to && from >= to)) {
    return { results: [], error: "Ugyldigt datointerval: brug ISO-tid med Z eller eksplicit UTC-offset" };
  }
  const cutoff = new Date(Math.max(Date.now(), from ? Date.parse(from) : 0)).toISOString();
  if (to && to <= cutoff) return { results: [] };

  let query = supabase
    .from("events")
    .select("id, title, description, location, date, end_date, all_day, status, country, source, url, category, price, price_currency, price_evidence, interest_tags, suitable_for_modes, indoor_outdoor, latitude, longitude")
    .not("date", "is", null)
    .or("status.eq.active,status.is.null")
    // Known end: include ongoing until (not including) end. Unknown end:
    // include only starts at/after cutoff, even for all-day/unknown-time rows.
    // Each or() is ANDed by PostgREST with the other filters before LIMIT.
    .or(`end_date.gt.${cutoff},and(end_date.is.null,date.gte.${cutoff})`);
  if (to) query = query.lt("date", to);

  // The model routinely emits a category word from outside the real taxonomy
  // ("musik", "concert", the worker's own legacy "mad_hangout"). Normalising
  // first turns those into real slugs; an unmappable word yields null and we
  // simply do not filter, because a broader answer beats an empty one.
  const eventCategory = normalizeCategory(args.category);
  if (eventCategory) {
    query = query.eq("category", eventCategory);
  }

  if (args.indoor_outdoor) {
    query = query.eq("indoor_outdoor", args.indoor_outdoor);
  }

  if (args.city) {
    const needles = citySearchNeedles(args.city);
    if (needles.length === 1) {
      query = query.ilike("location", `%${needles[0]}%`);
    } else if (needles.length > 1) {
      query = query.or(needles.map((needle) => `location.ilike.%${needle}%`).join(","));
    }
  }

  if (args.mode) {
    query = query.contains("suitable_for_modes", [args.mode]);
  }

  if (args.tags) {
    const tagList = args.tags.split(",").map((t) => t.trim().toLowerCase());
    query = query.overlaps("interest_tags", tagList);
  }

  const { data, error } = await query
    .order("date", { ascending: true })
    .order("id", { ascending: true })
    .limit(8);

  if (error) {
    console.error("Events query error:", error);
    return { results: [], error: error.message };
  }

  return {
    results: (data || []).map((e: any) => ({
      id: e.id,
      title: e.title,
      description: e.description,
      location: e.location,
      date: formatDate(e.date, e.all_day, displayTimezone),
      date_raw: e.date,
      end_date: e.end_date ?? null,
      all_day: e.all_day ?? null,
      status: e.status ?? null,
      country: e.country ?? null,
      source: e.source ?? null,
      url: e.url ?? null,
      // Currency columns require discovery_search_v1 schema gate before release.
      // Event timezone remains unknown; country is never evidence.
      timezone: null,
      currency: explicitCurrency(e.price_currency),
      price_evidence: e.price_evidence ?? null,
      price_amount: e.price ?? null,
      category: e.category,
      price: eventPriceLabel(e.price, e.price_currency),
      tags: e.interest_tags?.join(", "),
      modes: e.suitable_for_modes?.join(", "),
      indoor_outdoor: e.indoor_outdoor,
      // events.latitude/longitude exist (see b-social-pages searchDiscoverySql
      // schema). Null stays null: a missing coordinate must never become (0,0).
      latitude: Number.isFinite(e.latitude) ? e.latitude : null,
      longitude: Number.isFinite(e.longitude) ? e.longitude : null,
    })),
  };
}

// Search routes with optional filters
export async function searchRoutes(
  supabase: SupabaseClient,
  args: ToolCallArgs["search_routes"]
) {
  let query = supabase
    .from("routes")
    .select("name, description, activity_type, distance_km, difficulty, loop, surface, tags")
    .order("distance_km", { ascending: true })
    .limit(8);

  if (args.activity_type) {
    query = query.eq("activity_type", args.activity_type);
  }

  if (args.difficulty) {
    query = query.eq("difficulty", args.difficulty);
  }

  if (args.max_distance_km) {
    query = query.lte("distance_km", args.max_distance_km);
  }

  const { data, error } = await query;

  if (error) {
    console.error("Routes query error:", error);
    return { results: [], error: error.message };
  }

  return {
    results: (data || []).map((r: any) => ({
      name: r.name,
      description: r.description,
      activity: r.activity_type,
      distance: `${r.distance_km} km`,
      difficulty: r.difficulty,
      loop: r.loop ? "Rundtur" : "Punkt-til-punkt",
      surface: r.surface,
      tags: r.tags?.join(", "),
    })),
  };
}

// Search places with optional filters.
//
// Two phases, deliberately. Measured live 2026-09-21 on 148,122 places, role
// anon (statement_timeout = 3s): the single-query version below returned
// "57014 canceling statement due to statement timeout" for every filtered
// places search. The reason was not the ordering index (since added:
// 20260921070000_places_search_order_index) but the WIDTH of the tuple the
// ORDER BY had to materialise before it could keep the best 8:
//
//   category + city, full column list (description + metadata jsonb)  5,994 ms
//   category + city, id column only                                      36 ms
//   category + city, narrow columns (no description/metadata)            37 ms
//
// Same plan, same 6,485 heap blocks in all three: fetching the wide tuple for
// every candidate row is the entire cost. So phase one ranks on `id` alone -
// which the index serves without touching the heap - and phase two fetches the
// columns we actually return for those 8 ids by primary key.
export async function searchPlaces(
  supabase: SupabaseClient,
  args: ToolCallArgs["search_places"],
  limit = 8
) {
  // The same narrow-then-fetch shape serves /search, which asks for up to 50
  // rows instead of the chat's 8. Clamped here rather than trusted: the value
  // arrives from a public request body.
  const rowLimit = Number.isFinite(limit) ? Math.min(50, Math.max(1, Math.floor(limit))) : 8;
  let query = supabase
    .from("places")
    .select("id")
    // NULLS LAST is the whole point. Only 2.3% of places carry a rating
    // (3,336 of 148,075), and Postgres sorts NULLs FIRST on a DESC order -- so
    // this was returning 144,739 unrated places ahead of every rated one, in
    // arbitrary order. That is how "camping niffer — tozeur" and "Bush camp
    // White Desert" reached the top of a Danish search.
    .order("rating_avg", { ascending: false, nullsFirst: false })
    // Secondary: among the 97.7% with no rating, prefer the ones we can
    // actually describe. quality_score correlates strongly with having real
    // content -- places scoring 85+ are 81% described and 77% imaged, while the
    // 60-64 band (76,290 of them, half the catalogue) is 0% described and 28%
    // imaged. Showing a reader a place we know nothing about is the worse
    // answer even when neither has a rating.
    .order("quality_score", { ascending: false, nullsFirst: false })
    .limit(rowLimit);

  if (args.city) {
    // Match city OR nearest_city. 82.5% of places have NO city -- measured
    // 2026-07-22, 122,113 of 148,075 -- so filtering on `city` alone made four
    // fifths of the catalogue unreachable by any city search. That is why
    // "museer i Aarhus" came back with cafes: the museums were there, they just
    // had nothing for the filter to match.
    //
    // nearest_city is DERIVED from coordinates (nearest same-country place that
    // does have a city, capped at 25km), so it is a weaker claim than city and
    // deliberately kept in its own column rather than written into city.
    const needles = citySearchNeedles(args.city);
    if (needles.length) {
      const parts = needles.flatMap((needle) => [
        `city.ilike.%${needle}%`,
        `nearest_city.ilike.%${needle}%`,
      ]);
      query = query.or(parts.join(","));
    }
  }

  const placeCategory = normalizeCategory(args.category);
  if (placeCategory) {
    query = query.contains("main_categories", [placeCategory]);
  }

  if (args.tags) {
    const tagList = args.tags.split(",").map((t) => t.trim().toLowerCase());
    query = query.overlaps("tags", tagList);
  }

  const { data: ranked, error: rankError } = await query;

  if (rankError) {
    console.error("Places query error:", rankError);
    return { results: [], error: rankError.message };
  }

  const ids = (ranked || []).map((p: any) => p.id).filter(Boolean);
  // Nothing matched: do not spend a second round trip on an empty id list.
  if (ids.length === 0) return { results: [] };

  const { data, error } = await supabase
    .from("places")
    .select("id, name, description, city, nearest_city, region, main_categories, tags, smart_tags, rating_avg, metadata")
    .in("id", ids);

  if (error) {
    console.error("Places fetch error:", error);
    return { results: [], error: error.message };
  }

  // The id fetch has no meaningful order of its own, so restore the ranking the
  // first query established (a Map lookup, not a second sort).
  const rank = new Map(ids.map((id, index) => [id, index]));
  const ordered = (data || []).slice().sort(
    (a: any, b: any) => (rank.get(a.id) ?? ids.length) - (rank.get(b.id) ?? ids.length)
  );

  return {
    results: ordered.map((p: any) => ({
      id: p.id,
      name: p.name,
      description: p.description,
      city: p.city,
      // Carried through so the reply can say "nær Roskilde" instead of "by ikke
      // angivet" for a place located via the derived column. Selecting it and
      // then dropping it here is why the first attempt changed nothing.
      nearest_city: p.nearest_city,
      region: p.region,
      categories: p.main_categories?.join(", "),
      tags: p.tags?.join(", "),
      rating: p.rating_avg ? `${p.rating_avg}/5` : "Ingen rating endnu",
      facilities: p.metadata?.facilities?.join(", ") || "Ikke angivet",
    })),
  };
}

// UTC is an explicitly labelled display basis, not the event's local timezone.
// The current schema has no timezone provenance; never silently assign one.
function formatDate(isoDate: string, allDay = false, displayTimezone = "UTC"): string {
  try {
    const date = new Date(isoDate);
    if (Number.isNaN(date.getTime())) return isoDate;

    // Midnight UTC is the importer's "we got a date, not a time" sentinel
    // (mirrors the frontend's eventTimeUnknown rule). Rendering it as a clock
    // would invent a start time, so the date stands alone.
    const timeUnknown = allDay || (date.getUTCHours() === 0 && date.getUTCMinutes() === 0);

    const label = date.toLocaleDateString("da-DK", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      // Do not shift a date-only sentinel into a different calendar day.
      timeZone: timeUnknown ? "UTC" : displayTimezone,
      ...(timeUnknown ? {} : { hour: "2-digit", minute: "2-digit" }),
    });
    return `${label} (${timeUnknown ? "UTC-dato" : displayTimezone}; lokal tidszone ukendt)`;
  } catch {
    return isoDate;
  }
}
