import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveChatTier } from "./plus-tier";

const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_KEY: "svc" };
const NOW = Date.parse("2026-10-05T12:00:00Z");
const rows = (r: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(r), { status }));

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("resolveChatTier", () => {
  it("null userId → free, fetch not called", async () => {
    const f = rows([]); vi.stubGlobal("fetch", f);
    expect(await resolveChatTier(env, null, null, NOW)).toBe("free");
    expect(f).not.toHaveBeenCalled();
  });
  it("empty list → free", async () => {
    vi.stubGlobal("fetch", rows([]));
    expect(await resolveChatTier(env, "u1", "jwt", NOW)).toBe("free");
  });
  it("period_end in future → plus", async () => {
    vi.stubGlobal("fetch", rows([{ current_period_end: "2026-11-01T00:00:00Z" }]));
    expect(await resolveChatTier(env, "u1", "jwt", NOW)).toBe("plus");
  });
  it("period_end in past → free", async () => {
    vi.stubGlobal("fetch", rows([{ current_period_end: "2026-09-01T00:00:00Z" }]));
    expect(await resolveChatTier(env, "u1", "jwt", NOW)).toBe("free");
  });
  it("period_end null → plus", async () => {
    vi.stubGlobal("fetch", rows([{ current_period_end: null }]));
    expect(await resolveChatTier(env, "u1", "jwt", NOW)).toBe("plus");
  });
  it("fetch error or 500 → free and logs plus_lookup_failed", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("boom"); }));
    expect(await resolveChatTier(env, "u1", "jwt", NOW)).toBe("free");
    vi.stubGlobal("fetch", rows({}, 500));
    expect(await resolveChatTier(env, "u1", "jwt", NOW)).toBe("free");
    expect(log.mock.calls.filter((c) => String(c[0]).includes("plus_lookup_failed"))).toHaveLength(2);
  });

  describe("credentials (RLS: select_own for authenticated, ALL for service_role)", () => {
    const hdr = (f: ReturnType<typeof rows>) => (f.mock.calls[0] as unknown as [string, { headers: Record<string, string> }])[1].headers;
    it("service key set → apikey + Bearer = service key (JWT ignored)", async () => {
      const f = rows([]); vi.stubGlobal("fetch", f);
      await resolveChatTier({ ...env, SUPABASE_KEY: "anon", SUPABASE_SERVICE_KEY: "svc-key" }, "u1", "jwt-1", NOW);
      expect(hdr(f)).toEqual({ apikey: "svc-key", Authorization: "Bearer svc-key" });
    });
    it("no service key, user JWT → apikey = anon, Bearer = user JWT, user_id filter kept", async () => {
      const f = rows([{ current_period_end: null }]); vi.stubGlobal("fetch", f);
      expect(await resolveChatTier({ ...env, SUPABASE_KEY: "anon" }, "u1", "jwt-1", NOW)).toBe("plus");
      expect(hdr(f)).toEqual({ apikey: "anon", Authorization: "Bearer jwt-1" });
      expect(String((f.mock.calls[0] as unknown[])[0])).toContain("user_id=eq.u1");
    });
    it("anon only, no JWT → free, no fetch, logs no_credentials", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const f = rows([{ current_period_end: null }]); vi.stubGlobal("fetch", f);
      expect(await resolveChatTier({ ...env, SUPABASE_KEY: "anon" }, "u1", null, NOW)).toBe("free");
      expect(f).not.toHaveBeenCalled();
      expect(log.mock.calls.some((c) => String(c[0]).includes("plus_lookup_failed") && String(c[0]).includes("no_credentials"))).toBe(true);
    });
  });
});
