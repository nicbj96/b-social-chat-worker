/** Plan §7 P168–174 / M39: grounding for the NORMAL model path.
 * The model's free text may only frame the answer; every concrete fact
 * (entity, price, currency, time, status) must come from structured evidence
 * captured with the deterministic retrieval's eligibility. Wrong or
 * contradictory model claims are removed and the facts are re-rendered from
 * verified fields; a failed retrieval is an explicit error, never a null or a
 * fake "no results". retrieved_at (when WE retrieved) is kept distinct from
 * the upstream source update time.
 */

export interface GroundedSource {
  id: string;
  kind: "event" | "place";
  url: string;
  verified_fields: Record<string, unknown>;
  retrieved_at: string;
  source_updated_at: string | null;
}

export type Grounding = "verified" | "corrected" | "flagged" | "error";
export interface GroundedAnswer { reply: string; grounding: Grounding; corrections: string[] }

export interface GroundedToolResult { kind: "event" | "place"; retrieved_at: string; rows: Record<string, unknown>[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * search_events returns display fields (date = "lørdag den 10. oktober 2026 kl.
 * 22.00", price = "Pris ukendt") next to the raw values (date_raw, price_amount,
 * currency). Grounding must compare against the raw values, or every correct
 * time/price the model repeats looks contradictory.
 */
function normalizeEvidence(row: Record<string, unknown>): Record<string, unknown> {
  const out = { ...row };
  if (typeof row.date_raw === "string" && Number.isFinite(Date.parse(row.date_raw))) out.date = row.date_raw;
  if (typeof row.price_amount === "number" && Number.isFinite(row.price_amount)) out.price = row.price_amount;
  else if (typeof row.price === "string") delete out.price;
  if (typeof row.currency === "string" && !out.price_currency) out.price_currency = row.currency;
  return out;
}

export function buildGroundedSources(results: GroundedToolResult[]): GroundedSource[] {
  const out: GroundedSource[] = [];
  for (const result of results) {
    for (const row of result.rows) {
      const id = typeof row.id === "string" && UUID.test(row.id) ? row.id : null;
      const title = typeof row.title === "string" ? row.title : typeof row.name === "string" ? row.name : null;
      if (!id || !title) continue;
      const upstream = row.source_updated_at ?? row.catalog_updated_at ?? row.updated_at ?? null;
      out.push({
        id, kind: result.kind, url: `/${result.kind === "event" ? "event" : "sted"}/${id}`,
        verified_fields: normalizeEvidence({ ...row, id, [result.kind === "event" ? "title" : "name"]: title }),
        retrieved_at: result.retrieved_at,
        source_updated_at: typeof upstream === "string" && Number.isFinite(Date.parse(upstream)) ? upstream : null,
      });
    }
  }
  return out;
}

function priceLabel(fields: Record<string, unknown>, lang: "da" | "en"): string {
  const price = fields.price;
  if (typeof price !== "number" || !Number.isFinite(price) || price < 0) return lang === "da" ? "Pris ukendt" : "Price unknown";
  if (price === 0) return lang === "da" ? "Gratis" : "Free";
  const currency = typeof fields.price_currency === "string" && /^[A-Z]{3}$/.test(fields.price_currency)
    ? fields.price_currency : lang === "da" ? "(valuta ukendt)" : "(currency unknown)";
  return `${price} ${currency}`;
}

export function renderGroundedFacts(sources: GroundedSource[], lang: "da" | "en"): string[] {
  const lines = sources.map(s => {
    const title = String(s.verified_fields[s.kind === "event" ? "title" : "name"]);
    const label = `${title} — ${priceLabel(s.verified_fields, lang)}`;
    const d = s.verified_fields.date;
    const timeLine = typeof d === "string" && Number.isFinite(Date.parse(d))
      ? (() => {
          const dt = new Date(d);
          const hh = String(dt.getUTCHours()).padStart(2, "0"), mm = String(dt.getUTCMinutes()).padStart(2, "0");
          const stamp = `${dt.toISOString().slice(0, 10)} ${hh}:${mm}`;
          return lang === "da" ? `Tidspunkt: ${stamp} UTC` : `Time: ${stamp} UTC`;
        })()
      : null;
    return timeLine ? `${label}\n${timeLine}` : label;
  });
  for (const s of sources) {
    if (lang === "da") {
      lines.push(`Hentet: ${s.retrieved_at}`);
      lines.push(s.source_updated_at ? `Kilde opdateret: ${s.source_updated_at}` : "Kildens opdateringstid er ukendt");
    } else {
      lines.push(`Retrieved: ${s.retrieved_at}`);
      lines.push(s.source_updated_at ? `Source updated: ${s.source_updated_at}` : "Source update time unknown");
    }
  }
  return lines;
}

const TITLE_RE = /"([^"]{1,120})"/g;
const PRICE_RE = /(\d+(?:[.,]\d+)?)\s*(kr\.?|dkk|eur|usd|sek|nok|gbp|chf|euro(?:r|s)?|kroner)/i;
const GRATIS_RE = /\b(gratis|free(?: of charge)?|no charge|free entry)\b/i;
const CLOCK_RE = /\b(?:klokken|kl\.?|at)\s*(\d{1,2})[:.](\d{2})\b/i;
const DATE_RE = /\b(\d{1,2})\.\s*(januar|februar|marts|april|maj|juni|juli|august|september|oktober|november|december)\b|\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{1,2})\b/i;
const MONTHS_DA = { januar: 1, februar: 2, marts: 3, april: 4, maj: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, december: 12 } as Record<string, number>;
const MONTHS_EN = { january: 1, february: 2, march: 3, april: 4, may: 5, june: 6, july: 7, august: 8, september: 9, october: 10, november: 11, december: 12 } as Record<string, number>;

