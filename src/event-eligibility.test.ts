import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ DurableObject: class {} }));
import worker from "./index";
import { __resetAiBreaker } from "./discovery-fallback";

const NOW = "2026-10-04T12:00:00.000Z";
const event = (overrides: Record<string, unknown> = {}) => ({
  id: "event-1", title: "Verificeret koncert", location: "Lausanne", country: "CH",
  date: "2026-10-25T18:30:00+01:00", end_date: null, all_day: false,
  status: "active", price: null, source: "catalogue", url: "https://organizer.example/event-1",
  ...overrides,
});
let ip = 0;

beforeEach(() => {
  __resetAiBreaker();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

// Strict PostgREST boundary fixture: emitted filters BEFORE sort/cap/projection.
// This exercises the SDK URL, not live PostgreSQL.
function splitTerms(expression: string): string[] {
  let depth = 0, start = 0;
  const terms: string[] = [];
  for (let i = 0; i < expression.length; i++) {
    if (expression[i] === "(") depth++;
    if (expression[i] === ")") depth--;
    if (expression[i] === "," && depth === 0) { terms.push(expression.slice(start, i)); start = i + 1; }
  }
  return [...terms, expression.slice(start)];
}
function matches(row: Record<string, any>, expression: string): boolean {
  for (const junction of ["and", "or"]) {
    if (expression.startsWith(`${junction}(`)) {
      const terms = splitTerms(expression.slice(junction.length + 1, -1));
      return junction === "and" ? terms.every((term) => matches(row, term)) : terms.some((term) => matches(row, term));
    }
  }
  const [column, operator, ...parts] = expression.split(".");
  const value = parts.join(".");
  if (operator === "not") return !matches(row, `${column}.${value}`);
  if (operator === "is" && value === "null") return row[column] == null;
  if (row[column] == null) return false;
  if (operator === "eq") return row[column] === value;
  if (operator === "ilike") return String(row[column]).toLowerCase().includes(value.replaceAll("%", "").toLowerCase());
  const left = Date.parse(row[column]), right = Date.parse(value);
  if (operator === "gte") return left >= right;
  if (operator === "gt") return left > right;
  if (operator === "lt") return left < right;
  throw new Error(`Unsupported fixture predicate: ${expression}`);
}
function serveEvents(url: URL, rows: ReturnType<typeof event>[]) {
  const eligible = rows.filter((row) => [...url.searchParams].every(([key, value]) => {
    if (["select", "order", "limit"].includes(key)) return true;
    return matches(row, key === "or" || key === "and" ? `${key}${value}` : `${key}.${value}`);
  }));
  eligible.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.id.localeCompare(b.id));
  const columns = url.searchParams.get("select")!.split(",").map((column) => column.trim());
  return eligible.slice(0, Number(url.searchParams.get("limit"))).map((row: any) =>
    Object.fromEntries(columns.map((column) => [column, row[column]])));
}

// Exercise the real /chat handler -> searchEvents -> Supabase SDK -> tool message.
// Only network/model boundaries are substituted; never mock searchEvents itself.
async function chatEvents(rows: ReturnType<typeof event>[], args: Record<string, unknown> = {}) {
  const queries: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === "/rest/v1/events") {
      queries.push(url);
      return Response.json(serveEvents(url, rows));
    }
    return Response.json([]);
  }));
  let toolResult: any;
  const run = vi.fn(async (_model: string, payload: any) => {
    const tool = payload.messages.find((message: any) => message.role === "tool");
    if (tool) {
      toolResult = JSON.parse(tool.content);
      return { response: "Her er de verificerede arrangementer." };
    }
    return { tool_calls: [{ id: "events", function: { name: "search_events", arguments: JSON.stringify(args) } }] };
  });
  const response = await worker.fetch!(new Request("https://worker.example/chat", {
    method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": `203.0.113.${++ip}` },
    body: JSON.stringify({ messages: [{ role: "user", content: "Find koncerter" }] }),
  }), { AI: { run }, SUPABASE_URL: "https://fixture.supabase.co", SUPABASE_KEY: "test-key" } as any,
  { waitUntil: vi.fn(), passThroughOnException: vi.fn(), props: {} } as unknown as ExecutionContext);
  expect(response.status).toBe(200);
  return { result: toolResult, body: await response.json() as any, queries, run };
}

describe("search_events facts through the /chat caller", () => {
  it.each([
    [null, "Pris ukendt"], [undefined, "Pris ukendt"], [0, "Gratis"],
    [45.5, "45.5 (valuta ukendt)"], [-1, "Pris ukendt"], ["0", "Pris ukendt"],
  ])("price %s is never coerced into a free ticket or guessed currency", async (price, label) => {
    const { result } = await chatEvents([event({ price })]);
    expect(result.results[0].price).toBe(label);
    expect(result.results[0].price_amount).toBe(price ?? null);
    expect(result.results[0].currency).toBeNull();
  });

  it("keeps raw date, amount, status and provenance without selecting nonexistent columns", async () => {
    const row = event({ price: 45.5, end_date: "2026-10-25T21:00:00+01:00" });
    const { result, body, queries } = await chatEvents([row]);
    expect(body.event_ids).toEqual([row.id]);
    expect(result.results[0]).toMatchObject({
      date_raw: row.date, end_date: row.end_date, all_day: false,
      price_amount: 45.5, currency: null, timezone: null,
      status: "active", country: "CH", source: row.source, url: row.url,
    });
    const selected = queries[0].searchParams.get("select")!.split(",").map((column) => column.trim());
    expect(selected).toEqual(expect.arrayContaining(["date", "end_date", "all_day", "status", "price", "country", "source", "url"]));
    expect(selected).not.toContain("currency");
    expect(selected).not.toContain("timezone");
  });

  it("labels the UTC display and unknown event timezone instead of assigning Copenhagen worldwide", async () => {
    const { result } = await chatEvents([event({ country: "US", date: "2026-10-25T17:30:00Z" })]);
    expect(result.results[0].date).toContain("17.30");
    expect(result.results[0].date).toContain("UTC");
    expect(result.results[0].date).toContain("lokal tidszone ukendt");
    expect(result.results[0].timezone).toBeNull();
  });

  it.each([event({ all_day: true }), event({ date: "2026-10-25T00:00:00Z" })])(
    "does not invent a clock time for all-day or midnight-sentinel events", async (row) => {
      const { result } = await chatEvents([row]);
      expect(result.results[0].date).not.toMatch(/\d{2}[.:]\d{2}/);
      expect(result.results[0].date_raw).toBe(row.date);
    },
  );
});

