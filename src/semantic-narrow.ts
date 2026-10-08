import type { DateWindow } from "./date-window";

type Box = { n: number; s: number; e: number; w: number };
const R = 6371;
function km(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Keep semantic hits inside the asked city (25 km of its centre) and date window. */
export function narrowSemanticEvents<T extends Record<string, any>>(rows: T[], box: Box | null, window: DateWindow | null | undefined, radiusKm = 25): T[] {
  const cLat = box ? (box.n + box.s) / 2 : null, cLng = box ? (box.e + box.w) / 2 : null;
  const from = window ? Date.parse(window.from) : NaN, to = window ? Date.parse(window.to) : NaN;
  return rows.filter(r => {
    if (cLat !== null && cLng !== null) {
      // Rows without coordinates already passed the RPC's bbox filter; only a
      // row that is demonstrably far from the city is dropped.
      const lat = Number(r.latitude), lng = Number(r.longitude);
      if (r.latitude != null && r.longitude != null && Number.isFinite(lat) && Number.isFinite(lng) && km(cLat, cLng, lat, lng) > radiusKm) return false;
    }
    if (Number.isFinite(from) && Number.isFinite(to)) {
      const t = Date.parse(String(r.date ?? ""));
      if (!Number.isFinite(t) || t < from || t >= to) return false;
    }
    return true;
  });
}
