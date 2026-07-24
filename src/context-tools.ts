// Context-aware planning helpers for the chat assistant.
//
// Two capabilities the grounded assistant lacked: a rough TRAVEL-TIME estimate
// (great-circle distance → minutes, for "is this nearby" and multi-stop evening
// plans) and a WEATHER lookup for outdoor events (open-meteo, free and keyless).
// The pure functions are unit-tested; the one network call is isolated behind an
// injected fetch so the caller passes the SSRF-guarded fetch and tests pass a stub.

const R_KM = 6371;
const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle (straight-line) distance in km between two lat/lng points. */
export function haversineKm(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(s)));
}

export type TravelMode = "walk" | "bike" | "transit" | "car";
const MODE_KMH: Record<TravelMode, number> = { walk: 4.5, bike: 14, transit: 20, car: 35 };
// Straight-line underestimates the real path; 1.3 is a common urban detour factor.
const DETOUR = 1.3;

export function normalizeMode(mode: unknown): TravelMode {
  return mode === "walk" || mode === "bike" || mode === "car" ? mode : "transit";
}

/** Rough door-to-door minutes for a straight-line distance. A deliberate estimate. */
export function estimateTravelMinutes(km: number, mode: TravelMode): number {
  const kmh = MODE_KMH[mode] ?? MODE_KMH.transit;
  return Math.max(1, Math.round(((km * DETOUR) / kmh) * 60));
}

export function isValidLatLng(lat: unknown, lng: unknown): boolean {
  return (
    typeof lat === "number" && Number.isFinite(lat) && lat >= -90 && lat <= 90 &&
    typeof lng === "number" && Number.isFinite(lng) && lng >= -180 && lng <= 180
  );
}

/** WMO weather code → short Danish description. */
export function weatherCodeToDanish(code: unknown): string {
  const c = typeof code === "number" ? code : -1;
  if (c === 0) return "klart";
  if (c === 1 || c === 2) return "let skyet";
  if (c === 3) return "overskyet";
  if (c === 45 || c === 48) return "tåget";
  if (c >= 51 && c <= 57) return "støvregn";
  if (c >= 61 && c <= 67) return "regn";
  if (c >= 71 && c <= 77) return "sne";
  if (c >= 80 && c <= 82) return "regnbyger";
  if (c >= 85 && c <= 86) return "snebyger";
  if (c >= 95) return "tordenvejr";
  return "ukendt";
}

export interface WeatherResult {
  date: string;
  description: string;
  temp_max_c?: number;
  temp_min_c?: number;
  precip_probability_pct?: number;
  wind_max_kmh?: number;
}

/**
 * One-day forecast from open-meteo (free, no API key). Returns null when the date
 * is malformed, out of the ~16-day forecast horizon, or the service is down —
 * callers must degrade gracefully, never invent weather. `fetchImpl` is injected
 * so production passes the SSRF-guarded fetch and tests pass a stub.
 */
export async function fetchWeather(
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response | null>,
  lat: number,
  lng: number,
  date: string,
): Promise<WeatherResult | null> {
  if (!isValidLatLng(lat, lng) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max` +
    `&start_date=${date}&end_date=${date}&timezone=auto`;
  let res: Response | null;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
  } catch {
    return null;
  }
  if (!res || !res.ok) return null;
  let data: unknown;
  try { data = await res.json(); } catch { return null; }
  const d = (data as { daily?: Record<string, unknown[]> })?.daily;
  if (!d || !Array.isArray(d.time) || d.time.length === 0) return null;
  const num = (arr: unknown): number | undefined => {
    const v = Array.isArray(arr) ? arr[0] : undefined;
    return typeof v === "number" ? v : undefined;
  };
  return {
    date,
    description: weatherCodeToDanish(Array.isArray(d.weather_code) ? d.weather_code[0] : undefined),
    temp_max_c: num(d.temperature_2m_max),
    temp_min_c: num(d.temperature_2m_min),
    precip_probability_pct: num(d.precipitation_probability_max),
    wind_max_kmh: num(d.wind_speed_10m_max),
  };
}
