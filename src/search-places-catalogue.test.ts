// /search must answer place queries from the catalogue, never from pgvector.
//
// MEASURED LIVE (public endpoint, project rbengtfrthqdfbcdcugp, 148,122 places):
//
//   POST /search {query:"spisesteder Aarhus", kind:"places"}
//     -> HTTP 200 in ~3.99s, and
//        places = {"code":"57014","message":"canceling statement due to
//                   statement timeout"}
//
// Two independent defects, and both are asserted here:
//
//   1. SHAPE. A failed PostgREST call was `await r.json()`-ed straight into the
//      response, so `places` came back as an error OBJECT where the contract
//      (and the /soeg frontend) expects an array. The frontend's Array.isArray
//      guard hid it, which is why nobody noticed the endpoint was broken.
//   2. PATH. `match_places` is a vector RPC over a table with NO vector index,
//      so it is a full scan that cannot finish inside anon's 3s
//      statement_timeout. It was the ONLY route to places, which is why place
//      search never worked.
//
// The catalogue path (filter first, rank on `id`, then fetch the wide columns
// by primary key -- the exact shape chat's searchPlaces already uses, and the
// shape places-search-phases.test.ts locks) answers the same query in tens of
// milliseconds. So places must come from there, and match_places must not be
// on the request path at all: waiting for it to time out is what costs 4s.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

// Known catalogue rows the place path must return.
const { PLACE_ROWS, EVENT_ROWS } = vi.hoisted(() => ({
  PLACE_ROWS: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Restaurant Aarhus",
      description: "Aarhus-spisested",
      city: "Aarhus",
      nearest_city: null,
      region: "Midtjylland",
      latitude: null,
      longitude: null,
      categories: "mad-drikke",
      tags: null,
      rating: "4.5/5",
      facilities: "Ikke angivet",
    },
    {
      id: "22222222-2222-4222-8222-222222222222",
      name: "Café Aarhus",
      description: null,
      city: "Aarhus",
      nearest_city: "Aarhus",
      region: "Midtjylland",
      latitude: null,
      longitude: null,
      categories: "mad-drikke",
      tags: null,
      rating: "Ingen rating endnu",
      facilities: "Ikke angivet",
    },
  ],
  EVENT_ROWS: [{ id: "33333333-3333-4333-8333-333333333333", title: "Jazz i Aarhus" }],
}));

// The catalogue surface. createSupabaseClient is replaced with a marker object
// so a real Supabase client can never be constructed in a unit test.
vi.mock("./supabase-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supabase-queries")>()),
  createSupabaseClient: vi.fn(() => ({ __catalogueClient: true })),
  searchPlaces: vi.fn(async () => ({ results: PLACE_ROWS })),
}));

import { searchPlaces } from "./supabase-queries";
import worker from "./index";

/** The exact body PostgREST returns when anon's statement_timeout fires. */
const TIMEOUT_57014 = {
  code: "57014",
  details: null,
  hint: null,
  message: "canceling statement due to statement timeout",
};

function executionContext(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext;
}

function environment(aiRun?: (...args: any[]) => any) {
  return {
    AI: { run: aiRun ?? vi.fn(async () => ({ data: [[0.1, 0.2, 0.3]] })) },
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_KEY: "test-service-key",
  } as any;
}

