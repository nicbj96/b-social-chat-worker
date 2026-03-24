import { createClient, SupabaseClient } from "@supabase/supabase-js";
import type { ToolCallArgs } from "./tools";

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
    .select("title, description, location, date, category, price, interest_tags, suitable_for_modes, indoor_outdoor")
    .gte("date", new Date().toISOString()) // only future events
    .order("date", { ascending: true })
    .limit(8);

  if (args.category) {
    query = query.eq("category", args.category);
  }

  if (args.indoor_outdoor) {
    query = query.eq("indoor_outdoor", args.indoor_outdoor);
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
    .select("name, description, city, region, main_categories, tags, smart_tags, rating_avg, metadata")
    .order("rating_avg", { ascending: false })
    .limit(8);

  if (args.city) {
    query = query.ilike("city", `%${args.city}%`);
  }

  if (args.category) {
    query = query.contains("main_categories", [args.category]);
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
      name: p.name,
      description: p.description,
      city: p.city,
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
