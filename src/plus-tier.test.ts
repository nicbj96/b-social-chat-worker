import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveChatTier } from "./plus-tier";

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_KEY: "svc" };
const NOW = Date.parse("2026-10-05T12:00:00Z");
const rows = (r: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(r), { status }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("resolveChatTier", () => {
  it("null userId → free, fetch not called", async () => {
    const f = rows([]); vi.stubGlobal("fetch", f);
    expect(await resolveChatTier(env, null, NOW)).toBe("free");
    expect(f).not.toHaveBeenCalled();
  });
  it("empty list → free", async () => {
    vi.stubGlobal("fetch", rows([]));
    expect(await resolveChatTier(env, "u1", NOW)).toBe("free");
  });
  it("period_end in future → plus", async () => {
    vi.stubGlobal("fetch", rows([{ current_period_end: "2026-11-01T00:00:00Z" }]));
    expect(await resolveChatTier(env, "u1", NOW)).toBe("plus");
  });
  it("period_end in past → free", async () => {
    vi.stubGlobal("fetch", rows([{ current_period_end: "2026-09-01T00:00:00Z" }]));
    expect(await resolveChatTier(env, "u1", NOW)).toBe("free");
  });
  it("period_end null → plus", async () => {
    vi.stubGlobal("fetch", rows([{ current_period_end: null }]));
    expect(await resolveChatTier(env, "u1", NOW)).toBe("plus");
  });
  it("fetch error or 500 → free and logs plus_lookup_failed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    expect(await resolveChatTier(env, "u1", NOW)).toBe("free");
    vi.stubGlobal("fetch", rows({}, 500));
    expect(await resolveChatTier(env, "u1", NOW)).toBe("free");
    expect(log.mock.calls.filter((c) => String(c[0]).includes("plus_lookup_failed"))).toHaveLength(2);
  });
});