function evidencePriceNumbers(sources: GroundedSource[]): number[] {
  return sources.map(s => (typeof s.verified_fields.price === "number" && Number.isFinite(s.verified_fields.price) ? s.verified_fields.price : NaN)).filter(n => !Number.isNaN(n));
}
function evidenceFree(sources: GroundedSource[]): boolean { return sources.some(s => s.verified_fields.price === 0); }
function evidenceTitleList(sources: GroundedSource[]): string[] { return sources.map(s => String(s.verified_fields[s.kind === "event" ? "title" : "name"]).toLowerCase()); }
function cphParts(d: string): { day: number; month: number; minutes: number } | null {
  if (!Number.isFinite(Date.parse(d))) return null;
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", day: "numeric", month: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(new Date(d));
  const n = (t: string) => Number(parts.find(p => p.type === t)?.value);
  const hour = n("hour") % 24;
  return { day: n("day"), month: n("month"), minutes: hour * 60 + n("minute") };
}

/** Clock minutes per source, both as stored (UTC) and as the reader's Danish wall time. */
function evidenceClockMinutes(sources: GroundedSource[]): number[] {
  return sources.flatMap(s => {
    const d = s.verified_fields.date;
    if (typeof d !== "string" || !Number.isFinite(Date.parse(d))) return [];
    // Readers are told Danish wall time; a UTC clock ("kl. 14.00" for a
    // 15:00 start) is a wrong fact, so only the local time is evidence.
    const local = cphParts(d);
    return local ? [local.minutes] : [];
  });
}

/** Day/month per source (UTC and Danish wall date). */
function evidenceDayMonths(sources: GroundedSource[]): { day: number; month: number }[] {
  return sources.flatMap(s => {
    const d = s.verified_fields?.date;
    if (typeof d !== "string" || !Number.isFinite(Date.parse(d))) return [];
    const dt = new Date(d);
    const local = cphParts(d);
    return [{ day: dt.getUTCDate(), month: dt.getUTCMonth() + 1 }, ...(local ? [{ day: local.day, month: local.month }] : [])];
  });
}

