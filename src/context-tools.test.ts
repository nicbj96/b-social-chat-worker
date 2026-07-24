import { describe, it, expect } from "vitest";
import {
  haversineKm,
  estimateTravelMinutes,
  weatherCodeToDanish,
  isValidLatLng,
  normalizeMode,
  fetchWeather,
} from "./context-tools";

describe("haversineKm", () => {
  it("is ~0 for the same point", () => {
    expect(haversineKm(55.68, 12.57, 55.68, 12.57)).toBeCloseTo(0, 5);
  });
  it("matches a known distance (Copenhagen → Aarhus ≈ 187 km)", () => {
    const km = haversineKm(55.6761, 12.5683, 56.1629, 10.2039);
    expect(km).toBeGreaterThan(150);
    expect(km).toBeLessThan(220);
  });
  it("is symmetric", () => {
    const a = haversineKm(55.6, 12.5, 57.0, 9.9);
    const b = haversineKm(57.0, 9.9, 55.6, 12.5);
    expect(a).toBeCloseTo(b, 6);
  });
});

describe("estimateTravelMinutes", () => {
  it("scales with distance and is slower on foot than by car", () => {
    expect(estimateTravelMinutes(10, "walk")).toBeGreaterThan(estimateTravelMinutes(10, "car"));
  });
  it("returns at least 1 minute for a tiny distance", () => {
    expect(estimateTravelMinutes(0, "walk")).toBeGreaterThanOrEqual(1);
  });
  it("gives a sane transit estimate for 6 km (roughly 20-30 min incl. detour)", () => {
    const m = estimateTravelMinutes(6, "transit");
    expect(m).toBeGreaterThan(15);
    expect(m).toBeLessThan(35);
  });
});

describe("normalizeMode", () => {
  it("passes through valid modes and defaults the rest to transit", () => {
    expect(normalizeMode("walk")).toBe("walk");
    expect(normalizeMode("car")).toBe("car");
    expect(normalizeMode("teleport")).toBe("transit");
    expect(normalizeMode(undefined)).toBe("transit");
  });
});

describe("weatherCodeToDanish", () => {
  it("maps representative WMO codes", () => {
    expect(weatherCodeToDanish(0)).toBe("klart");
    expect(weatherCodeToDanish(3)).toBe("overskyet");
    expect(weatherCodeToDanish(63)).toBe("regn");
    expect(weatherCodeToDanish(95)).toBe("tordenvejr");
    expect(weatherCodeToDanish("x")).toBe("ukendt");
  });
});

describe("isValidLatLng", () => {
  it("accepts real coordinates and rejects junk / out-of-range", () => {
    expect(isValidLatLng(55.6, 12.5)).toBe(true);
    expect(isValidLatLng(0, 0)).toBe(true);
    expect(isValidLatLng(91, 0)).toBe(false);
    expect(isValidLatLng(0, 181)).toBe(false);
    expect(isValidLatLng("55", 12)).toBe(false);
    expect(isValidLatLng(NaN, 12)).toBe(false);
  });
});

describe("fetchWeather", () => {
  const ok = (body: unknown) =>
    ({ ok: true, json: async () => body } as unknown as Response);

  it("returns null for a malformed date without calling the network", async () => {
    let called = false;
    const r = await fetchWeather(async () => { called = true; return ok({}); }, 55, 12, "not-a-date");
    expect(r).toBeNull();
    expect(called).toBe(false);
  });

  it("returns null for invalid coordinates", async () => {
    const r = await fetchWeather(async () => ok({}), 999, 12, "2026-08-01");
    expect(r).toBeNull();
  });

  it("returns null when the daily series is empty (date beyond the forecast horizon)", async () => {
    const r = await fetchWeather(async () => ok({ daily: { time: [] } }), 55, 12, "2026-08-01");
    expect(r).toBeNull();
  });

  it("parses a one-day forecast into a Danish-described result", async () => {
    const body = {
      daily: {
        time: ["2026-08-01"],
        weather_code: [63],
        temperature_2m_max: [19.4],
        temperature_2m_min: [12.1],
        precipitation_probability_max: [80],
        wind_speed_10m_max: [22],
      },
    };
    const r = await fetchWeather(async () => ok(body), 55.68, 12.57, "2026-08-01");
    expect(r).not.toBeNull();
    expect(r!.description).toBe("regn");
    expect(r!.temp_max_c).toBe(19.4);
    expect(r!.precip_probability_pct).toBe(80);
  });

  it("returns null (never throws) when fetch fails", async () => {
    const r = await fetchWeather(async () => { throw new Error("network down"); }, 55, 12, "2026-08-01");
    expect(r).toBeNull();
  });

  it("returns null when the guarded fetch blocks the host (null response)", async () => {
    const r = await fetchWeather(async () => null, 55, 12, "2026-08-01");
    expect(r).toBeNull();
  });
});
