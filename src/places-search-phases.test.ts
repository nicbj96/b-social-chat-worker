// Regression: places search hit Postgres' statement timeout in production.
//
// Measured live 2026-09-21 against project rbengtfrthqdfbcdcugp (148,122 places),
// role anon, statement_timeout = 3s:
//
//   POST /search {query:"spisesteder Aarhus", kind:"places"}  -> 57014 in ~3.9s
//   /chat "Find spisesteder i Aarhus"                          -> place_ids []
//   the worker's own query, category + city:
//       FULL column list (description + metadata jsonb)        -> 5,994 ms, 57014
//       same query, id column only                             ->    36 ms
//       same query, narrow columns only                        ->    37 ms
//
// The bitmap/index work is identical in both cases (the same 6,485 heap blocks).
// What costs six seconds is materialising the WIDE tuple - description and the
// metadata JSONB - for every row the ORDER BY has to consider before it can keep
// the best 8. So the fix is to order on `id` alone and fetch the wide columns for
// the 8 chosen rows by primary key.
//
// These tests lock the SHAPE (which columns each query asks for, in which order,
// and what happens when either query fails). The fake client cannot measure
// Postgres; the timings above are the production evidence.
import { describe, expect, it, vi } from "vitest";
import { searchPlaces } from "./supabase-queries";

type Rec = {
  select?: string;
  orders: [string, { ascending?: boolean; nullsFirst?: boolean }][];
  or?: string;
  in?: [string, string[]];
};

const ROW_A = { id: "p-a", name: "Restaurant A", city: "Aarhus", nearest_city: null, region: null, main_categories: ["mad-drikke"], tags: null, rating_avg: 4.5, metadata: { facilities: ["Toilet"] } };
const ROW_B = { id: "p-b", name: "Restaurant B", city: "Aarhus", nearest_city: "Aarhus", region: null, main_categories: ["mad-drikke"], tags: null, rating_avg: null, metadata: null };

/** Records every query the function builds, with per-phase responses. */
function fake(opts: { ids?: string[]; rows?: any[]; idError?: unknown; fetchError?: unknown } = {}) {
  const queries: Rec[] = [];
  const from = () => {
    const rec: Rec = { orders: [] };
    queries.push(rec);
    const q: any = {
      select: (cols: string) => { rec.select = cols; return q; },
      order: (col: string, o: any) => { rec.orders.push([col, o]); return q; },
      limit: () => q,
      contains: () => q,
      overlaps: () => q,
      eq: () => q,
      or: (e: string) => { rec.or = e; return q; },
      in: (col: string, vals: string[]) => { rec.in = [col, vals]; return q; },
      then: (res: (v: unknown) => unknown) =>
        rec.select === "id"
          ? res({ data: (opts.ids ?? []).map((id) => ({ id })), error: opts.idError ?? null })
          : res({ data: opts.rows ?? [], error: opts.fetchError ?? null }),
    };
    return q;
  };
  return { client: { from } as any, queries };
}

const orders = (rec: Rec) => rec.orders;

describe("searchPlaces ranking query — narrow then fetch", () => {
  it("orders on the id column only, so the sort never materialises the wide tuple", async () => {
    const { client, queries } = fake({ ids: [] });
    await searchPlaces(client, { city: "Aarhus" });

    expect(queries).toHaveLength(1);
    expect(queries[0].select).toBe("id");
    // The ranking itself is unchanged: rating first, then quality, NULLs last.
    expect(orders(queries[0])).toEqual([
      ["rating_avg", { ascending: false, nullsFirst: false }],
      ["quality_score", { ascending: false, nullsFirst: false }],
    ]);
    // ...and the filters that must narrow it are still on that query.
    expect(queries[0].or).toContain("city.ilike.%Aarhus%");
  });

  it("fetches the wide columns for the chosen ids by primary key", async () => {
    const { client, queries } = fake({ ids: ["p-a", "p-b"], rows: [ROW_A, ROW_B] });
    const result = await searchPlaces(client, {});

    expect(queries).toHaveLength(2);
    expect(queries[1].select).toContain("metadata");
    expect(queries[1].select).toContain("description");
    expect(queries[1].select).toContain("nearest_city");
    expect(queries[1].select).toContain("latitude");
    expect(queries[1].select).toContain("longitude");
    expect(queries[1].in).toEqual(["id", ["p-a", "p-b"]]);
    expect(result.results.map((r: any) => r.id)).toEqual(["p-a", "p-b"]);
  });

  it("restores the ranking order when the id fetch comes back in another order", async () => {
    const { client } = fake({ ids: ["p-a", "p-b"], rows: [ROW_B, ROW_A] });
    const result = await searchPlaces(client, {});
    expect(result.results.map((r: any) => r.id)).toEqual(["p-a", "p-b"]);
  });

  it("does not spend a second query when the first found no rows", async () => {
    const { client, queries } = fake({ ids: [] });
    const result = await searchPlaces(client, {});
    expect(queries).toHaveLength(1);
    expect(result.results).toEqual([]);
  });

  it("reports a failed ranking query instead of pretending there were no places", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client, queries } = fake({ idError: { message: "canceling statement due to statement timeout" } });
    const result = await searchPlaces(client, {});
    expect(result.results).toEqual([]);
    expect(result.error).toContain("statement timeout");
    expect(queries).toHaveLength(1);
    err.mockRestore();
  });

  it("reports a failed id fetch instead of returning a silently short list", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const { client } = fake({ ids: ["p-a"], fetchError: { message: "connection reset" } });
    const result = await searchPlaces(client, {});
    expect(result.results).toEqual([]);
    expect(result.error).toContain("connection reset");
    err.mockRestore();
  });
});
