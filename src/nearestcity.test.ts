import { describe, expect, it, vi } from "vitest";
import { searchPlaces } from "./supabase-queries";

// 82.5% of places have no city (122,113 of 148,075, measured 2026-07-22), so
// filtering on `city` alone made four fifths of the catalogue unreachable by any
// city search. These assert the query asks for both columns.
function fakeSupabase() {
  const calls: { or?: string; ilike?: [string, string]; select?: string; orders: [string, unknown][] } = { orders: [] };
  const q: any = {
    select: (cols: string) => { calls.select = cols; return q; },
    order: (col: string, opts?: unknown) => { calls.orders.push([col, opts]); return q; },
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

  it("also matches the Århus spelling when the user wrote Aarhus", async () => {
    // Live 2026-08-23: "Find restauranter i Aarhus" returned zero rows while
    // the same query in København returned places. The catalogue stores the
    // city as Århus; a single ilike on Aarhus misses every row.
    const { client, calls } = fakeSupabase();
    await searchPlaces(client as any, { city: "Aarhus" } as any);
    expect(calls.or).toContain("city.ilike.%Århus%");
    expect(calls.or).toContain("nearest_city.ilike.%Århus%");
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

// Only 2.3% of places carry a rating, and Postgres sorts NULLs FIRST on a DESC
// order -- so this query was returning 144,739 unrated places ahead of every
// rated one, in arbitrary order.
describe("searchPlaces ordering", () => {
  it("puts unrated places LAST, not first", async () => {
    const { client, calls } = fakeSupabase();
    await searchPlaces(client as any, {} as any);
    const rating = calls.orders.find(([c]) => c === "rating_avg");
    expect(rating, "expected an order on rating_avg").toBeTruthy();
    expect((rating![1] as { nullsFirst?: boolean })?.nullsFirst).toBe(false);
  });

  it("breaks the 97.7% tie with quality_score, not arbitrary order", () => {
    // quality_score correlates with having real content: the 85+ band is 81%
    // described, the 60-64 band is 0% described.
    const { client, calls } = fakeSupabase();
    return searchPlaces(client as any, {} as any).then(() => {
      const cols = calls.orders.map(([c]) => c);
      expect(cols).toContain("quality_score");
      // Rating must still win where it exists.
      expect(cols.indexOf("rating_avg")).toBeLessThan(cols.indexOf("quality_score"));
    });
  });

  it("does not let quality_score bring NULLs to the front either", async () => {
    const { client, calls } = fakeSupabase();
    await searchPlaces(client as any, {} as any);
    const q = calls.orders.find(([c]) => c === "quality_score");
    expect((q![1] as { nullsFirst?: boolean })?.nullsFirst).toBe(false);
  });
});
