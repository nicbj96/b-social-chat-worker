import type { DateWindow } from "./date-window";

type Box = { n: number; s: number; e: number; w: number };
const R = 6371;
function km(aLat: number, aLng: number, bLat: number, bLng: number): number {
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Keep semantic hits inside the asked city (25 km of its centre) and date window. */
const fold = (v: unknown) => String(v ?? "").toLocaleLowerCase("da-DK").normalize("NFD").replace(/\p{M}/gu, "").replace(/aa/g, "a").replace(/ø/g, "o").replace(/æ/g, "ae");
const CITY_ALIASES: Record<string, string[]> = { kobenhavn: ["kobenhavn", "copenhagen", "frederiksberg"], arhus: ["arhus", "aarhus"] };

export function narrowSemanticEvents<T extends Record<string, any>>(rows: T[], box: Box | null, window: DateWindow | null | undefined, radiusKm = 25, cityName?: string): T[] {
  const cityKey = cityName ? fold(cityName) : "";
  const names = cityKey ? (CITY_ALIASES[cityKey] ?? [cityKey]) : [];
  const cLat = box ? (box.n + box.s) / 2 : null, cLng = box ? (box.e + box.w) / 2 : null;
  const from = window ? Date.parse(window.from) : NaN, to = window ? Date.parse(window.to) : NaN;
  return rows.filter(r => {
    if (cLat !== null && cLng !== null) {
      // Rows without coordinates already passed the RPC's bbox filter; only a
      // row that is demonstrably far from the city is dropped.
      const lat = Number(r.latitude), lng = Number(r.longitude);
      const hasCoords = r.latitude != null && r.longitude != null && Number.isFinite(lat) && Number.isFinite(lng);
      if (hasCoords && km(cLat, cLng, lat, lng) > radiusKm) return false;
      // No coordinates: only keep it when its own address names the city
      // (a coordless "Kerteminde" row must not answer "jazz i København").
      if (!hasCoords && names.length > 0) {
        const where = fold(`${r.location ?? ""} ${r.title ?? ""}`);
        if (!names.some(n => where.includes(n))) return false;
      }
    }
    if (Number.isFinite(from) && Number.isFinite(to)) {
      const t = Date.parse(String(r.date ?? ""));
      if (!Number.isFinite(t) || t < from || t >= to) return false;
    }
    return true;
  });
}

/** "tirsdag den 20. oktober 2026 kl. 20.00" in Europe/Copenhagen; "" when not a date. */
export function danishWhen(iso: unknown): string {
  if (typeof iso !== "string" || !Number.isFinite(Date.parse(iso))) return "";
  const d0 = new Date(iso);
  // Midnight UTC is the importer's "date only" sentinel: never invent 02:00.
  if (d0.getUTCHours() === 0 && d0.getUTCMinutes() === 0) {
    const p0 = new Intl.DateTimeFormat("da-DK", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" }).formatToParts(d0);
    const g0 = (t: string) => p0.find(p => p.type === t)?.value ?? "";
    return `${g0("weekday")} den ${g0("day")}. ${g0("month")} ${g0("year")} (tidspunkt ukendt)`;
  }
  const parts = new Intl.DateTimeFormat("da-DK", { timeZone: "Europe/Copenhagen", weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(iso));
  const g = (t: string) => parts.find(p => p.type === t)?.value ?? "";
  return `${g("weekday")} den ${g("day")}. ${g("month")} ${g("year")} kl. ${g("hour").padStart(2, "0")}.${g("minute")}`;
}

/** Semantic RPC rows carry a raw UTC date; give the model the reader's local time and keep the raw value for grounding. */
export function localizeSemanticRow<T extends Record<string, any>>(row: T): T {
  if (row.date_raw !== undefined) return row;
  const when = danishWhen(row.date);
  return when ? { ...row, date_raw: row.date, date: when } : row;
}

/** Rows that actually match a genre the reader named (title/description/tags). */
export function matchesTopic(row: Record<string, any>, topic: string): boolean {
  const t = fold(topic);
  if (!t) return true;
  const tags = Array.isArray(row.interest_tags) ? row.interest_tags.join(" ") : String(row.tags ?? "");
  return fold(`${row.title ?? ""} ${row.description ?? ""} ${tags} ${row.category ?? ""}`).includes(t);
}

/** Ids mentioned in the reply first; when the reply names any, only those. */
export function idsByMention(items: { id?: string; title?: string; name?: string }[], reply: string): string[] {
  const text = fold(reply);
  const seen = new Set<string>();
  const all: string[] = [];
  const mentioned: string[] = [];
  for (const it of items) {
    if (!it?.id || seen.has(it.id)) continue;
    seen.add(it.id); all.push(it.id);
    const label = fold(it.title ?? it.name ?? "").trim();
    if (label.length >= 3 && text.includes(label)) mentioned.push(it.id);
  }
  return mentioned.length > 0 ? mentioned : all;
}