function sentenceViolates(sentence: string, allSources: GroundedSource[], lang: "da" | "en"): string | null {
  const titles = evidenceTitleList(allSources);
  // A fact next to a named event must match THAT event, not any row in the
  // turn (another row's 16:00 must not validate "Lis Sørensen kl. 16.00").
  const lowered = sentence.toLowerCase();
  const named = allSources.filter(s => {
    const t = String(s.verified_fields[s.kind === "event" ? "title" : "name"] ?? "").toLowerCase().trim();
    return t.length >= 3 && lowered.includes(t);
  });
  const sources = named.length > 0 ? named : allSources;
  for (const m of sentence.matchAll(TITLE_RE)) {
    if (!titles.includes(m[1].toLowerCase())) return "invented_entity";
  }
  const price = sentence.match(PRICE_RE);
  if (price) {
    const number = Number(price[1].replace(",", "."));
    const typed = /dkk|eur|usd|sek|nok|gbp|chf|kr/i.test(price[2]);
    const evidence = evidencePriceNumbers(sources);
    const match = evidence.some(n => Math.abs(n - number) < 1e-9) && typed;
    if (!match) return "price_without_verified_field";
  } else {
    // A bare number introduced as a price ("koster 25", "price 25") carries no
    // currency and is never a verified fact.
    const bare = sentence.match(/\b(?:koster|pris|price|costs)\s*(\d+(?:[.,]\d+)?)/i);
    if (bare) return "price_without_verified_field";
  }
  // A title like "DANS - FREE YOUR FEET" is not a price claim: test the
  // sentence with every evidence title masked out.
  const untitled = titles.reduce((acc, t) => (t ? acc.split(t).join(" ") : acc), sentence.toLowerCase());
  // "Der er ingen gratis events i Aalborg" is the honest empty answer, not a
  // free-price claim about any row.
  const negated = /(?<!\p{L})(?:ingen|ikke|no|not|none|aren't|isn't)(?!\p{L})/iu.test(untitled);
  if (GRATIS_RE.test(untitled) && !negated && !evidenceFree(sources)) return "unverified_free_claim";
  const clock = sentence.match(CLOCK_RE);
  if (clock) {
    const minutes = Number(clock[1]) * 60 + Number(clock[2]);
    const evidence = evidenceClockMinutes(sources);
    if (!evidence.some(e => e === minutes)) return "contradictory_time";
  }
  const dateClaim = sentence.match(DATE_RE);
  if (dateClaim) {
    const day = dateClaim[1] ? Number(dateClaim[1]) : Number(dateClaim[4]);
    const monthName = (dateClaim[2] ?? dateClaim[3] ?? "").toLowerCase();
    const month = MONTHS_DA[monthName] ?? MONTHS_EN[monthName];
    const ev = evidenceDayMonths(sources);
    if (ev.length > 0 && !ev.some(e => e.day === day && e.month === month)) return "contradictory_date";
  }
  return null;
}

/** Europe/Copenhagen wall time, e.g. "lør. 10. okt. kl. 21:00"; "" when not ISO. */
function readerTime(d: unknown, lang: "da" | "en"): string {
  if (typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(d) || !Number.isFinite(Date.parse(d))) return "";
  const dt = new Date(d);
  const loc = lang === "da" ? "da-DK" : "en-GB";
  const day = new Intl.DateTimeFormat(loc, { timeZone: "Europe/Copenhagen", weekday: "short", day: "numeric", month: "short" }).format(dt);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Copenhagen", hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(dt);
  const hh = parts.find(p => p.type === "hour")?.value ?? "", mm = parts.find(p => p.type === "minute")?.value ?? "";
  return `${day} ${lang === "da" ? "kl." : "at"} ${hh}:${mm}`;
}

/** Short bullet per verified source for chat prose: title, and price only when known. */
export function renderReaderFacts(sources: GroundedSource[], lang: "da" | "en"): string[] {
  return sources.slice(0, 5).map(s => {
    const title = String(s.verified_fields[s.kind === "event" ? "title" : "name"] ?? "").trim();
    if (!title) return "";
    const price = priceLabel(s.verified_fields, lang);
    const known = price !== (lang === "da" ? "Pris ukendt" : "Price unknown") && !price.includes("ukendt") && !price.includes("unknown");
    const when = readerTime(s.verified_fields.date, lang);
    return [`• ${title}`, when, known ? price : ""].filter(Boolean).join(" — ");
  }).filter(Boolean);
}