describe("search_events eligibility before the server cap", () => {
  it("does not let cancelled, ended or undated rows consume the eight eligible slots", async () => {
    const rows = [
      ...Array.from({ length: 10 }, (_, i) => event({ id: `cancelled-${i}`, status: "cancelled", date: "2026-10-05T10:00:00Z" })),
      ...Array.from({ length: 10 }, (_, i) => event({ id: `ended-${i}`, date: "2026-10-05T10:00:00Z", end_date: "2026-10-04T11:00:00Z" })),
      event({ id: "undated", date: null, end_date: "2026-10-08T10:00:00Z" }),
      event({ id: "active" }), event({ id: "legacy-null-status", status: null }),
      event({ id: "draft", status: "draft" }),
    ];
    const { body, queries } = await chatEvents(rows);
    expect(body.event_ids).toEqual(["active", "legacy-null-status"]);
    expect(queries).toHaveLength(1);
    expect(queries[0].searchParams.get("limit")).toBe("8");
    expect(queries[0].searchParams.get("order")).toBe("date.asc,id.asc");
    expect(queries[0].searchParams.getAll("or").join(" ")).toContain("status.eq.active,status.is.null");
  });

  it("includes known ongoing events but never assumes a past unknown-end event is still running", async () => {
    const { body } = await chatEvents([
      event({ id: "ongoing", date: "2026-10-04T10:00:00Z", end_date: "2026-10-04T14:00:00Z" }),
      event({ id: "ended-at-now", date: "2026-10-04T10:00:00Z", end_date: NOW }),
      event({ id: "unknown-end-past", date: "2026-10-04T11:59:59Z" }),
      event({ id: "unknown-end-now", date: NOW }),
    ]);
    expect(body.event_ids).toEqual(["ongoing", "unknown-end-now"]);
  });

  it("applies the offset-qualified half-open date window before cap, including overlaps", async () => {
    const { body, queries } = await chatEvents([
      ...Array.from({ length: 10 }, (_, i) => event({ id: `early-${i}`, date: "2026-10-25T00:00:00Z" })),
      event({ id: "overlap", date: "2026-10-24T23:00:00Z", end_date: "2026-10-25T01:30:00Z" }),
      event({ id: "lower", date: "2026-10-25T01:00:00Z" }),
      event({ id: "upper", date: "2026-10-25T02:00:00Z" }),
    ], { date_from: "2026-10-25T02:00:00+01:00", date_to: "2026-10-25T03:00:00+01:00" });
    expect(body.event_ids).toEqual(["overlap", "lower"]);
    expect(queries[0].searchParams.getAll("date")).toContain("not.is.null");
    expect(queries[0].searchParams.getAll("date")).toContain("lt.2026-10-25T02:00:00.000Z");
    expect(queries[0].searchParams.getAll("or").join(" ")).toContain("2026-10-25T01:00:00.000Z");
  });

  it("ANDs location aliases with status and date eligibility, never ORs them together", async () => {
    const { body } = await chatEvents([
      event({ id: "cancelled-local", status: "cancelled", location: "Aarhus" }),
      event({ id: "remote", location: "Berlin" }),
      event({ id: "local", location: "Århus" }),
    ], { city: "Aarhus" });
    expect(body.event_ids).toEqual(["local"]);
  });

  it.each([
    { date_from: "2026-10-25" }, { date_to: "2026-10-25T03:00:00" },
    { date_from: "bad),(status.eq.cancelled" }, { date_from: 42 },
    { date_from: "2027-02-29T00:00:00Z" }, { date_from: "2026-10-25T24:00:00Z" },
    { date_from: "2026-10-26T00:00:00Z", date_to: "2026-10-25T00:00:00Z" },
    { timezone: "Mars/Olympus" },
  ])("rejects ambiguous or invalid time arguments without an unfiltered query: %j", async (args) => {
    const { result, queries } = await chatEvents([event()], args);
    expect(result.results).toEqual([]);
    expect(result.error).toBeTruthy();
    expect(queries).toEqual([]);
  });

  it.each([
    ["2026-10-25T00:30:00Z", "02.30"], ["2026-10-25T01:30:00Z", "02.30"],
  ])("uses requested display timezone across DST without calling it the event timezone", async (date, clock) => {
    const { result } = await chatEvents([event({ date })], { timezone: "Europe/Copenhagen" });
    expect(result.results[0].date).toContain(clock);
    expect(result.results[0].date).toContain("Europe/Copenhagen");
    expect(result.results[0].timezone).toBeNull();
    expect(result.results[0].date_raw).toBe(date);
  });
});
