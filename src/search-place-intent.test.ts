// Three review findings on the catalogue path, locked as tests.
//
// H1 — PLACE INTENT ONLY, NEVER THE NATIONAL TOP-N.
//   Measured live 2026-09-22 on the deployed build: the model's semantic_search
//   place half took the parsed `city` and ran the catalogue query with NO
//   category, so a question about a jazz CONCERT was answered with Aarhus'
//   best-rated cafes and restaurants — the top of a ranking the reader never
//   asked for, dressed up as an answer. Two rules follow from that:
//     * a query whose own intent is events-only must produce NO places, and
//     * an unfiltered catalogue query (no city, no category) is the national
//       top-N, which is an answer to nothing — it must not run.
//   "a query about a concert must not come back with the city's top places."
//
// M2 — EVERY 400 OUT OF /search CARRIES BOTH ARRAYS.
//   `events` and `places` are the contract (/soeg reads `sem.places[].id`), and
//   a 400 that omits them puts the caller back in the shape-guessing it took a
//   previous fix to remove.
//
// M3 — A FAILED SEARCH IS DISTINGUISHABLE FROM AN EMPTY ONE.
//   `[]` meant three different things: nothing matched, the query never ran,
//   and the backend threw. The model told the reader "no places found" for all
//   three. A coarse reason now travels with the empty array, to the caller of
//   /search and to the model that called the tool.
import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));

const { PLACE_ROWS, EVENT_ROWS } = vi.hoisted(() => ({
  PLACE_ROWS: [
    {
      id: "11111111-1111-4111-8111-111111111111",
      name: "Restaurant Aarhus",
      city: "Aarhus",
      nearest_city: null,
      region: "Midtjylland",
      categories: "mad-drikke",
      tags: null,
      rating: "4.5/5",
      facilities: "Ikke angivet",
    },
  ],
  EVENT_ROWS: [{ id: "33333333-3333-4333-8333-333333333333", title: "Jazz i Aarhus" }],
}));

vi.mock("./supabase-queries", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./supabase-queries")>()),
  createSupabaseClient: vi.fn(() => ({ __catalogueClient: true })),
  searchPlaces: vi.fn(async () => ({ results: PLACE_ROWS })),
}));

import { searchPlaces } from "./supabase-queries";
import worker from "./index";
import { __resetAiBreaker } from "./discovery-fallback";

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

/**
 * env.AI.run, split by model: the chat model plays the scripted turns, the
 * embedding model always answers with a vector. Every payload is recorded so a
 * test can read exactly what the MODEL was told — which is the only place a
 * tool result is observable.
 */
function environment(turns: unknown[] = []) {
  const seen: { model: string; input: any }[] = [];
  const script = [...turns];
  const run = vi.fn(async (model: string, input: any) => {
    seen.push({ model, input });
    if (String(model).includes("bge-m3")) return { data: [[0.1, 0.2, 0.3]] };
    return script.shift() ?? { response: "ok" };
  });
  const env = {
    AI: { run },
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_KEY: "test-service-key",
  } as any;
  /** The messages of the LAST chat-model call — i.e. what the model saw. */
  const lastModelMessages = () => {
    const calls = seen.filter((s) => s.input?.messages);
    return JSON.stringify(calls.at(-1)?.input?.messages ?? []);
  };
  return { env, run, seen, lastModelMessages };
}

function searchRequest(body: unknown, ip: string): Request {
  return new Request("https://worker.example/search", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify(body),
  });
}

function chatRequest(content: string, ip: string): Request {
  return new Request("https://worker.example/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json", "CF-Connecting-IP": ip },
    body: JSON.stringify({ messages: [{ role: "user", content }] }),
  });
}

/** Records every outbound URL, so a test can prove a route was NOT taken. */
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
  __resetAiBreaker();
  vi.mocked(searchPlaces).mockClear();
  vi.mocked(searchPlaces).mockResolvedValue({ results: PLACE_ROWS } as any);
});