/** N4: one bullet style ("•") and no blank lines inside a list. */
export function normalizeBullets(text: string): string {
  const lines = String(text || "").split("\n").map(l => l.replace(/^[ \t]*[*\-•][ \t]+(?=\S)/u, "• "));
  const isB = (l: string) => l.startsWith("• ");
  const out: string[] = [];
  for (let k = 0; k < lines.length; k += 1) {
    if (lines[k].trim() === "" && out.length && isB(out[out.length - 1])) {
      let n = k + 1; while (n < lines.length && lines[n].trim() === "") n += 1;
      if (n < lines.length && isB(lines[n])) continue;
    }
    out.push(lines[k]);
  }
  return out.join("\n");
}

export function groundModelReply(
  modelText: string,
  sources: GroundedSource[],
  opts: { lang: "da" | "en"; retrievalError?: string | null },
): GroundedAnswer {
  const r = groundModelReplyInner(modelText, sources, opts);
  return { ...r, reply: normalizeBullets(r.reply) };
}

function groundModelReplyInner(
  modelText: string,
  sources: GroundedSource[],
  opts: { lang: "da" | "en"; retrievalError?: string | null },
): GroundedAnswer {
  const da = opts.lang !== "en";
  if (opts.retrievalError) {
    return {
      reply: da
        ? `Resultaterne kunne ikke hentes (${opts.retrievalError}). Katalogsøgningen under Udforsk virker stadig.`
        : `Could not retrieve results (${opts.retrievalError}). The catalogue search under Explore still works.`,
      grounding: "error",
      corrections: [],
    };
  }
  // Internal tool-loop narration is not an answer to the reader.
  modelText = modelText.replace(/(?<=[.!?])[ \t]+(?:let me (?:try (?:to )?)?(?:search(?:ing)?|look(?:ing)?)|lad mig (?:prøve at )?(?:søge|kigge))[^.!?\n]*[.!?]?/gi, "");
  modelText = modelText.replace(/^[ \t]*(?:let me (?:try (?:to )?)?(?:search(?:ing)?|look(?:ing)?)[^\n]*|lad mig (?:prøve at )?(?:søge|kigge)[^\n]*|jeg (?:prøver|søger) (?:igen|lige)[^\n]*)\n?/gim, "");
  // Template placeholders ("[jazz_steder København]") and empty checkboxes are
  // model scaffolding, never reader text.
  modelText = modelText.replace(/\[[\p{L}_]+(?:\s+[\p{L}]+)*_[\p{L}_]*(?:\s+[\p{L}]+)*\]/gu, "").replace(/^\s*[-*]\s*\[\s?\]\s*/gmu, "- ").replace(/^[ \t]*\[[^\]\n]{1,60}\][ \t]*$/gmu, "");
  // "Her er nogle jazz-events: … Ingen resultater fundet." — an empty result
  // must not open with a claim that a list follows.
  if (sources.length === 0 && /(ingen\s+(?:resultater|events?)|no\s+results|found\s+no|fandt\s+ingen)/i.test(modelText)) {
    modelText = modelText.split("\n").filter(l => !/^\s*(her\s+er\s+nogle|here\s+are\s+some)\b/i.test(l)).join("\n");
  }
  // "* Ingen fundet" under "Her er et gratis event…" contradicts the cards:
  // drop the placeholder bullet and, when rows exist, list them instead.
  let droppedNone = false;
  modelText = modelText.replace(/^[ \t]*[*•\-][ \t]*(?:ingen\s+(?:fundet|resultater|events?)|none\s+found|no\s+results)[.!]?[ \t]*$/gimu, () => { droppedNone = true; return ""; });
  if (droppedNone && sources.length > 0 && !/^[ \t]*[*•\-][ \t]+\S/m.test(modelText)) {
    modelText = `${modelText.trim()}\n${renderReaderFacts(sources, da ? "da" : "en").join("\n")}`;
  } else if (droppedNone && sources.length === 0) {
    modelText = modelText.split("\n").filter(l => !/^\s*(her\s+er|here\s+(?:is|are))\b/i.test(l)).join("\n");
    if (!modelText.trim()) modelText = da ? "Jeg fandt ingen events, der matcher." : "I found no matching events.";
  }
  if (!modelText.trim()) {
    return { reply: sources.length ? renderGroundedFacts(sources, da ? "da" : "en").join("\n") : "", grounding: sources.length ? "verified" : "flagged", corrections: [] };
  }
  // Split into claims without breaking "10. oktober kl. 22.00": boundaries are
  // newlines, or sentence punctuation followed by an uppercase/bullet start.
  // Separators are kept so surviving text is rebuilt exactly as written.
  // A bullet line is one claim: event titles carry their own full stops
  // ("AI & Digital Confidence. Futurists …") and must not be cut in half.
  const parts: string[] = [];
  for (const piece of modelText.split(/(\n+)/)) {
    if (/^\n+$/.test(piece)) { if (parts.length % 2 === 1) parts.push(piece); else parts.push("", piece); continue; }
    const sub = /^\s*(?:[*•\-]|\d+[.)])\s/.test(piece) ? [piece] : piece.split(/((?<=[.!?])[ \t]+(?=[\p{Lu}*•\-"]))/u);
    for (let k = 0; k < sub.length; k += 1) {
      if (k % 2 === 0) { if (parts.length % 2 === 1) parts.push(""); parts.push(sub[k]); }
      else parts.push(sub[k]);
    }
  }
  const kept: string[] = [];
  const corrections: string[] = [];
  for (let i = 0; i < parts.length; i += 2) {
    const sentence = parts[i] ?? "";
    const sep = parts[i + 1] ?? "";
    const violation = sentence.trim() ? sentenceViolates(sentence, sources, da ? "da" : "en") : null;
    if (!violation) { kept.push(sentence + sep); continue; }
    console.log(JSON.stringify({ event: "grounding_removed", violation, sentence: sentence.trim().slice(0, 160) }));
    if (sep.includes("\n")) kept.push("\n");
    if (!corrections.some(c => c.startsWith(violation))) {
      corrections.push(violation === "invented_entity"
        ? (da ? "Opdigtede resultater er fjernet; kun verificerede katalogsvar vises." : "Invented results were removed; only verified catalogue answers are shown.")
        : da ? `Modstridende oplysning er korrigeret fra verificerede felter (${violation}).` : `Contradicting information was corrected from verified fields (${violation}).`);
    }
  }
  if (corrections.length === 0) return { reply: modelText, grounding: "verified", corrections };
  // Reader-facing correction: the verified facts in plain language. Provenance
  // (retrieved_at / source_updated_at) stays in the structured `sources`
  // payload and the cards — it is not chat prose.
  const body = kept.join("").replace(/\n{3,}/g, "\n\n").trim();
  // Don't repeat a source the surviving text already lists.
  const lowBody = body.toLowerCase();
  // Fuzzy: "Lørdagsrytmik for 1-2 år" in the prose already covers the source
  // "Lørdagsrytmik 1-2 år" — repeating it in a second format reads as a duplicate.
  const bodyWords = new Set(lowBody.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  const facts = renderReaderFacts(sources, da ? "da" : "en").filter(f => {
    const t = f.replace(/^•\s*/, "").split(" — ")[0].trim().toLowerCase();
    if (!t) return false;
    if (lowBody.includes(t)) return false;
    const words = t.split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3);
    if (words.length === 0) return true;
    const hit = words.filter(w => bodyWords.has(w)).length;
    return hit / words.length < 0.6;
  });
  // A closing question ("Vil du have mere information…?") belongs after the
  // verified list, not between the intro and the bullets.
  const lines = body.split("\n");
  const tail: string[] = [];
  while (facts.length && lines.length > 1 && /\?\s*$/.test(lines[lines.length - 1].trim())) tail.unshift(lines.pop()!);
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  const head = lines.join("\n").trim();
  return { reply: [head, ...facts, ...(tail.length ? ["", ...tail] : [])].filter((x, k, a) => x !== "" || (k > 0 && a[k - 1] !== "")).join("\n").trim(), grounding: "corrected", corrections };
}
