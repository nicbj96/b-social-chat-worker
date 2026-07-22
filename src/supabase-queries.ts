import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { ToolCallArgs } from "./tools";
import { normalizeCategory } from "./category-vocabulary";

// Create a Supabase client from env vars
export function createSupabaseClient(url: string, key: string): SupabaseClient {
  return createClient(url, key);
}

// Search events with optional filters
export async function searchEvents(
  supabase: SupabaseClient,
  args: ToolCallArgs["search_events"]
) {
  let query = supabase
    .from("events")
    .select("id, title, description, location, date, category, price, interest_tags, suitable_for_modes, indoor_outdoor")
    .gte("date", new Date().toISOString()) // only future events
    .order("date", { ascending: true })
    .limit(8);

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
    query = query.ilike("location", `%${args.city}%`);
  }

  if (args.mode) {
    query = query.contains("suitable_for_modes", [args.mode]);
  }

  if (args.tags) {
    const tagList = args.tags.split(",").map((t) => t.trim().toLowerCase());
    query = query.overlaps("interest_tags", tagList);
  }

  const { data, error } = await query;

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
      date: formatDate(e.date),
      category: e.category,
      price: e.price ? `${e.price} kr` : "Gratis",
      tags: e.interest_tags?.join(", "),
      modes: e.suitable_for_modes?.join(", "),
      indoor_outdoor: e.indoor_outdoor,
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

// Search places with optional filters
export async function searchPlaces(
  supabase: SupabaseClient,
  args: ToolCallArgs["search_places"]
) {
  let query = supabase
    .from("places")
    .select("id, name, description, city, nearest_city, region, main_categories, tags, smart_tags, rating_avg, metadata")
    .order("rating_avg", { ascending: false })
    .limit(8);

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
    const needle = String(args.city).replace(/[%,()]/g, "").trim();
    if (needle) {
      query = query.or(`city.ilike.%${needle}%,nearest_city.ilike.%${needle}%`);
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

  const { data, error } = await query;

  if (error) {
    console.error("Places query error:", error);
    return { results: [], error: error.message };
  }

  return {
    results: (data || []).map((p: any) => ({
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

// Helper: format ISO date to nice Danish format
function formatDate(isoDate: string): string {
  try {
    const date = new Date(isoDate);
    return date.toLocaleDateString("da-DK", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoDate;
  }
}
