// R30: the bullets in the reply and the cards under it must be the same set.
// The model sometimes lists an item that was never retrieved ("Pelles Fest"
// with no venue, 3 bullets over 2 cards), or adds a sweeping claim about all
// of them ("Begge events er gratis og åbne for grupper"). A bullet that names
// no retrieved item is dropped; the cards already follow the named items.

function fold(s: string): string {
  return String(s || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
    .replace(/[*_"“”„'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The part of a title a reader would write: before ":", "(", " - ", "//". */
function titleCore(title: string): string {
  const f = fold(title);
  const core = f.split(/\s*(?::|\(|\/\/|\s[-–—]\s)\s*/)[0].trim();
  return core.length >= 3 ? core : f;
}

const BULLET_RE = /^[ \t]*(?:[•*\-]|\d+\.)[ \t]+\S/;

export function syncBulletsToItems(reply: string, items: { title?: string; name?: string; date?: string; date_raw?: string }[]): string {
  const labels = items
    .map((it) => String(it?.title ?? it?.name ?? ""))
    .filter((t) => t.trim().length >= 3)
    .map((t) => ({ full: fold(t), core: titleCore(t) }));
  if (!labels.length) return reply;
  let lines = String(reply || "").split("\n");
  // R33: an item named in a prose line before the list ("Late Mic finder sted …")
  // becomes a bullet, so text and cards agree.
  {
    const firstBullet = lines.findIndex((l) => BULLET_RE.test(l));
    if (firstBullet >= 0) {
      const listed = lines.filter((l) => BULLET_RE.test(l)).map((l) => fold(l.replace(/^[ \t]*(?:[•*\-]|\d+\.)[ \t]+/, "")));
      lines = lines.map((l, i) => {
        if (i >= firstBullet && BULLET_RE.test(l)) return l;
        const f = fold(l.replace(/^[ \t]*(?:[•*\-]|\d+\.)[ \t]+/, ""));
        const lb = labels.find((x) => x.core.length >= 3 && (f.startsWith(x.core) || f.includes(` ${x.core} `)));
        if (!lb) return l;
        // Already in the list further down: the prose/duplicate line goes.
        const elsewhere = listed.filter((b) => b.startsWith(lb.core)).length;
        if (BULLET_RE.test(l) ? elsewhere > 1 && i < firstBullet + 0 : elsewhere > 0) return "";
        return BULLET_RE.test(l) ? l : `• ${l.trim()}`;
      });
    }
  }
  const bulletIdx = lines.map((l, i) => (BULLET_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!bulletIdx.length) return reply;
  const named = (line: string) => {
    const f = fold(line);
    return labels.some((l) => f.includes(l.core) || f.includes(l.full) || (l.full.length > 12 && f.includes(l.full.slice(0, 18))));
  };
  let keep = bulletIdx.filter((i) => named(lines[i]));
  {
    const owner = (line: string) => { const f = fold(line.replace(/^[ \t]*(?:[•*\-]|\d+\.)[ \t]+/, "")); return labels.find((l) => f.startsWith(l.core))?.core ?? null; };
    const byOwner = new Map<string, number[]>();
    for (const i of keep) { const o = owner(lines[i]); if (o) byOwner.set(o, [...(byOwner.get(o) || []), i]); }
    const drop = new Set<number>();
    for (const [, idx] of byOwner) if (idx.length > 1) {
      // Same title with different dates is fine (NOLA JAZZ JAM ×2); identical
      // item twice is not — keep the line that carries a price/date marker.
      const sig = (i: number) => fold(lines[i]).match(/\d{1,2}[.:]\d{2}|\d{1,2}\.\s*\p{L}+/gu)?.join("|") ?? "";
      const seenSig = new Map<string, number>();
      for (const i of idx) { const k = sig(i) || "nosig"; if (seenSig.has(k) || k === "nosig" && idx.some((j) => j !== i && sig(j))) drop.add(i); else seenSig.set(k, i); }
    }
    keep = keep.filter((i) => !drop.has(i));
  }
  // Nothing recognisable: leave the reply alone rather than empty it.
  if (keep.length === 0) return reply;
  const drop = new Set(bulletIdx.filter((i) => !keep.includes(i)));
  let out = lines.filter((_, i) => !drop.has(i)).join("\n");
  // Blanket claims about the whole list are not row facts.
  out = out.replace(/(^|\n)[ \t]*(?:Begge|Alle disse|Alle|Both|All of these|All)\s+(?:events?|arrangementer|aktiviteter|steder|places|shows?|koncerter|forestillinger)?[^\n.?!]*(?:gratis|free|åbne|open|velegnede|suitable|festival|en del af|part of)[^\n.?!]*[.!]\s*/giu, "$1");
  // A line that promises something after a colon and then delivers nothing
  // ("Du kan købe billetter på følgende links:") is removed.
  out = out.split("\n").filter((l, i, arr) => {
    if (!/:\s*$/.test(l) || BULLET_RE.test(l)) return true;
    const next = arr.slice(i + 1).find((x) => x.trim());
    return !!next && BULLET_RE.test(next);
  }).join("\n");
  out = sortBulletRunsByDate(out, items);
  // R39: no emoji in answers ("Der er flere koncerter i aften! 🎸").
  out = out.replace(/\s?[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]\u{FE0F}?/gu, "");
  // R37: one bullet style; bold markers inside bullets go.
  out = out.split("\n").map((l) => BULLET_RE.test(l) ? l.replace(/\*\*/g, "").replace(/^[ \t]*(?:[*\-]|\d+\.)[ \t]+/, "• ") : l).join("\n");
  // R36: "søndag den 15.30" — a clock time written as a date.
  out = out.replace(/\bden (\d{1,2})[.:](\d{2})(?!\d)/g, "kl. $1.$2");
  // R36: an orphan fragment left after the list ("oktober 2026. Billetprisen er 135 DKK.").
  out = out.split("\n").filter((l) => !/^\s*(?:januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december)\s+\d{4}\b/.test(l)).join("\n");
  // R35: chatty openers ("Hej! Her er nogle fede …") are out of the house style.
  out = out.replace(/^(?:Hej|Hey|Hi|Hello)[!,.]?\s+/i, "").replace(/^\p{Ll}/u, (c) => c.toUpperCase());
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** R35: consecutive bullets that each name a dated item are put in date order. */
export function sortBulletRunsByDate(reply: string, items: { title?: string; name?: string; date?: string; date_raw?: string }[]): string {
  const dated = items.map((it) => ({ core: titleCore(String(it?.title ?? it?.name ?? "")), full: fold(String(it?.title ?? it?.name ?? "")), t: Date.parse(String(it?.date_raw ?? it?.date ?? "")) }))
    .filter((d) => d.core.length >= 3 && Number.isFinite(d.t));
  if (dated.length < 2) return reply;
  const lines = reply.split("\n");
  const timeOf = (l: string) => {
    const f = fold(l.replace(/^[ \t]*(?:[•*\-]|\d+\.)[ \t]+/, ""));
    const hits = dated.filter((d) => f.startsWith(d.full) || f.startsWith(d.core));
    if (!hits.length) {
      // R38: "(5-6 år) Dansk Danseteater …" — fall back to the date written in the bullet itself.
      const MO: Record<string, number> = { januar: 0, februar: 1, marts: 2, april: 3, maj: 4, juni: 5, juli: 6, august: 7, september: 8, oktober: 9, november: 10, december: 11 };
      const w = fold(l).match(/(\d{1,2})\.\s*(januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december)(?:\s+(\d{4}))?/);
      if (!w) return null;
      const now = new Date(); const mo = MO[w[2]];
      const yr = w[3] ? Number(w[3]) : (mo < now.getUTCMonth() - 1 ? now.getUTCFullYear() + 1 : now.getUTCFullYear());
      return Date.UTC(yr, mo, Number(w[1]), 12);
    }
    // Same title on several dates: use the date written in the bullet when it matches one.
    if (hits.length > 1) {
      const m = f.match(/(\d{1,2})\.\s*(?:okt|oktober|nov|november|dec|december|sep|september|jan|januar|feb|februar|mar|marts|apr|april|maj|jun|juni|jul|juli|aug|august)/);
      if (m) { const day = Number(m[1]); const h = hits.find((x) => new Date(x.t).getUTCDate() === day || new Date(x.t + 3 * 3600e3).getUTCDate() === day); if (h) return h.t; }
      return null;
    }
    return hits[0].t;
  };
  let i = 0;
  while (i < lines.length) {
    if (!BULLET_RE.test(lines[i])) { i++; continue; }
    let j = i; while (j < lines.length && BULLET_RE.test(lines[j])) j++;
    const run = lines.slice(i, j).map((l, k) => ({ l, k, t: timeOf(l) }));
    // R37: sort the dated bullets among their own slots even when one bullet is unmatched.
    const dated = run.filter((r) => r.t !== null);
    if (dated.length > 1) {
      const sorted = [...dated].sort((a, b) => (a.t! - b.t!) || (a.k - b.k));
      let q = 0;
      for (const r of run) if (r.t !== null) lines[i + r.k] = sorted[q++].l;
    }
    i = j;
  }
  return lines.join("\n");
}

/** R33: place bullets carry the catalogue name only. Places have no reliable
 * description in the catalogue, so model-written colour ("hyggelig café",
 * "lækre retter") is unverifiable; keep the name, drop the rest. */
export function placeBulletsNameOnly(reply: string, places: { name?: string }[]): string {
  const names = places.map((p) => String(p?.name ?? "")).filter((n) => n.trim().length >= 2);
  if (!names.length) return reply;
  return String(reply || "").split("\n").map((l) => {
    if (!BULLET_RE.test(l)) return l;
    const body = l.replace(/^[ \t]*(?:[•*\-]|\d+\.)[ \t]+/, "").replace(/\*\*/g, "");
    const f = fold(body);
    const hit = names.filter((n) => f.startsWith(fold(n))).sort((a, b) => b.length - a.length)[0];
    return hit ? `• ${hit}` : l;
  }).join("\n");
}

/** Ids of the items the reply names, with the same matching the bullets use.
 * With bullets: each bullet gets at most one card (the first unused item whose
 * title the bullet starts with), so N bullets give at most N cards — two dates
 * of NOLA JAZZ JAM are two bullets and two cards, three Mosaik rows behind one
 * bullet are one card. Without bullets: every item the prose names. */
export function idsNamedInReply(items: { id?: string; title?: string; name?: string }[], reply: string, strict = false): string[] {
  const seen = new Set<string>();
  const uniq: { id: string; full: string; core: string }[] = [];
  for (const it of items) {
    if (!it?.id || seen.has(String(it.id))) continue;
    seen.add(String(it.id));
    const t = String(it.title ?? it.name ?? "");
    uniq.push({ id: String(it.id), full: fold(t), core: titleCore(t) });
  }
  const all = uniq.map((u) => u.id);
  const bullets = String(reply || "").split("\n").filter((l) => BULLET_RE.test(l))
    .map((l) => fold(l.replace(/^[ \t]*(?:[•*\-]|\d+\.)[ \t]+/, "")).replace(/^(?:teaterforestilling|koncert|event|forestilling)\s+/, ""));
  if (bullets.length) {
    const used = new Set<string>();
    const out: string[] = [];
    const rawBullets = String(reply || "").split("\n").filter((l) => BULLET_RE.test(l)).map((l) => fold(l.replace(/^[ \t]*(?:[•*\-]|\d+\.)[ \t]+/, "")));
    for (const [bi, b0] of bullets.entries()) {
      // R39: "Koncert med Fistful Of Dollars" — the title itself starts with "koncert".
      const hitOf = (b: string) => uniq.find((u) => !used.has(u.id) && u.core.length >= 2 && (b.startsWith(u.core) || b.startsWith(u.full) || (u.core.length >= 10 && b.includes(u.core)) || (u.full.length >= 8 && b.includes(u.full))));
      const b = hitOf(b0) ? b0 : rawBullets[bi];
      const hit = uniq.find((u) => !used.has(u.id) && u.core.length >= 2 && (b.startsWith(u.core) || b.startsWith(u.full) || (u.core.length >= 10 && b.includes(u.core)) || (u.full.length >= 8 && b.includes(u.full))));
      if (hit) { used.add(hit.id); out.push(hit.id); }
    }
    return out.length || strict ? out : all;
  }
  const text = fold(reply);
  const named = uniq.filter((u) => u.core.length >= 3 && (text.includes(u.core) || text.includes(u.full) || (u.full.length > 12 && text.includes(u.full.slice(0, 18))))).map((u) => u.id);
  return named.length ? named : all;
}

/** R38: pair "Title — price" + "Tidspunkt: …" lines into one bullet in the deadline fallback. */
export function deadlineBullets(reply: string): string {
  const ls = reply.split("\n"); const out: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]; const nx = ls[i + 1] ?? "";
    const m = /^(.+) — ([^—]+)$/.exec(l);
    const t = /^(?:Tidspunkt|Time): (.+)$/.exec(nx);
    if (m && t) { out.push(`• ${m[1]} — ${t[1]} — ${m[2]}`); i++; continue; }
    if (m && i > 0) { out.push(`• ${l}`); continue; }
    out.push(l);
  }
  return out.join("\n");
}

/** R41: every event bullet that names one card is written from the card itself:
 *  "• Title — venue — lørdag 10. oktober kl. 11.00 — Gratis". One format, catalogue facts only. */
export function renderEventBullets(reply: string, items: { title?: string; location?: string; date?: string; price?: unknown; price_currency?: unknown }[], lang: "da" | "en"): string {
  const uniq = items.filter((it) => it?.title && String(it.title).trim().length >= 3).map((it) => ({ it, full: fold(String(it.title)), core: titleCore(String(it.title)) }));
  if (!uniq.length) return reply;
  const used = new Set<number>();
  const da = lang !== "en";
  const when = (d?: string) => {
    if (!d || !Number.isFinite(Date.parse(d))) return "";
    const dt = new Date(d);
    const day = new Intl.DateTimeFormat(da ? "da-DK" : "en-GB", { timeZone: "Europe/Copenhagen", weekday: "long", day: "numeric", month: "long" }).format(dt).replace(/^(\p{L}+) (?=\d)/u, da ? "$1 den " : "$1 ");
    const hm = new Intl.DateTimeFormat("da-DK", { timeZone: "Europe/Copenhagen", hour: "2-digit", minute: "2-digit" }).format(dt).replace(":", ".");
    return hm === "00.00" ? day : `${day} ${da ? "kl." : "at"} ${hm}`;
  };
  const price = (p: unknown, c?: unknown) => typeof p === "string" && p.trim()
    ? (da ? p.trim() : ({ "Pris ukendt": "Price unknown", "Gratis": "Free" } as Record<string, string>)[p.trim()] ?? p.trim().replace("(valuta ukendt)", "(currency unknown)"))
    : typeof p === "number" && Number.isFinite(p) ? (p === 0 ? (da ? "Gratis" : "Free") : `${p} ${typeof c === "string" && /^[A-Z]{3}$/.test(c) ? c : "DKK"}`) : (da ? "Pris ukendt" : "Price unknown");
  return String(reply || "").split("\n").map((l) => {
    if (!BULLET_RE.test(l)) return l;
    const b = fold(l.replace(/^[ \t]*(?:[•*\-]|\d+\.)[ \t]+/, ""));
    const b2 = b.replace(/^(?:teaterforestilling|koncert|event|forestilling)\s+/, "");
    const k = uniq.findIndex((u, i) => !used.has(i) && u.core.length >= 3 && [b, b2].some((x) => x.startsWith(u.full) || x.startsWith(u.core) || (u.full.length > 18 && x.startsWith(u.full.slice(0, 18)))));
    if (k < 0) return l;
    used.add(k);
    const { it } = uniq[k];
    return ["• " + String(it.title).trim(), it.location ? tidyVenue(String(it.location)) : "", when(it.date), price(it.price, it.price_currency)].filter(Boolean).join(" — ");
  }).join("\n");
}

/** R41d: "Drop inn, Kompagnistræde 34, Copenhagen, 1208, Denmark" → "Drop inn, København". */
export function tidyVenue(loc: string): string {
  const parts = loc.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 3) return loc.trim().replace(/\bCopenhagen\b/g, "København");
  const city = { copenhagen: "København", aarhus: "Aarhus", odense: "Odense", aalborg: "Aalborg" } as Record<string, string>;
  const kept = parts.filter((p, i) => i === 0 || !(/^\d{4}$/.test(p) || /^(denmark|danmark)$/i.test(p) || /\d/.test(p)));
  return kept.map((p) => city[p.toLowerCase()] ?? p).join(", ");
}
