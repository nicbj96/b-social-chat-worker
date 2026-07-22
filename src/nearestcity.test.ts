import { describe, expect, it, vi } from "vitest";
import { searchPlaces } from "./supabase-queries";

// 82.5% of places have no city (122,113 of 148,075, measured 2026-07-22), so
// filtering on `city` alone made four fifths of the catalogue unreachable by any
// city search. These assert the query asks for both columns.
function fakeSupabase() {
  const calls: { or?: string; ilike?: [string, string]; select?: string } = {};
  const q: any = {
    select: (cols: string) => { calls.select = cols; return q; },
    order: () => q,
    limit: () => q,
    contains: () => q,
    ilike: (col: string, val: string) => { calls.ilike = [col, val]; return q; },
    or: (expr: string) => { calls.or = expr; return q; },
    then: (res: (v: unknown) => unknown) => res({ data: [], error: null }),
  };
  return { client: { from: () => q }, calls };
}

describe("searchPlaces city matching", () => {
  it("matches nearest_city as well as city", async () => {
    const { client, calls } = fakeSupabase();
    await searchPlaces(client as any, { city: "Aarhus" } as any);
    expect(calls.or).toBeTruthy();
    expect(calls.or).toContain("city.ilike.%Aarhus%");
    expect(calls.or).toContain("nearest_city.ilike.%Aarhus%");
  });

  it("selects nearest_city so a derived match is distinguishable from a real one", async () => {
    const { client, calls } = fakeSupabase();
    await searchPlaces(client as any, {} as any);
    expect(calls.select).toContain("nearest_city");
  });

  it("strips characters that would break the PostgREST or() filter", async () => {
    const { client, calls } = fakeSupabase();
    await searchPlaces(client as any, { city: "Aar,hus)(%" } as any);
    expect(calls.or).not.toContain(",nearest_city.ilike.%Aar,");
    expect(calls.or).toContain("Aarhus");
  });
});
