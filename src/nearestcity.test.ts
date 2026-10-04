import { describe, expect, it, vi } from "vitest";
import { searchEvents, searchPlaces } from "./supabase-queries";

// 82.5% of places have no city (122,113 of 148,075, measured 2026-07-22), so
// filtering on `city` alone made four fifths of the catalogue unreachable by any
// city search. These assert the query asks for both columns.
//
// searchPlaces now runs in TWO phases (2026-09-21, statement-timeout fix): it
// ranks on `id` alone, then fetches the wide columns for the chosen ids by
// primary key. So this fake records each query separately, answers the id-only
// query with ids (otherwise no second phase would ever run) and answers the id
// fetch with rows. `calls` keeps exposing the RANKING query's filters and the
// FULL column list, which is what the assertions below are about.
const PLACE_IDS = ["p-1", "p-2"];
const PLACE_ROWS = [
  { id: "p-1", nearest_city: "Aarhus" },
  { id: "p-2", nearest_city: null },
];

function fakeSupabase() {
  type Rec = { or?: string; ilike?: [string, string]; select?: string; orders: [string, unknown][] };
  const queries: Rec[] = [];
  const from = () => {
    const rec: Rec = { orders: [] };
    queries.push(rec);
    const q: any = {
      select: (cols: string) => { rec.select = cols; return q; },
      order: (col: string, opts?: unknown) => { rec.orders.push([col, opts]); return q; },
      limit: () => q,
      contains: () => q,
      ilike: (col: string, val: string) => { rec.ilike = [col, val]; return q; },
      or: (expr: string) => { rec.or = expr; return q; },
      in: () => q,
      then: (res: (v: unknown) => unknown) =>
        rec.select === "id"
          ? res({ data: PLACE_IDS.map((id) => ({ id })), error: null })
          : res({ data: PLACE_ROWS, error: null }),
    };
    return q;
  };
  const ranking = () => queries[0];
  const fetch = () => queries[1];
  const calls = {
    get or() { return ranking()?.or; },
    get ilike() { return ranking()?.ilike; },
    get orders() { return ranking()?.orders ?? []; },
    get select() { return fetch()?.select ?? ranking()?.select; },
  };
  return { client: { from } as any, calls };
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

// Review 2026-09-21, blocker 3: searchEvents swapped ilike("location", ...) for
// an or() over two spellings on the four busiest cities, with no test. The fake
// client cannot validate PostgREST or() semantics, so this locks the SHAPE:
// both needles present for an aliased city, the single ilike kept for every
// other city, and nothing that would break the expression reaching the query.
function fakeEventsSupabase() {
  // Keep these assertions focused on city aliases; eligibility adds separate
  // ANDed or() clauses, exercised through the real SDK in event-eligibility.
  const ors: string[] = [];
  const calls: { or?: string; ilike?: [string, string] } = {
    get or() { return ors.find((expression) => expression.startsWith("location.")); },
    set or(expression) { if (expression) ors.push(expression); },
  };
  const q: any = {
    select: () => q,
    not: () => q,
    lt: () => q,
    gte: () => q,
    order: () => q,
    limit: () => q,
    eq: () => q,
    contains: () => q,
    overlaps: () => q,
    ilike: (col: string, val: string) => { calls.ilike = [col, val]; return q; },
    or: (expr: string) => { calls.or = expr; return q; },
    then: (res: (v: unknown) => unknown) => res({ data: [], error: null }),
  };
  return { client: { from: () => q }, calls };
}

describe("searchEvents city matching", () => {
  it("asks for both København and Copenhagen in one or()", async () => {
    const { client, calls } = fakeEventsSupabase();
    await searchEvents(client as any, { city: "København" } as any);
    expect(calls.or).toBeTruthy();
    expect(calls.or).toContain("location.ilike.%København%");
    expect(calls.or).toContain("location.ilike.%Copenhagen%");
    expect(calls.ilike).toBeUndefined(); // the or() replaces the single ilike
  });

  it("asks for both Aarhus and Århus whichever spelling the caller used", async () => {
    for (const city of ["Aarhus", "Århus"]) {
      const { client, calls } = fakeEventsSupabase();
      await searchEvents(client as any, { city } as any);
      expect(calls.or, city).toContain("location.ilike.%Aarhus%");
      expect(calls.or, city).toContain("location.ilike.%Århus%");
    }
  });

  it("asks for both Aalborg and Ålborg", async () => {
    const { client, calls } = fakeEventsSupabase();
    await searchEvents(client as any, { city: "Aalborg" } as any);
    expect(calls.or).toContain("location.ilike.%Aalborg%");
    expect(calls.or).toContain("location.ilike.%Ålborg%");
  });

  it("keeps a single ilike on location for a city with one spelling", async () => {
    const { client, calls } = fakeEventsSupabase();
    await searchEvents(client as any, { city: "Odense" } as any);
    expect(calls.ilike).toEqual(["location", "%Odense%"]);
    expect(calls.or).toBeUndefined();
  });

  it("never lets a stray comma, paren or percent reach the or() expression", async () => {
    const { client, calls } = fakeEventsSupabase();
    await searchEvents(client as any, { city: "Aar,hus)(%" } as any);
    const parts = String(calls.or).split(",");
    expect(parts).toHaveLength(2);
    expect(parts.every((p) => /^location\.ilike\.%.+%$/.test(p))).toBe(true);
    expect(calls.or).toContain("location.ilike.%Aarhus%");
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