describe("H1 — places run on place intent, never as a national top-N", () => {
  it("a concert question (kind=both) gets events and NOT the city's top places", async () => {
    const urls = installFetch();
    const response = await worker.fetch!(
      searchRequest({ query: "jazz koncert i Aarhus", kind: "both" }, "203.0.113.41"),
      environment().env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    // The events half still answers...
    expect(body.events.map((e: any) => e.id)).toEqual(["33333333-3333-4333-8333-333333333333"]);
    // ...and the place half is empty, not "Aarhus' best-rated cafes".
    expect(body.places).toEqual([]);
    expect(vi.mocked(searchPlaces)).not.toHaveBeenCalled();
    // The reason is legible to the caller, not left to be guessed.
    expect(body.places_skipped).toBe("no_place_intent");
    expect(urls.filter((u) => u.includes("match_places"))).toEqual([]);
  });

  it("a concert question (kind=places) does not become a city top-N either", async () => {
    installFetch();
    const response = await worker.fetch!(
      searchRequest({ query: "jazz koncert i Aarhus", kind: "places" }, "203.0.113.42"),
      environment().env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.places).toEqual([]);
    expect(body.places_skipped).toBe("no_place_intent");
    expect(vi.mocked(searchPlaces)).not.toHaveBeenCalled();
  });

  it("a place question with no city and no category never queries the whole country", async () => {
    installFetch();
    const response = await worker.fetch!(
      searchRequest({ query: "find et godt sted", kind: "places" }, "203.0.113.43"),
      environment().env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.places).toEqual([]);
    expect(body.places_skipped).toBe("no_city_or_category");
    expect(vi.mocked(searchPlaces)).not.toHaveBeenCalled();
  });

  it("still answers a real place question from the catalogue", async () => {
    installFetch();
    const response = await worker.fetch!(
      searchRequest({ query: "spisesteder Aarhus", kind: "places" }, "203.0.113.44"),
      environment().env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.places.map((p: any) => p.id)).toEqual(["11111111-1111-4111-8111-111111111111"]);
    expect(body.places_skipped).toBeUndefined();
    const args = vi.mocked(searchPlaces).mock.calls[0][1] as any;
    expect(args.city).toBe("Aarhus");
    expect(args.category).toBe("mad-drikke");
  });

  it("the model's semantic_search for a concert question returns no place_ids", async () => {
    installFetch();
    const model = environment([
      {
        response: "",
        tool_calls: [
          {
            id: "call_1",
            function: {
              name: "semantic_search",
              arguments: JSON.stringify({ query: "jazz koncert i Aarhus", city: "Aarhus", kind: "both" }),
            },
          },
        ],
      },
      { response: "Her er jazz i Aarhus." },
    ]);

    const response = await worker.fetch!(
      chatRequest("jazz koncert i Aarhus", "203.0.113.45"),
      model.env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.place_ids).toEqual([]);
    expect(body.event_ids).toEqual(["33333333-3333-4333-8333-333333333333"]);
    expect(vi.mocked(searchPlaces)).not.toHaveBeenCalled();
    // The model is told WHY the place half is empty, so it cannot narrate a
    // city top-8 that was never fetched.
    expect(model.lastModelMessages()).toContain("no_place_intent");
  });

  it("the catalogue safety net (AI down) never answers with the national top-N", async () => {
    installFetch();
    const model = environment();
    model.run.mockRejectedValue(new Error("Workers AI 500 upstream"));

    const response = await worker.fetch!(
      chatRequest("find et godt sted", "203.0.113.46"),
      model.env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.place_ids).toEqual([]);
    expect(vi.mocked(searchPlaces)).not.toHaveBeenCalled();
  });

  it("the model's search_places tool with no filter is not a country-wide top-N", async () => {
    installFetch();
    const model = environment([
      {
        response: "",
        tool_calls: [
          { id: "call_1", function: { name: "search_places", arguments: JSON.stringify({}) } },
        ],
      },
      { response: "Her er nogle steder." },
    ]);

    const response = await worker.fetch!(
      chatRequest("find nogle steder", "203.0.113.47"),
      model.env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.place_ids).toEqual([]);
    expect(vi.mocked(searchPlaces)).not.toHaveBeenCalled();
  });
});

describe("M2 — every 400 out of /search carries both arrays", () => {
  it("a missing query is a 400 that still has events and places arrays", async () => {
    installFetch();
    const response = await worker.fetch!(
      searchRequest({ kind: "places" }, "203.0.113.51"),
      environment().env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    const body: any = await response.json();
    expect(Array.isArray(body.events)).toBe(true);
    expect(Array.isArray(body.places)).toBe(true);
    expect(body.events).toEqual([]);
    expect(body.places).toEqual([]);
  });

  it("a whitespace-only query is a 400 that still has both arrays", async () => {
    installFetch();
    const response = await worker.fetch!(
      searchRequest({ query: "   ", kind: "both" }, "203.0.113.52"),
      environment().env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    const body: any = await response.json();
    expect(Array.isArray(body.events)).toBe(true);
    expect(Array.isArray(body.places)).toBe(true);
  });

  it("a body that is not JSON is the caller's 400, with both arrays", async () => {
    installFetch();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await worker.fetch!(
      new Request("https://worker.example/search", {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.53" },
        body: "{not-json",
      }),
      environment().env,
      executionContext(),
    );

    expect(response.status).toBe(400);
    const body: any = await response.json();
    expect(Array.isArray(body.events)).toBe(true);
    expect(Array.isArray(body.places)).toBe(true);
    err.mockRestore();
  });
});

describe("M3 — a failed search is distinguishable from an empty one", () => {
  it("reports a failed catalogue query as an empty array PLUS the reason", async () => {
    installFetch();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(searchPlaces).mockResolvedValue({
      results: [],
      error: "canceling statement due to statement timeout",
    } as any);

    const response = await worker.fetch!(
      searchRequest({ query: "spisesteder Aarhus", kind: "places" }, "203.0.113.61"),
      environment().env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.places).toEqual([]);
    expect(body.places_error).toBe("query_failed");
    err.mockRestore();
  });

  it("an empty result with no failure carries NO error marker", async () => {
    installFetch();
    vi.mocked(searchPlaces).mockResolvedValue({ results: [] } as any);

    const response = await worker.fetch!(
      searchRequest({ query: "spisesteder Aarhus", kind: "places" }, "203.0.113.62"),
      environment().env,
      executionContext(),
    );

    const body: any = await response.json();
    expect(body.places).toEqual([]);
    expect(body.places_error).toBeUndefined();
  });

  it("reports a failed events RPC as an empty array plus rpc_failed", async () => {
    installFetch({ eventsBody: TIMEOUT_57014 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await worker.fetch!(
      searchRequest({ query: "spisesteder Aarhus", kind: "both" }, "203.0.113.63"),
      environment().env,
      executionContext(),
    );

    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.events).toEqual([]);
    expect(body.events_error).toBe("rpc_failed");
    // ...and it does not take places down with it.
    expect(body.places.length).toBeGreaterThan(0);
    expect(body.places_error).toBeUndefined();
    err.mockRestore();
  });

  it("tells the model when a place search FAILED instead of 'no places found'", async () => {
    installFetch();
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(searchPlaces).mockResolvedValue({ results: [], error: "connection reset" } as any);
    const model = environment([
      {
        response: "",
        tool_calls: [
          {
            id: "call_1",
            function: {
              name: "semantic_search",
              arguments: JSON.stringify({ query: "spisesteder Aarhus", kind: "places" }),
            },
          },
        ],
      },
      { response: "Beklager, søgningen fejlede." },
    ]);

    const response = await worker.fetch!(chatRequest("Find spisesteder i Aarhus", "203.0.113.64"), model.env, executionContext());

    expect(response.status).toBe(200);
    expect(model.lastModelMessages()).toContain("places_error");
    err.mockRestore();
  });

  it("tells the model when an events search failed, and not when it was merely empty", async () => {
    installFetch({ eventsBody: TIMEOUT_57014 });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const failing = environment([
      {
        response: "",
        tool_calls: [
          {
            id: "call_1",
            function: {
              name: "semantic_search",
              arguments: JSON.stringify({ query: "jazz i Aarhus", city: "Aarhus", kind: "events" }),
            },
          },
        ],
      },
      { response: "Ingen events fundet." },
    ]);
    await worker.fetch!(chatRequest("jazz i Aarhus", "203.0.113.65"), failing.env, executionContext());
    expect(failing.lastModelMessages()).toContain("events_error");

    // Control: an EMPTY (not failed) result must not claim a failure.
    installFetch({ eventsBody: [] });
    const empty = environment([
      {
        response: "",
        tool_calls: [
          {
            id: "call_1",
            function: {
              name: "semantic_search",
              arguments: JSON.stringify({ query: "jazz i Aarhus", city: "Aarhus", kind: "events" }),
            },
          },
        ],
      },
      { response: "Ingen events fundet." },
    ]);
    await worker.fetch!(chatRequest("jazz i Aarhus", "203.0.113.66"), empty.env, executionContext());
    expect(empty.lastModelMessages()).not.toContain("events_error");
    err.mockRestore();
  });
});