function searchRequest(body: unknown, ip: string): Request {
  return new Request("https://worker.example/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}

/**
 * Stub outbound HTTP. Records every URL so a test can prove a route was NOT
 * taken, and answers the RPCs the way production did: match_places with the
 * 57014 error object, match_events with real rows.
 */
function installFetch(opts: { eventsBody?: unknown } = {}) {
  const urls: string[] = [];
  const stub = vi.fn(async (input: any) => {
    const url = String(input);
    urls.push(url);
    const json = (payload: unknown, status = 200) =>
      new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
    if (url.includes("match_places")) return json(TIMEOUT_57014, 500);
    if (url.includes("match_events")) return json(opts.eventsBody ?? EVENT_ROWS);
    return json({});
  });
  vi.stubGlobal("fetch", stub);
  return urls;
}

beforeEach(() => {
  vi.mocked(searchPlaces).mockClear();
  vi.mocked(searchPlaces).mockResolvedValue({ results: PLACE_ROWS });
});

describe("POST /search — places are answered from the catalogue", () => {
  it("returns real place rows, never the 57014 error object", async () => {
    installFetch();
    const response = await worker.fetch!(
      searchRequest({ query: "spisesteder Aarhus", kind: "places" }, "203.0.113.11"),
      environment(),
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    // The contract the frontend keys on: arrays, always.
    expect(Array.isArray(body.places)).toBe(true);
    expect(Array.isArray(body.events)).toBe(true);
    // ...and real rows, not an error record.
    expect(body.places.map((p: any) => p.id)).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    expect(body.places[0].name).toBe("Restaurant Aarhus");
    expect(body.places).not.toHaveProperty("code");
  });

  it("derives the city and category the catalogue query needs", async () => {
    installFetch();
    await worker.fetch!(
      searchRequest({ query: "spisesteder Aarhus", kind: "places" }, "203.0.113.12"),
      environment(),
      executionContext(),
    );

    expect(vi.mocked(searchPlaces)).toHaveBeenCalledTimes(1);
    const args = vi.mocked(searchPlaces).mock.calls[0][1] as any;
    expect(args.city).toBe("Aarhus");
    expect(args.category).toBe("mad-drikke");
  });

  it("never calls match_places — the vector scan must not be on the request path", async () => {
    const urls = installFetch();
    const started = Date.now();
    const response = await worker.fetch!(
      searchRequest({ query: "spisesteder Aarhus", kind: "places" }, "203.0.113.13"),
      environment(),
      executionContext(),
    );
    const elapsed = Date.now() - started;

    expect(response.status).toBe(200);
    expect(urls.filter((u) => u.includes("match_places"))).toEqual([]);
    expect(Array.isArray((await response.json() as any).places)).toBe(true);
    // The stub answers match_places immediately, so this is not a timing test:
    // it is a guard that the request does not await a 57014 round trip at all.
    expect(elapsed).toBeLessThan(2000);
  });

  it("answers places even when Workers AI is down, because places need no embedding", async () => {
    installFetch();
    const aiRun = vi.fn().mockRejectedValue(new Error("Workers AI 500 upstream"));
    const response = await worker.fetch!(
      searchRequest({ query: "spisesteder Aarhus", kind: "places" }, "203.0.113.14"),
      environment(aiRun),
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(Array.isArray(body.places)).toBe(true);
    expect(body.places.length).toBeGreaterThan(0);
  });

  it("reports a failed catalogue query as an empty array, not as an object or a 5xx", async () => {
    installFetch();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(searchPlaces).mockResolvedValue({
      results: [],
      error: "canceling statement due to statement timeout",
    } as any);

    const response = await worker.fetch!(
      searchRequest({ query: "spisesteder Aarhus", kind: "places" }, "203.0.113.15"),
      environment(),
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.places).toEqual([]);
    expect(Array.isArray(body.events)).toBe(true);
    err.mockRestore();
  });
});

describe("POST /search — events keep the vector path, and the shape holds", () => {
  it("still returns vector-matched events for kind=events, and does not touch the place catalogue", async () => {
    const urls = installFetch();
    const response = await worker.fetch!(
      searchRequest({ query: "jazz i Aarhus", kind: "events" }, "203.0.113.16"),
      environment(),
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.events.map((e: any) => e.id)).toEqual(["33333333-3333-4333-8333-333333333333"]);
    expect(body.places).toEqual([]);
    expect(urls.filter((u) => u.includes("match_events")).length).toBe(1);
    expect(vi.mocked(searchPlaces)).not.toHaveBeenCalled();
  });

  it("returns arrays for kind=both even when the events RPC fails with 57014", async () => {
    installFetch({ eventsBody: TIMEOUT_57014 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await worker.fetch!(
      searchRequest({ query: "spisesteder Aarhus", kind: "both" }, "203.0.113.17"),
      environment(),
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    // A failed events RPC must not leak its error object into the payload.
    expect(body.events).toEqual([]);
    expect(Array.isArray(body.events)).toBe(true);
    // ...and must not take places down with it.
    expect(Array.isArray(body.places)).toBe(true);
    expect(body.places.length).toBeGreaterThan(0);
    err.mockRestore();
  });

  it("keeps both arrays present when the request itself throws", async () => {
    installFetch();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await worker.fetch!(
      new Request("https://worker.example/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.18" },
        body: "{not-json",
      }),
      environment(),
      executionContext(),
    );

    const body: any = await response.json();
    expect(Array.isArray(body.events)).toBe(true);
    expect(Array.isArray(body.places)).toBe(true);
    err.mockRestore();
  });
});

describe("POST /chat - the model's semantic_search tool answers places from the catalogue", () => {
  it("returns catalogue place_ids and never calls match_places", async () => {
    const urls = installFetch();
    // First model turn asks for a place search; the second answers with it.
    const aiRun = vi.fn()
      .mockResolvedValueOnce({
        response: "",
        tool_calls: [
          {
            id: "call_1",
            function: {
              name: "semantic_search",
              arguments: JSON.stringify({ query: "hyggeligt spisested", city: "Aarhus", kind: "places" }),
            },
          },
        ],
      })
      .mockResolvedValue({ response: "Her er to steder i Aarhus." });

    const response = await worker.fetch!(
      new Request("https://worker.example/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.30" },
        body: JSON.stringify({ messages: [{ role: "user", content: "Find spisesteder i Aarhus" }] }),
      }),
      environment(aiRun),
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.error).toBeUndefined();
    expect(urls.filter((u) => u.includes("match_places"))).toEqual([]);
    expect(body.place_ids).toEqual([
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222",
    ]);
    // The city the model passed is threaded into the catalogue filter.
    expect(vi.mocked(searchPlaces)).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ city: "Aarhus" }),
      8,
    );
  });
});
