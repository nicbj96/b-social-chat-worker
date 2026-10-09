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

export function syncBulletsToItems(reply: string, items: { title?: string; name?: string }[]): string {
  const labels = items
    .map((it) => String(it?.title ?? it?.name ?? ""))
    .filter((t) => t.trim().length >= 3)
    .map((t) => ({ full: fold(t), core: titleCore(t) }));
  if (!labels.length) return reply;
  const lines = String(reply || "").split("\n");
  const bulletIdx = lines.map((l, i) => (BULLET_RE.test(l) ? i : -1)).filter((i) => i >= 0);
  if (!bulletIdx.length) return reply;
  const named = (line: string) => {
    const f = fold(line);
    return labels.some((l) => f.includes(l.core) || f.includes(l.full) || (l.full.length > 12 && f.includes(l.full.slice(0, 18))));
  };
  const keep = bulletIdx.filter((i) => named(lines[i]));
  // Nothing recognisable: leave the reply alone rather than empty it.
  if (keep.length === 0) return reply;
  const drop = new Set(bulletIdx.filter((i) => !keep.includes(i)));
  let out = lines.filter((_, i) => !drop.has(i)).join("\n");
  // Blanket claims about the whole list are not row facts.
  out = out.replace(/(^|\n)[ \t]*(?:Begge|Alle disse|Alle|Both|All of these|All)\s+(?:events?|arrangementer|aktiviteter|steder|places)?[^\n.?!]*(?:gratis|free|åbne|open|velegnede|suitable)[^\n.?!]*[.!]\s*/giu, "$1");
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** Ids of the items the reply names, with the same matching the bullets use. */
export function idsNamedInReply(items: { id?: string; title?: string; name?: string }[], reply: string): string[] {
  const text = fold(reply);
  const bullets = String(reply || "").split("\n").filter((l) => BULLET_RE.test(l))
    .map((l) => fold(l.replace(/^[ \t]*(?:[•*\-]|\d+\.)[ \t]+/, "")).replace(/^(?:teaterforestilling|koncert|event|forestilling)\s+/, ""));
  const seen = new Set<string>();
  const all: string[] = [];
  const named: string[] = [];
  for (const it of items) {
    if (!it?.id || seen.has(String(it.id))) continue;
    seen.add(String(it.id)); all.push(String(it.id));
    const t = String(it.title ?? it.name ?? "");
    if (t.trim().length < 3) continue;
    const full = fold(t), core = titleCore(t);
    // With bullets, an item is a card only when a bullet STARTS with its
    // title: a generic title ("Workshop") inside "Mosaik Workshop" is not it.
    if (bullets.length) {
      if (bullets.some((b) => b.startsWith(core) || b.startsWith(full) || (core.length >= 10 && b.includes(core)))) named.push(String(it.id));
    } else if (text.includes(core) || text.includes(full) || (full.length > 12 && text.includes(full.slice(0, 18)))) named.push(String(it.id));
  }
  // One card per listed title: a run of dates or a duplicate catalogue row
  // ("Mosaik Workshop" ×3, "Empire Bio" ×2) is still one bullet.
  const byId = new Map(items.filter((it) => it?.id).map((it) => [String(it.id), fold(String(it.title ?? it.name ?? ""))]));
  const titles = new Set<string>();
  const uniq = (ids: string[]) => ids.filter((id) => { const t = byId.get(id) || id; if (titles.has(t)) return false; titles.add(t); return true; });
  return named.length ? uniq(named) : all;
}
