// SSRF-guarded external fetch (Mission Control V2, Phase 5).
//
// This is the ONLY place the system reaches out to the open web, so it is written
// defensively: https/http only, no credentials in the URL, standard ports only,
// literal private/loopback/link-local/metadata IPs blocked, redirects followed
// MANUALLY and re-validated at every hop, a hard timeout, and a byte cap so a
// giant response can't blow up memory. Returns extracted text + any contact
// emails — never raw bytes back to a model unbounded.
//
// (Cloudflare Workers' fetch already runs on CF's edge with no route to a host
// metadata service, but we still block private targets as defence-in-depth.)

const MAX_REDIRECTS = 4;
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 600_000;
const MAX_TEXT = 8_000;

export type FetchResult =
  | { ok: true; finalUrl: string; status: number; title: string; text: string; emails: string[] }
  | { ok: false; error: string };

function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) {
    return true;
  }
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) return true;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    if (a >= 224) return true; // multicast / reserved
    return false;
  }
  if (h.includes(":")) {
    // IPv6 literal: block loopback, unspecified, link-local (fe80), ULA (fc/fd).
    if (h === "::1" || h === "::") return true;
    if (h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) return true;
    if (h.startsWith("fc") || h.startsWith("fd")) return true;
    if (h.startsWith("::ffff:")) return true; // IPv4-mapped — could smuggle a private v4
    return true; // any other bare IPv6 literal: reject rather than guess
  }
  return false;
}

// Validate a URL string for outbound fetch. Returns the normalized URL or null.
export function validateUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username || u.password) return null; // no creds smuggled in the authority
  if (u.port && u.port !== "80" && u.port !== "443") return null;
  if (isBlockedHost(u.hostname)) return null;
  return u;
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  const cl = Number(res.headers.get("content-length") || 0);
  if (cl && cl > maxBytes * 3) return ""; // declared way over cap → skip
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.length;
      chunks.push(value);
      if (total >= maxBytes) {
        try { await reader.cancel(); } catch { /* ignore */ }
        break;
      }
    }
  }
  const merged = new Uint8Array(Math.min(total, maxBytes));
  let off = 0;
  for (const c of chunks) {
    const room = merged.length - off;
    if (room <= 0) break;
    merged.set(c.subarray(0, room), off);
    off += c.length;
  }
  return new TextDecoder().decode(merged);
}

function extractEmails(html: string): string[] {
  const found = new Set<string>();
  const re = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
  for (const m of html.matchAll(re)) {
    const e = m[0].toLowerCase();
    // skip obvious asset/noise addresses
    if (/\.(png|jpg|jpeg|gif|webp|svg|css|js)$/i.test(e)) continue;
    if (e.startsWith("example@") || e.endsWith("@example.com")) continue;
    found.add(e);
    if (found.size >= 10) break;
  }
  return [...found];
}

function htmlToText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = (titleMatch?.[1] || "").replace(/\s+/g, " ").trim().slice(0, 200);
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT);
  return { title, text };
}

export async function guardedFetch(rawUrl: string): Promise<FetchResult> {
  let current = validateUrl(rawUrl);
  if (!current) return { ok: false, error: "URL blokeret (kun offentlige http/https-adresser er tilladt)" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await fetch(current.toString(), {
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "user-agent": "B-Social-Research/1.0 (+https://b-social.net)",
          accept: "text/html,text/plain;q=0.9",
        },
      });

      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, error: `redirect uden mål (HTTP ${res.status})` };
        let next: URL | null;
        try {
          next = validateUrl(new URL(loc, current).toString());
        } catch {
          next = null;
        }
        if (!next) return { ok: false, error: "redirect til blokeret adresse" };
        current = next;
        continue;
      }

      if (!res.ok) return { ok: false, error: `siden svarede HTTP ${res.status}` };

      const ctype = (res.headers.get("content-type") || "").toLowerCase();
      if (!ctype.includes("text/html") && !ctype.includes("text/plain") && ctype !== "") {
        return { ok: false, error: `uventet indholdstype: ${ctype.split(";")[0]}` };
      }

      const html = await readCapped(res, MAX_BYTES);
      const { title, text } = htmlToText(html);
      return { ok: true, finalUrl: current.toString(), status: res.status, title, text, emails: extractEmails(html) };
    }
    return { ok: false, error: "for mange viderestillinger" };
  } catch (err: any) {
    return { ok: false, error: err?.name === "AbortError" ? "timeout (10s)" : `fetch fejlede: ${String(err?.message || err).slice(0, 160)}` };
  } finally {
    clearTimeout(timer);
  }
}
