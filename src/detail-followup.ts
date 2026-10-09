// R29: "fortæl mig mere om den første" must describe THAT item, not repeat the
// list or print "har følgende adresse:" followed by other cafés. The answer is
// built from the catalogue row named in the previous reply — no model prose.

const ORDINALS: Array<[RegExp, number]> = [
  [/(?<!\p{L})(?:den\s+)?(?:første|first)(?!\p{L})/iu, 0],
  [/(?<!\p{L})(?:den\s+)?(?:anden|andet|second)(?!\p{L})/iu, 1],
  [/(?<!\p{L})(?:den\s+)?(?:tredje|third)(?!\p{L})/iu, 2],
  [/(?<!\p{L})(?:den\s+)?(?:fjerde|fourth)(?!\p{L})/iu, 3],
  [/(?<!\p{L})(?:den\s+)?(?:sidste|last)(?!\p{L})/iu, -1],
];

const DETAIL_RE = /(?<!\p{L})(?:mere\s+om|fortæl|tell\s+me\s+more|more\s+about|detaljer|details|info(?:rmation)?\s+om)(?!\p{L})/iu;

/** Ordinal index the reader points at ("den første" = 0, "den sidste" = -1), or null. */
export function detailOrdinal(message: string): number | null {
  const text = String(message || "");
  if (text.length > 90 || !DETAIL_RE.test(text)) return null;
  for (const [re, idx] of ORDINALS) if (re.test(text)) return idx;
  return null;
}

function cleanTitle(line: string): string {
  let t = line.replace(/^[ \t]*(?:[•*\-]|\d+\.)[ \t]+/, "").replace(/\*\*/g, "").trim();
  // Cut at the first separator that starts venue/date/price detail.
  t = t.split(/\s+—\s+|\s+-\s+(?=\p{Lu}|\p{N}|koncert|event|stand|workshop)|:\s|\s+på\s+|\s+\(|\s+i\s+(?=\p{Lu})|,\s/u)[0];
  return t.replace(/[.:,;\s]+$/u, "").trim();
}

/** Item titles listed in an earlier assistant reply, in order. */
export function listedTitles(reply: string): string[] {
  const lines = String(reply || "").split("\n").map((l) => l.trim()).filter(Boolean);
  const bullets = lines.filter((l) => /^(?:[•*\-]|\d+\.)\s+\S/.test(l)).map(cleanTitle).filter((t) => t.length >= 2);
  if (bullets.length) return bullets;
  // "Her er et jazz-event i København:\nYoni Mayraz (UK) på KLEIN, …"
  const introAt = lines.findIndex((l) => /:\s*$/.test(l));
  if (introAt >= 0 && lines[introAt + 1] && !/\?\s*$/.test(lines[introAt + 1])) {
    const t = cleanTitle(lines[introAt + 1]);
    return t.length >= 2 ? [t] : [];
  }
  return [];
}

export function pickTitle(titles: string[], ordinal: number): string | null {
  if (!titles.length) return null;
  const idx = ordinal < 0 ? titles.length - 1 : ordinal;
  return titles[idx] ?? null;
}

function stamp(iso: string | null | undefined, da: boolean): string | null {
  if (!iso || !Number.isFinite(Date.parse(iso))) return null;
  return new Intl.DateTimeFormat(da ? "da-DK" : "en-GB", {
    timeZone: "Europe/Copenhagen", weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit",
  }).format(new Date(iso));
}

function shortText(s: unknown, max = 320): string {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  if (!t) return "";
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (end > 120 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "") + " …");
}

function priceText(e: Record<string, any>, da: boolean): string {
  const p = e.price;
  if (typeof p === "number" && Number.isFinite(p)) {
    if (p === 0) return da ? "Gratis" : "Free";
    if (p > 0) return `${p} ${typeof e.price_currency === "string" && e.price_currency ? e.price_currency : "DKK"}`;
  }
  return da ? "Pris ukendt" : "Price unknown";
}

/** Deterministic detail answer for one catalogue event. */
export function renderEventDetail(e: Record<string, any>, lang: "da" | "en"): string {
  const da = lang !== "en";
  const lines = [`${e.title}`];
  const when = stamp(e.date, da);
  const loc = e.location && !/^(none|null|undefined)$/i.test(String(e.location).trim()) ? String(e.location) : "";
  if (loc) lines.push(`${da ? "Sted" : "Venue"}: ${loc}`);
  if (when) lines.push(`${da ? "Tid" : "Time"}: ${when}`);
  lines.push(`${da ? "Pris" : "Price"}: ${priceText(e, da)}`);
  const desc = shortText(e.description);
  if (desc) lines.push("", desc);
  if (e.url) lines.push("", `${da ? "Læs mere og køb billet" : "More info and tickets"}: ${e.url}`);
  return lines.join("\n");
}

/** Deterministic detail answer for one catalogue place. */
export function renderPlaceDetail(p: Record<string, any>, lang: "da" | "en"): string {
  const da = lang !== "en";
  const lines = [`${p.name}`];
  const city = p.city || p.nearest_city;
  if (city) lines.push(`${da ? "By" : "City"}: ${city}`);
  const desc = shortText(p.description);
  if (desc && !/^(restaurant|café|cafe|bar) in /i.test(desc)) lines.push("", desc);
  lines.push("", da ? "Kataloget har ikke adresse eller åbningstider for dette sted. Se stedet på kortet for placering." : "The catalogue has no address or opening hours for this place. See it on the map for its location.");
  return lines.join("\n");
}
