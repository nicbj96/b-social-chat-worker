import * as Sentry from "@sentry/cloudflare";
import { cityToBBox } from "./city-bbox";
import { SYSTEM_PROMPT } from "./system-prompt";
import { promptVersion } from "./promptVersion";

// Derived from the prompt text, not hand-maintained: a version somebody has
// to remember to bump is wrong the first time anyone edits in a hurry.
const PROMPT_VERSION = promptVersion(SYSTEM_PROMPT);
import { TOOLS } from "./tools";
import {
  createSupabaseClient,
  searchEvents,
  searchRoutes,
  searchPlaces,
} from "./supabase-queries";
import { sendWebPush, type PushMessage } from "./webpush";
import { isSafeEntityId, isValidUuid, clampString, clampNumber } from "./validate";
import { guardedFetch } from "./fetchguard";
import { enforceRateLimit, enforceAiDailyBudget, type RateLimitEnv } from "./ratelimit";
import { runAiCounted, aiCostSnapshot } from "./aiCost";
import { aiBreakerIsOpen, formatFallbackReply, inferDiscoveryIntent, inferResponseLanguage, isAiQuotaError, isDiscoverySeekingMessage, looksUngroundedDiscoveryReply, recordAiFailure, recordAiSuccess, repairContradictoryGroundedReply } from "./discovery-fallback";

export { RateLimitDurableObject } from "./rate-limit-do";

// Env bindings
interface Env extends RateLimitEnv {
  AI: any; // Workers AI binding
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
  PUSH_ADMIN_KEY?: string;
  SENTRY_DSN?: string;
  SENTRY_RELEASE?: string;
  COMMAND_CENTER_INGEST_URL?: string;
  COMMAND_CENTER_INGEST_TOKEN?: string;
  COMMAND_CENTER_ACCESS_CLIENT_ID?: string;
  COMMAND_CENTER_ACCESS_CLIENT_SECRET?: string;
  ADMIN_ASK_KEY?: string; // Phase 2.5: gates /admin/ask (Telegram "bare spørg")
  WHISPER_MODEL?: string; // Phase 7: override speech-to-text model
  ELEVENLABS_API_KEY?: string; // Phase 7.4: if set, use ElevenLabs Scribe (best Danish STT) as primary
}

// Chat message type
interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
  tool_calls?: any[];
}

// CORS headers — tillad din frontend at kalde denne Worker
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://b-social.net",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Admin-Key",
};

// Bare worker — Sentry wraps this below.
const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Parse the URL
    const url = new URL(request.url);

    // Native Cloudflare limits protect every AI-, push-, and admin-cost path
    // before body parsing, authorization work, database calls, or model usage.
    const rateLimitResponse = await enforceRateLimit(request, env, url.pathname, CORS_HEADERS);
    if (rateLimitResponse) return rateLimitResponse;

    // Global daily AI spend ceiling (aggregate neuron budget across all actors,
    // which the per-actor velocity limit above cannot see). Fail-open.
    const aiBudgetResponse = await enforceAiDailyBudget(request, env, url.pathname, CORS_HEADERS);
    if (aiBudgetResponse) return aiBudgetResponse;

    if (url.pathname === "/chat" && request.method === "POST") {
      return handleChat(request, env, ctx);
    }

    // Embed one or many texts — returns 1024-dim bge-m3 vectors
    if (url.pathname === "/embed" && request.method === "POST") {
      return handleEmbed(request, env);
    }

    // Semantic search endpoint — callable by frontend directly
    if (url.pathname === "/search" && request.method === "POST") {
      return handleSemanticSearch(request, env);
    }

    // Push notifications
    if (url.pathname === "/push/send" && request.method === "POST") {
      return handlePushSend(request, env);
    }
    if (url.pathname === "/push/broadcast" && request.method === "POST") {
      return handlePushBroadcast(request, env);
    }

    // Admin "bare spørg" (Mission Control V2, Phase 2.5). Public doorway the
    // Telegram bot can reach; relays to the dashboard /api/ask brain (which has
    // env.AI + service-role Supabase) carrying the CF Access service token this
    // worker already holds. Gated by the shared ADMIN_ASK_KEY.
    if (url.pathname === "/admin/ask" && request.method === "POST") {
      return handleAdminAsk(request, env);
    }

    // Fire a dashboard marketing robot on demand (cron also calls it Mondays).
    if (url.pathname === "/admin/robot" && request.method === "POST") {
      return handleRobotTrigger(request, env);
    }

    // SSRF-guarded external fetch (Phase 5) — research / partner-finder egress.
    if (url.pathname === "/admin/fetch" && request.method === "POST") {
      return handleAdminFetch(request, env);
    }

    // Speech-to-text (Phase 7) — Telegram voice notes → Whisper → text.
    if (url.pathname === "/admin/transcribe" && request.method === "POST") {
      return handleTranscribe(request, env);
    }

    // Text-to-image (Phase 7) — Flux generates ad imagery. Returns base64 PNG.
    if (url.pathname === "/admin/image" && request.method === "POST") {
      return handleImage(request, env);
    }

    // Image understanding (Phase 7) — describe a photo the founder shows us.
    if (url.pathname === "/admin/ai-cost" && request.method === "GET") {
      // Estimated AI spend for THIS isolate. Admin-gated: call volume is
      // operational data, not public. Estimate only -- Cloudflare returns no
      // usage to the Worker, so this is calls x published neuron rates, labelled
      // as such. It is the counting a real budget is blocked on, not a bill.
      if (request.headers.get("X-Admin-Ask-Key") !== env.ADMIN_ASK_KEY) {
        return jsonResponse({ ok: false, error: "unauthorized" }, 401);
      }
      return jsonResponse({ ok: true, estimate: true, ...aiCostSnapshot() });
    }

    if (url.pathname === "/admin/vision" && request.method === "POST") {
      return handleVision(request, env);
    }

    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok", service: "b-social-chat" });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },

  // Scheduled jobs (configured in wrangler.toml crons):
  //   "0 17 * * 5" (Fri 17:00) → weekly push digest
  //   "0 6 * * 1"  (Mon 06:00) → trigger the ad-pack robot in the dashboard
  //   "0 7 * * 3"  (Wed 07:00) → trigger the partner-finder robot
  //   "0 7 * * 4"  (Thu 07:00) → source-discovery + data-quality scan robots
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    if (controller.cron === "0 6 * * 1") {
      ctx.waitUntil(callRobot(env, "adpack").then(() => {}));
    } else if (controller.cron === "0 7 * * 3") {
      ctx.waitUntil(callRobot(env, "partners").then(() => {}));
    } else if (controller.cron === "0 7 * * 4") {
      // Two independent read-only scouts share Thursday's tick — the Workers
      // cron-trigger budget is limited (a 5th trigger is rejected) and both just
      // queue a draft, so one cron firing both is the right trade.
      ctx.waitUntil(Promise.all([callRobot(env, "sources"), callRobot(env, "quality")]).then(() => {}));
    } else {
      ctx.waitUntil(runWeeklyDigest(env));
    }
  },
};

// Call a dashboard marketing robot (Mission Control V2, Phase 4). The robot logic
// lives in the dashboard (env.AI + service role); this worker holds the CF Access
// service token, so it is the doorway — fired by cron (scheduled) or on demand
// (/admin/robot). Returns the dashboard's status + body.
async function callRobot(env: Env, name: string): Promise<{ status: number; data: any }> {
  if (!env.COMMAND_CENTER_INGEST_URL || !env.ADMIN_ASK_KEY) {
    return { status: 503, data: { ok: false, error: "robot trigger not configured" } };
  }
  let url: string;
  try {
    url = new URL(`/api/robots/${name}`, env.COMMAND_CENTER_INGEST_URL).toString();
  } catch {
    return { status: 500, data: { ok: false, error: "bad command center url" } };
  }
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-admin-ask-key": env.ADMIN_ASK_KEY,
  };
  if (env.COMMAND_CENTER_ACCESS_CLIENT_ID && env.COMMAND_CENTER_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.COMMAND_CENTER_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.COMMAND_CENTER_ACCESS_CLIENT_SECRET;
  }
  try {
    const r = await fetch(url, { method: "POST", headers, body: "{}", signal: AbortSignal.timeout(60_000) });
    const data = await r.json().catch(() => ({ ok: false, error: "bad robot response" }));
    return { status: r.status, data };
  } catch (err: any) {
    return { status: 502, data: { ok: false, error: `robot call failed: ${String(err?.message || err)}` } };
  }
}

// On-demand robot trigger (test / "kør nu"). Gated by the shared ADMIN_ASK_KEY.
async function handleRobotTrigger(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_ASK_KEY) return jsonResponse({ ok: false, error: "not configured" }, 503);
  if (request.headers.get("X-Admin-Ask-Key") !== env.ADMIN_ASK_KEY) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  let name = "";
  try {
    const b = (await request.json()) as { name?: string };
    name = String(b?.name || "");
  } catch {
    return jsonResponse({ ok: false, error: "bad json" }, 400);
  }
  if (!/^[a-z]+$/.test(name)) return jsonResponse({ ok: false, error: "bad robot name" }, 400);
  const res = await callRobot(env, name);
  return jsonResponse(res.data, res.status);
}

// SSRF-guarded external fetch (Phase 5). Gated by the shared ADMIN_ASK_KEY — only
// internal callers (the research tool, the partner-finder) reach the open web,
// and every URL passes through guardedFetch's allow-rules + redirect re-checks.
async function handleAdminFetch(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_ASK_KEY) return jsonResponse({ ok: false, error: "not configured" }, 503);
  if (request.headers.get("X-Admin-Ask-Key") !== env.ADMIN_ASK_KEY) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  let target = "";
  try {
    const b = (await request.json()) as { url?: string };
    target = String(b?.url || "");
  } catch {
    return jsonResponse({ ok: false, error: "bad json" }, 400);
  }
  if (!target) return jsonResponse({ ok: false, error: "url required" }, 400);
  const result = await guardedFetch(target);
  return jsonResponse(result, result.ok ? 200 : 400);
}

// Speech-to-text via Workers AI Whisper (Phase 7). Body = raw audio bytes (e.g. a
// Telegram voice note, OGG/Opus). Whisper is multilingual → Danish works. Gated by
// the shared ADMIN_ASK_KEY. Returns { ok, text }.
// Voice is ALWAYS Danish — but the founder speaks DANGLISH: Danish sentences with
// English tech/command words kept in English ("kør ad-pack", "vores MRR", "åbn
// dashboard"). Whisper only honors the LAST ~224 tokens of initial_prompt and only
// for the first 30s, so this is deliberately SHORT and natural (a flat word-dump
// hurts). The big glossary lives in DA_GLOSSARY (the LLM correction pass has room
// the Whisper prompt does not). Rarest proper nouns go LAST — that's where Whisper
// weights hardest. This only biases spelling of proper nouns; it is not the fix.
const DA_VOICE_VOCAB =
  "Kommando på dansk til B-Social admin-bot. Vi blander engelske fagord ind i dansk: " +
  "ad-pack, waitlist, MRR, Plus, dashboard, events, venues, partner-liste, newsletter. " +
  "Fx: kør ad-pack, find partnere, vis køen, hvad venter på mit ja, godkend, afvis, fortryd, " +
  "lav et billede, hvor mange brugere, hvor mange events i weekenden, hvordan går det. " +
  "Steder: København, Aarhus, Odense, Aalborg, Berlin.";

// The COMPREHENSIVE Danish knowledge the corrector uses — this is where "no holding
// back" belongs. Unlike Whisper's ~224-token prompt cap, the LLM reads all of this.
// It teaches the corrector (1) which English tech words are CORRECT and must never
// be translated, (2) the full command surface, and (3) the exact acoustic mis-hears
// Danish speech produces, so it can undo them. Extend freely — only the LLM sees it.
const DA_GLOSSARY =
  // — Danglish: English words that are CORRECT inside Danish sentences (never translate) —
  "ENGELSKE FAGORD DER SKAL BEVARES PRÆCIS (aldrig oversæt til dansk): ad-pack, waitlist, MRR, ARR, " +
  "Plus, Plus-abonnent, dashboard, event, events, venue, venues, partner, partner-liste, newsletter, " +
  "robot, robotter, growth, churn, lead, leads, pipeline, deal, deals, onboarding, review, brief, " +
  "digest, import, export, feed, tag, tags, filter, preview, draft, backup, cron, worker, webhook, " +
  "Telegram, Supabase, Cloudflare, Resend, Stripe, KPI, ROI, CTR, DAU, MAU.\n" +
  // — Commands the founder says (and their common variants) —
  "KOMMANDOER: kør ad-pack / lav en annonce / lav reklame; find partnere / lav en partner-liste / " +
  "hvem kan vi samarbejde med; frys robotterne / sæt robotterne på pause / stop robotterne; " +
  "start robotterne / genoptag robotterne; vis køen / hvad venter på mit ja / hvad skal jeg godkende / " +
  "vis udkast; godkend / ja / send den; afvis / nej / drop den; fortryd / stop / annuller; " +
  "ryd op i køen / slet gamle udkast; lav et billede / lav grafik; undersøg / tjek / kig på; " +
  "svar kunden / svar på beskeden; husk at …; hvor mange brugere / events / venues / på waitlist; " +
  "hvor mange events i weekenden / i dag / i morgen / denne uge; hvordan går det / hvordan udvikler vi os / " +
  "vokser vi; hvad er vores MRR / hvad tjener vi; hvad skete der i nat / hvad har robotterne lavet.\n" +
  // — Domain nouns (Danish side) —
  "FAGORD (dansk): arrangement, arrangementer, begivenhed, sted, steder, spillested, bruger, brugere, " +
  "medlem, venteliste, abonnent, abonnement, omsætning, indtægt, indbakke, besked, beskeder, henvendelse, " +
  "kunde, kunder, samarbejdspartner, udkast, annonce, annoncer, nyhedsbrev, kampagne, statistik, " +
  "nøgletal, vækst, kontrolcenter, kø.\n" +
  // — Danish + Nordic/EU place names the founder actually says —
  "STEDER: København, Aarhus, Odense, Aalborg, Esbjerg, Randers, Kolding, Horsens, Vejle, Roskilde, " +
  "Herning, Helsingør, Silkeborg, Næstved, Fredericia, Viborg, Frederiksberg, Nørrebro, Vesterbro, " +
  "Amager, Malmö, Göteborg, Stockholm, Oslo, Bergen, Helsinki, Berlin, Hamborg, Amsterdam, London, Paris.\n" +
  // — The exact mis-hears Danish speech produces → what was really meant —
  "TYPISKE HØR-FEJL (venstre = forkert, højre = rettet): 'at pakke'/'ad pak'/'ad pack' → ad-pack; " +
  "'vent liste'/'weit list'/'wait list' → waitlist; 'em og er'/'em år er'/'em-r-r' → MRR; " +
  "'plus abonnenter' → Plus-abonnenter; 'partner liste' → partner-liste; 'news letter' → newsletter; " +
  "'dash board' → dashboard; 'ivent'/'ivents' → event/events; 'vænju'/'vænjus' → venue/venues; " +
  "'fris robotterne' → frys robotterne; 'gør kend'/'god kendt' → godkend; 'af viss' → afvis; " +
  "'for tryd' → fortryd; 'kø en'/'kunden' → køen (når det handler om udkast); " +
  "'i går' vs 'i dag', 'to' vs 'tolv' vs 'tyve', 'Ålborg' → Aalborg, 'Århus' → Aarhus.";

// Second-pass correction: this is the REAL Danish upgrade (not the Whisper prompt).
// A small LLM cleans up the acoustic model's Danish mis-hears using the full
// DA_GLOSSARY — which is far larger than anything Whisper's 224-token prompt can
// hold. It knows the danglish rule (keep English tech words), the command surface,
// and the exact mis-hears to undo. Conservative by design: on any doubt (empty, too
// long/short, refusal-ish) it returns the raw transcription unchanged.
async function correctDanish(env: Env, raw: string): Promise<string> {
  const text = (raw || "").trim();
  if (!text || text.length > 400) return text;
  try {
    const out: any = await runAiCounted(env.AI, "@cf/meta/llama-4-scout-17b-16e-instruct", {
      messages: [
        {
          role: "system",
          content:
            "Du renser en dansk tale-transskription fra en B-Social admin-bot. Talen er ALTID dansk, men vi taler DANGLISH: " +
            "danske sætninger med engelske fag- og kommando-ord indeni. " +
            "REGLER: (1) Behold ALLE engelske fagord præcis som de er — oversæt dem ALDRIG til dansk " +
            "(fx 'ad-pack' må aldrig blive 'reklamepakke', 'waitlist' aldrig 'venteliste', 'dashboard' aldrig 'kontrolpanel'). " +
            "(2) Ret KUN tydelige hør-fejl til det ord der faktisk blev sagt, ud fra ordbogen nedenfor. " +
            "(3) Bevar betydning og ordrækkefølge 100%. Tilføj intet, forklar intet, gæt ikke nye ord. " +
            "(4) Er sætningen allerede korrekt, så gengiv den uændret. Svar KUN med den rensede sætning, intet andet.\n\n" +
            DA_GLOSSARY,
        },
        { role: "user", content: `Rens denne transskription (svar kun med sætningen): "${text}"` },
      ],
      temperature: 0.1,
      max_completion_tokens: 160,
    });
    let fixed = String(out?.response ?? out?.content ?? "").trim();
    fixed = fixed.replace(/^["'«»\s]+|["'«»\s]+$/g, "").replace(/^(rettet|korrekt|renset|svar)[:\-]\s*/i, "").trim();
    // Guards against over-correction / hallucination: keep raw if wildly different.
    if (!fixed || fixed.length > text.length * 2.5 || fixed.length < text.length * 0.4) return text;
    return fixed;
  } catch {
    return text;
  }
}

// Tier 1 STT: ElevenLabs Scribe — best Danish by far (≈4% WER vs ≈15% for Whisper
// turbo). One multipart POST; it decodes raw Telegram OGG/Opus itself. Only used
// when ELEVENLABS_API_KEY is set: the moment the founder runs
// `wrangler secret put ELEVENLABS_API_KEY` this becomes primary with no code change.
// Throws on any non-2xx / empty so the caller falls back to Cloudflare Whisper.
async function transcribeScribe(env: Env, bytes: Uint8Array): Promise<string> {
  const fd = new FormData();
  fd.append("file", new Blob([bytes], { type: "audio/ogg" }), "audio.ogg");
  fd.append("model_id", "scribe_v1");
  fd.append("language_code", "da"); // voice is ALWAYS Danish
  const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY as string },
    body: fd,
    signal: AbortSignal.timeout(20_000),
  });
  if (!r.ok) throw new Error(`scribe ${r.status}`);
  const data: any = await r.json();
  const text = String(data?.text ?? "").trim();
  if (!text) throw new Error("scribe empty");
  return text;
}

// Tier 2 STT: Cloudflare Whisper large-v3-turbo. Forces Danish, disables
// condition_on_previous_text (CF default is TRUE → repetition/drift hallucinations
// on short one-shot commands) and trims silence with vad_filter. initial_prompt only
// SOFTLY biases proper-noun spelling — the real cleanup happens in correctDanish().
async function transcribeTurbo(env: Env, bytes: Uint8Array): Promise<{ text: string; model: string }> {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const audioB64 = btoa(binary);
  const model = env.WHISPER_MODEL || "@cf/openai/whisper-large-v3-turbo";
  const out: any = await runAiCounted(env.AI, model, {
    audio: audioB64,
    task: "transcribe",
    language: "da", // voice is ALWAYS Danish — force it, never auto-detect
    condition_on_previous_text: false,
    vad_filter: true,
    initial_prompt: DA_VOICE_VOCAB,
  });
  return { text: String(out?.text ?? "").trim(), model };
}

async function handleTranscribe(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_ASK_KEY) return jsonResponse({ ok: false, error: "not configured" }, 503);
  if (request.headers.get("X-Admin-Ask-Key") !== env.ADMIN_ASK_KEY) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  let bytes: Uint8Array;
  try {
    const buf = await request.arrayBuffer();
    if (!buf || buf.byteLength === 0) return jsonResponse({ ok: false, error: "no audio" }, 400);
    if (buf.byteLength > 8_000_000) return jsonResponse({ ok: false, error: "audio too large" }, 400);
    bytes = new Uint8Array(buf);
  } catch {
    return jsonResponse({ ok: false, error: "could not read audio" }, 400);
  }

  // STT ladder, best Danish first: ElevenLabs Scribe (if key) → CF turbo → base
  // Whisper. Whatever wins goes through the danglish-aware correction pass. Voice
  // never dies outright — it just degrades to a cheaper model.
  let text = "";
  let model = "";
  let usedFallback = false;
  let lastErr: any = null;

  if (env.ELEVENLABS_API_KEY) {
    try {
      text = await transcribeScribe(env, bytes);
      model = "elevenlabs/scribe_v1";
    } catch (err) {
      lastErr = err;
    }
  }

  if (!text) {
    try {
      const r = await transcribeTurbo(env, bytes);
      text = r.text;
      model = r.model;
      usedFallback = Boolean(env.ELEVENLABS_API_KEY); // Scribe was meant to be primary
    } catch (err) {
      lastErr = err;
    }
  }

  if (!text) {
    // Last resort: base Whisper (no language control, but better than silence).
    try {
      const out: any = await runAiCounted(env.AI, "@cf/openai/whisper", { audio: [...bytes] });
      text = String(out?.text ?? "").trim();
      model = "@cf/openai/whisper";
      usedFallback = true;
    } catch (err) {
      lastErr = err;
    }
  }

  if (!text) {
    return jsonResponse(
      { ok: false, error: `transcribe failed: ${String(lastErr?.message || lastErr || "no text").slice(0, 160)}` },
      502
    );
  }

  // The real Danish fix: clean domain terms/commands + protect danglish words.
  text = await correctDanish(env, text);
  return jsonResponse({ ok: true, text, model, fallback: usedFallback });
}

// Text-to-image via Workers AI Flux (Phase 7). Returns { ok, image_b64 } (PNG,
// base64). Gated by ADMIN_ASK_KEY. The prompt is capped to keep it cheap.
async function handleImage(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_ASK_KEY) return jsonResponse({ ok: false, error: "not configured" }, 503);
  if (request.headers.get("X-Admin-Ask-Key") !== env.ADMIN_ASK_KEY) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  let prompt = "";
  try {
    const b = (await request.json()) as { prompt?: string };
    prompt = clampString(String(b?.prompt || ""), 800);
  } catch {
    return jsonResponse({ ok: false, error: "bad json" }, 400);
  }
  if (!prompt.trim()) return jsonResponse({ ok: false, error: "prompt required" }, 400);
  try {
    const out: any = await runAiCounted(env.AI, "@cf/black-forest-labs/flux-1-schnell", { prompt, steps: 4 });
    // Flux returns { image: "<base64 jpeg>" }.
    const image = out?.image ? String(out.image) : "";
    if (!image) return jsonResponse({ ok: false, error: "no image returned" }, 502);
    return jsonResponse({ ok: true, image_b64: image, mime: "image/jpeg" });
  } catch (err: any) {
    return jsonResponse({ ok: false, error: `image failed: ${String(err?.message || err).slice(0, 160)}` }, 502);
  }
}

// Image understanding via Workers AI vision (Phase 7). Body = { image_b64, prompt? }.
// Returns { ok, text } describing the picture. Gated by ADMIN_ASK_KEY, size-capped.
async function handleVision(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_ASK_KEY) return jsonResponse({ ok: false, error: "not configured" }, 503);
  if (request.headers.get("X-Admin-Ask-Key") !== env.ADMIN_ASK_KEY) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  let b64 = "";
  let prompt = "";
  try {
    const b = (await request.json()) as { image_b64?: string; prompt?: string };
    b64 = String(b?.image_b64 || "").replace(/^data:[^,]+,/, ""); // strip any data: prefix
    prompt = clampString(String(b?.prompt || "Describe this image in detail — what it shows, style, mood, colors — for a marketer who might recreate it."), 500);
  } catch {
    return jsonResponse({ ok: false, error: "bad json" }, 400);
  }
  if (!b64) return jsonResponse({ ok: false, error: "image_b64 required" }, 400);
  if (b64.length > 8_000_000) return jsonResponse({ ok: false, error: "image too large" }, 400);
  try {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const out: any = await runAiCounted(env.AI, "@cf/llava-hf/llava-1.5-7b-hf", { image: [...bytes], prompt, max_tokens: 300 });
    const text = String(out?.description ?? out?.response ?? "").trim();
    if (!text) return jsonResponse({ ok: false, error: "no description" }, 502);
    return jsonResponse({ ok: true, text });
  } catch (err: any) {
    return jsonResponse({ ok: false, error: `vision failed: ${String(err?.message || err).slice(0, 160)}` }, 502);
  }
}


// Wrap with Sentry — auto-captures unhandled errors in fetch + scheduled.
// No-ops cleanly when SENTRY_DSN is unset (e.g. local dev).
export default Sentry.withSentry(
  (env: Env) => ({
    dsn: env.SENTRY_DSN,
    environment: "production",
    release: env.SENTRY_RELEASE ?? "dev",
    tracesSampleRate: 0.1,
    sendDefaultPii: false,
  }),
  worker,
);

// ── Push send helpers ─────────────────────────────────────────────────

async function fetchSubsForUser(env: Env, userId: string) {
  // C1 — encodeURIComponent the userId (defense-in-depth). The admin-supplied
  // id is UUID-validated by the caller (handlePushSend); encoding here protects
  // against any future caller that forgets to validate first.
  const r = await fetch(
    `${env.SUPABASE_URL}/rest/v1/push_subscriptions?user_id=eq.${encodeURIComponent(userId)}&enabled=eq.true&select=endpoint,p256dh,auth`,
    { headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` } }
  );
  // C4 — Supabase may return an error object ({message,code}) instead of an
  // array; coerce to [] so a Supabase error degrades to "no subscriptions".
  const data = await r.json();
  return (Array.isArray(data) ? data : []) as Array<{ endpoint: string; p256dh: string; auth: string }>;
}

async function disableSubscription(env: Env, endpoint: string) {
  await fetch(`${env.SUPABASE_URL}/rest/v1/push_subscriptions?endpoint=eq.${encodeURIComponent(endpoint)}`, {
    method: "PATCH",
    headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ enabled: false }),
  });
}

function vapidFromEnv(env: Env) {
  return { publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT };
}

// Resolve the Supabase user id for a Bearer JWT, or null if invalid/absent.
// Same verification pattern handleChat uses (GET /auth/v1/user with the JWT).
async function resolveUserIdFromJwt(env: Env, request: Request): Promise<string | null> {
  const authHeader = request.headers.get("Authorization");
  const userJwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!userJwt) return null;
  try {
    const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
      headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${userJwt}` },
    });
    if (!userRes.ok) return null;
    const u = (await userRes.json()) as any;
    return u?.id || null;
  } catch {
    return null;
  }
}

async function handlePushSend(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as { user_id: string; message: PushMessage };
    if (!body.user_id || !body.message?.title) return jsonResponse({ error: "user_id + message.title required" }, 400);

    // C1 — validate user_id is a UUID BEFORE any subscription fetch, on BOTH
    // the admin and JWT paths. Previously the admin path passed body.user_id
    // straight to fetchSubsForUser, which interpolated it raw into the
    // PostgREST `user_id=eq.<value>` URL (the JWT path's id is already a UUID).
    if (!isValidUuid(body.user_id)) return jsonResponse({ error: "invalid user_id" }, 400);

    // S1 (HIGH) — /push/send was previously UNAUTHENTICATED: anyone could push
    // arbitrary notifications to any user's devices (phishing/spam). Require
    // EITHER a valid admin key OR a user JWT whose resolved id == body.user_id
    // (a user may only push to their OWN devices).
    // OWNER-VERIFY: confirm the real /push/send caller sends one of these
    // credentials (X-Admin-Key OR a per-user Bearer JWT) BEFORE merging/
    // deploying — the legitimate caller is currently unknown. If the caller
    // relies on the old unauthenticated behavior this WILL break it (by design).
    const adminKey = request.headers.get("X-Admin-Key");
    const isAdmin = !!env.PUSH_ADMIN_KEY && adminKey === env.PUSH_ADMIN_KEY;
    if (!isAdmin) {
      const callerUserId = await resolveUserIdFromJwt(env, request);
      if (!callerUserId || callerUserId !== body.user_id) {
        return jsonResponse({ error: "unauthorized" }, 401);
      }
    }

    const subs = await fetchSubsForUser(env, body.user_id);
    if (subs.length === 0) return jsonResponse({ sent: 0, reason: "no_subscriptions" });

    const vapid = vapidFromEnv(env);
    const results = await Promise.all(subs.map(async (s) => {
      try {
        const r = await sendWebPush(s, body.message, vapid);
        if (r.status === 404 || r.status === 410) await disableSubscription(env, s.endpoint);
        return { endpoint: s.endpoint.slice(-12), ok: r.ok, status: r.status };
      } catch (e: any) {
        return { endpoint: s.endpoint.slice(-12), ok: false, error: e.message };
      }
    }));
    return jsonResponse({ sent: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results });
  } catch (err: any) {
    return jsonResponse({ error: "push send failed", details: err.message }, 500);
  }
}

// Admin-authenticated broadcast (for weekly digest / announcements)
async function handlePushBroadcast(request: Request, env: Env): Promise<Response> {
  const adminKey = request.headers.get("X-Admin-Key");
  if (!env.PUSH_ADMIN_KEY || adminKey !== env.PUSH_ADMIN_KEY) return jsonResponse({ error: "unauthorized" }, 401);
  try {
    const body = (await request.json()) as { message: PushMessage; where?: { user_ids?: string[] } };
    if (!body.message?.title) return jsonResponse({ error: "message.title required" }, 400);

    let url = `${env.SUPABASE_URL}/rest/v1/push_subscriptions?enabled=eq.true&select=endpoint,p256dh,auth`;
    if (body.where?.user_ids?.length) {
      // S3 — validate each user_id is a UUID before building the PostgREST
      // `in.()` filter. Quoting alone did not prevent a crafted id from
      // injecting extra filter params/operators. Drop invalid ids.
      const safeIds = body.where.user_ids.filter(isValidUuid);
      if (safeIds.length === 0) return jsonResponse({ error: "no valid user_ids" }, 400);
      url += `&user_id=in.(${safeIds.map(i => `"${encodeURIComponent(i)}"`).join(",")})`;
    }

    const r = await fetch(url, { headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` } });
    // C4 — coerce to [] if Supabase returned an error object instead of an array.
    const subsData = await r.json();
    const subs = (Array.isArray(subsData) ? subsData : []) as Array<{ endpoint: string; p256dh: string; auth: string }>;

    const vapid = vapidFromEnv(env);
    let sent = 0, failed = 0;
    for (const s of subs) {
      try {
        const r = await sendWebPush(s, body.message, vapid);
        if (r.ok) sent++; else { failed++; if (r.status === 404 || r.status === 410) await disableSubscription(env, s.endpoint); }
      } catch { failed++; }
    }
    return jsonResponse({ sent, failed, total: subs.length });
  } catch (err: any) {
    return jsonResponse({ error: "broadcast failed", details: err.message }, 500);
  }
}

async function runWeeklyDigest(env: Env) {
  // The weekly digest is the ONLY recurring push, and its frequency controls are
  // structural rather than a runtime counter: the Friday cron caps it at ONE send
  // per subscriber per week, it is a single rolled-up message (never one push per
  // matching event), and the shared `tag` makes a new digest REPLACE any still-
  // unread one on the device instead of stacking. What was missing was hygiene —
  // unlike handlePushBroadcast, this path swallowed every failure, so a
  // subscription the browser had already expired (404/410) was re-pushed every
  // single week forever. It now prunes those and records what it did, so the
  // frequency is spent only on endpoints that still exist.
  const message: PushMessage = {
    title: "B-Social — Weekend guide 🎉",
    body: "Se hvad der sker i weekenden. Nye events matcher dine interesser.",
    url: "/feed",
    tag: "weekly-digest", // one live digest per device: a new one replaces the old
  };
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/push_subscriptions?enabled=eq.true&select=endpoint,p256dh,auth`, {
    headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` },
  });
  // C4 — coerce to [] if Supabase returned an error object instead of an array.
  const subsData = await r.json();
  const subs = (Array.isArray(subsData) ? subsData : []) as Array<{ endpoint: string; p256dh: string; auth: string }>;
  const vapid = vapidFromEnv(env);
  let sent = 0, failed = 0, pruned = 0;
  for (const s of subs) {
    try {
      const res = await sendWebPush(s, message, vapid);
      if (res.ok) {
        sent++;
      } else {
        failed++;
        // A dead endpoint disabled here is one fewer wasted push next week — the
        // same 404/410 cleanup handlePushBroadcast already does on its path.
        if (res.status === 404 || res.status === 410) { await disableSubscription(env, s.endpoint); pruned++; }
      }
    } catch { failed++; }
  }
  // Always-on: a weekly job that silently sends nothing should read as a fact, not
  // a guess. Mirrors the observability added to the rate-limit path.
  console.log(JSON.stringify({ event: "weekly_digest", total: subs.length, sent, failed, pruned }));
}

// ── Embedding endpoint ─────────────────────────────────────────────
// bge-m3 is multilingual (strong for Danish), 1024-dim cosine embeddings
async function handleEmbed(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as { text?: string; texts?: string[] };
    const rawTexts = body.texts ?? (body.text ? [body.text] : []);
    if (rawTexts.length === 0) return jsonResponse({ error: "text or texts required" }, 400);
    if (rawTexts.length > 100) return jsonResponse({ error: "max 100 texts per call" }, 400);

    // C2 — clamp each text to a sane max and drop empty/whitespace-only
    // entries, so an oversized embed payload can't run up AI cost.
    const MAX_EMBED_CHARS = 2000;
    const texts = rawTexts
      .map((t) => clampString(t, MAX_EMBED_CHARS))
      .filter((t) => t.trim().length > 0);
    if (texts.length === 0) return jsonResponse({ error: "text or texts required" }, 400);

    const result: any = await runAiCounted(env.AI, "@cf/baai/bge-m3", { text: texts });
    // bge-m3 returns { data: number[][] } or { shape, data }
    const embeddings = result?.data ?? [];
    return jsonResponse({ embeddings, count: embeddings.length, dim: embeddings[0]?.length ?? 0 });
  } catch (err: any) {
    // Public endpoint: the exception text goes to the log, never to the caller.
    // See the /chat handler for what this used to hand out.
    console.error("Embed error:", err);
    return jsonResponse({ error: "embed failed" }, 500);
  }
}

// ── Semantic search endpoint ───────────────────────────────────────
// Query text → embedding → pgvector match via Supabase RPC
async function handleSemanticSearch(request: Request, env: Env): Promise<Response> {
  try {
    const body = (await request.json()) as {
      query: string;
      kind?: "events" | "places" | "both";
      count?: number;
      threshold?: number;
      country?: string;
      bbox?: { n: number; s: number; e: number; w: number };
    };
    if (!body.query) return jsonResponse({ error: "query required" }, 400);

    // C3 — clamp the query length before embedding (cost/abuse guard).
    const query = clampString(body.query, 1000);
    if (query.trim().length === 0) return jsonResponse({ error: "query required" }, 400);

    const emb: any = await runAiCounted(env.AI, "@cf/baai/bge-m3", { text: [query] });
    const vec = emb?.data?.[0];
    if (!vec) return jsonResponse({ error: "embedding failed" }, 500);

    const kind = body.kind ?? "both";
    // C3 — clamp match_count to [1,50] and threshold to [0,1] so an absurd
    // value can't be passed to the Supabase RPC.
    const count = clampNumber(body.count, 1, 50, 10);
    const threshold = clampNumber(body.threshold, 0, 1, 0.3);

    const sbHeaders = {
      apikey: env.SUPABASE_KEY,
      Authorization: `Bearer ${env.SUPABASE_KEY}`,
      "Content-Type": "application/json",
    };

    const out: any = { events: [], places: [] };

    if (kind === "events" || kind === "both") {
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_events`, {
        method: "POST",
        headers: sbHeaders,
        body: JSON.stringify({
          query_embedding: vec,
          match_count: count,
          match_threshold: threshold,
          filter_country: body.country ?? null,
        }),
      });
      out.events = await r.json();
    }
    if (kind === "places" || kind === "both") {
      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_places`, {
        method: "POST",
        headers: sbHeaders,
        body: JSON.stringify({
          query_embedding: vec,
          match_count: count,
          match_threshold: threshold,
          filter_country: body.country ?? null,
          filter_bbox_n: body.bbox?.n ?? null,
          filter_bbox_s: body.bbox?.s ?? null,
          filter_bbox_e: body.bbox?.e ?? null,
          filter_bbox_w: body.bbox?.w ?? null,
        }),
      });
      out.places = await r.json();
    }
    return jsonResponse(out);
  } catch (err: any) {
    // Public endpoint: the exception text goes to the log, never to the caller.
    console.error("Search error:", err);
    return jsonResponse({ error: "search failed" }, 500);
  }
}

function latestUserMessage(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user" && messages[index].content) return messages[index].content;
  }
  return "";
}

async function notifyCommandCenter(env: Env, message: string, context: unknown) {
  if (!env.COMMAND_CENTER_INGEST_URL || !env.COMMAND_CENTER_INGEST_TOKEN || !message) return;

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-b-social-ingest-token": env.COMMAND_CENTER_INGEST_TOKEN,
  };
  if (env.COMMAND_CENTER_ACCESS_CLIENT_ID && env.COMMAND_CENTER_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.COMMAND_CENTER_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.COMMAND_CENTER_ACCESS_CLIENT_SECRET;
  }

  await fetch(env.COMMAND_CENTER_INGEST_URL, {
    method: "POST",
    headers,
    body: JSON.stringify({
      source: "web_chat",
      channel: "b-social.net chat",
      fromName: "Website visitor",
      subject: "Website chat",
      body: message,
      sentiment: "warm",
      metadata: {
        context,
        worker: "b-social-chat",
        received_at: new Date().toISOString(),
      },
    }),
  });
}

// ── Admin "bare spørg" relay (Phase 2.5) ───────────────────────────────────
// telegram-notify (a Supabase edge fn, no CF Access token) → this public worker
// (holds the CF Access service token) → dashboard /api/ask (env.AI + service
// role). The worker is a thin authenticated relay; the brain lives in the
// dashboard so there is ONE toolset and no service-role key in this public worker.
async function handleAdminAsk(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_ASK_KEY) {
    return jsonResponse({ ok: false, error: "admin ask not configured (set ADMIN_ASK_KEY)" }, 503);
  }
  if (request.headers.get("X-Admin-Ask-Key") !== env.ADMIN_ASK_KEY) {
    return jsonResponse({ ok: false, error: "unauthorized" }, 401);
  }
  if (!env.COMMAND_CENTER_INGEST_URL) {
    return jsonResponse({ ok: false, error: "command center url not configured" }, 503);
  }

  let askUrl: string;
  try {
    askUrl = new URL("/api/ask", env.COMMAND_CENTER_INGEST_URL).toString();
  } catch {
    return jsonResponse({ ok: false, error: "bad command center url" }, 500);
  }

  let payload: { question?: string; message?: string; messages?: unknown } = {};
  try {
    payload = (await request.json()) as typeof payload;
  } catch {
    return jsonResponse({ ok: false, error: "bad json" }, 400);
  }

  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-admin-ask-key": env.ADMIN_ASK_KEY,
  };
  // Same CF Access service token used for inbox-ingest — gets us through Access.
  if (env.COMMAND_CENTER_ACCESS_CLIENT_ID && env.COMMAND_CENTER_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = env.COMMAND_CENTER_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = env.COMMAND_CENTER_ACCESS_CLIENT_SECRET;
  }

  try {
    const r = await fetch(askUrl, {
      method: "POST",
      headers,
      body: JSON.stringify({
        question: clampString(String(payload.question || payload.message || ""), 2000),
        messages: Array.isArray(payload.messages) ? payload.messages : undefined,
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const data = await r.json().catch(() => ({ ok: false, error: "bad upstream response" }));
    return jsonResponse(data, r.status);
  } catch (err: any) {
    return jsonResponse({ ok: false, error: "ask relay failed", details: String(err?.message || err) }, 502);
  }
}

// S4 — conservative input caps (cost + prompt-injection blowup guard).
const MAX_MESSAGES = 30;        // keep only the last N turns
const MAX_MESSAGE_CHARS = 4000; // per-message content cap
const MAX_BODY_BYTES = 256 * 1024; // reject trivially-huge bodies early (256KB)

function normalizePublicChatMessages(value: unknown): ChatMessage[] | null {
  if (!Array.isArray(value)) return null;

  const normalized: ChatMessage[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return null;
    const { role, content } = item as { role?: unknown; content?: unknown };
    if (role !== "user" && role !== "assistant") return null;
    if (typeof content !== "string") return null;
    const clamped = clampString(content, MAX_MESSAGE_CHARS);
    if (!clamped.trim()) return null;
    normalized.push({ role, content: clamped });
  }

  const capped = normalized.slice(-MAX_MESSAGES);
  return capped.some((message) => message.role === "user") ? capped : null;
}

async function directDiscoveryFallback(
  env: Env,
  userMessages: ChatMessage[],
  context: { user_prefs?: { city?: string } },
): Promise<Response> {
  const latestMessage = latestUserMessage(userMessages);
  const intent = inferDiscoveryIntent(latestMessage, context.user_prefs?.city);
  const language = inferResponseLanguage(latestMessage);
  const supabase = createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY);
  let places: any[] = [];
  let events: any[] = [];

  if (intent.kind === "places" || intent.kind === "both") {
    const result = await searchPlaces(supabase, {
      city: intent.city,
      category: intent.placeCategory,
    });
    places = result.results || [];
  }

  if (intent.kind === "events" || intent.kind === "both") {
    const useSpecificTag = intent.queryTag && intent.queryTag !== intent.eventCategory;
    const result = await searchEvents(supabase, {
      city: intent.city,
      category: useSpecificTag ? undefined : intent.eventCategory,
      tags: useSpecificTag ? intent.queryTag : undefined,
    });
    events = result.results || [];
  }

  return jsonResponse(formatFallbackReply(intent, places, events, language));
}

async function handleChat(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
  try {
    // S4 — reject obviously-oversized bodies before parsing/work.
    const declaredLen = Number(request.headers.get("content-length") || 0);
    if (declaredLen > MAX_BODY_BYTES) {
      return jsonResponse({ error: "payload for stor" }, 400);
    }

    // Extract user JWT from Authorization header
    const authHeader = request.headers.get("Authorization");
    const userJwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
    let userId: string | null = null;
    if (userJwt) {
      try {
        const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
          headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${userJwt}` },
        });
        if (userRes.ok) {
          const u = await userRes.json() as any;
          userId = u?.id || null;
        }
      } catch {}
    }

    let body: {
      messages?: { role: string; content: string }[];
      message?: string;
      context?: {
        page?: string;
        pageType?: string;
        active_tags?: string[];
        viewport?: { lat: number; lng: number; zoom: number };
        user_prefs?: { interest_slugs?: string[]; city?: string; group_mode?: string };
        entity_id?: string;
        entity_type?: string;
        recent_views?: { id: string; type: string; tags: string[] }[];
        last_session?: string;
        search_query?: string;
      };
    };
    try {
      // Measure the body we ACTUALLY received, not the one the caller claimed.
      // The content-length check above is a cheap early exit for honest
      // clients; it is not a limit, because a caller can omit the header or use
      // chunked encoding and walk straight past it. A red-team test on
      // 2026-07-22 pushed 300KB through a 256KB "cap" doing exactly that.
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) {
        return jsonResponse({ error: "payload for stor" }, 400);
      }
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return jsonResponse({ error: "Ugyldig forespørgsel" }, 400);
      }
      body = parsed as typeof body;
    } catch {
      return jsonResponse({ error: "Ugyldig JSON" }, 400);
    }

    // Support both { messages: [...] } and { message: "..." } while treating
    // every caller-provided role as untrusted input.
    const rawMessages = Array.isArray(body.messages)
      ? body.messages
      : typeof body.message === "string"
        ? [{ role: "user", content: body.message }]
        : null;
    if (!rawMessages) {
      return jsonResponse({ error: "Mangler 'message' eller 'messages' felt" }, 400);
    }
    const userMessages = normalizePublicChatMessages(rawMessages);
    if (!userMessages) {
      return jsonResponse({ error: "Ugyldige chatbeskeder" }, 400);
    }

    executionCtx.waitUntil(notifyCommandCenter(env, latestUserMessage(userMessages), body.context || {}));

    // Build page-aware context injection for the system prompt
    const ctx = body.context || {};
    const contextLines: string[] = [];
    if (ctx.pageType) {
      const pageLabels: Record<string, string> = {
        feed: "forsiden (Feed)", map: "kortet (Kort)", explore: "Udforsk-siden",
        event: "en event-detalje", place: "en steds-detalje", search: "søgesiden",
      };
      contextLines.push(`Brugerens nuværende side: ${pageLabels[ctx.pageType] || ctx.pageType}.`);
    }
    if (ctx.active_tags && ctx.active_tags.length > 0) {
      // S4 — clamp the joined tag list before injecting into the system prompt.
      contextLines.push(`Aktive filtre på siden: ${clampString(ctx.active_tags.join(", "), 300)}.`);
    }
    if (ctx.viewport) {
      contextLines.push(`Kortets centrum: lat ${ctx.viewport.lat.toFixed(4)}, lng ${ctx.viewport.lng.toFixed(4)}, zoom ${ctx.viewport.zoom}.`);
    }
    if (ctx.user_prefs) {
      const p = ctx.user_prefs;
      // S4 — clamp user-controlled preference strings before prompt injection.
      if (p.city) contextLines.push(`Brugerens by: ${clampString(p.city, 80)}.`);
      if (p.interest_slugs?.length) contextLines.push(`Brugerens interesser: ${clampString(p.interest_slugs.join(", "), 300)}.`);
      if (p.group_mode) contextLines.push(`Bruger foretrækker: ${clampString(p.group_mode, 80)}.`);
    }
    // Phase 5: behavioral history — most recently viewed places/events
    if (ctx.recent_views && ctx.recent_views.length > 0) {
      const recLabels = ctx.recent_views
        .slice(0, 10) // S4 — cap how many recent views we expand
        .map((v: { id: string; type: string; tags: string[] }) =>
          `${v.type === "place" ? "Sted" : "Event"} (${clampString((Array.isArray(v.tags) ? v.tags.slice(0, 2).join(", ") : "") || String(v.id ?? "").slice(0, 8), 80)})`
        )
        .join("; ");
      // S4 — clamp the whole joined label string too.
      contextLines.push(`Senest besøgte: ${clampString(recLabels, 400)}.`);
    }
    // Phase 5: session memory from previous conversation
    if (ctx.last_session) {
      contextLines.push(`Forrige session: ${clampString(ctx.last_session, 200)}`);
    }
    // Step 5: entity context — fetch current event/place name from Supabase
    // S2 — entity_id is user-controlled and was interpolated RAW into the
    // PostgREST `?id=eq.<value>` URL, so a crafted value could append extra
    // params/operators. Validate it's a plausible id (UUID or digits) and
    // encodeURIComponent it; skip the (optional) lookup if invalid.
    if (ctx.entity_id && isSafeEntityId(ctx.entity_id) && (ctx.entity_type === 'event' || ctx.entity_type === 'place')) {
      const safeEntityId = encodeURIComponent(ctx.entity_id);
      try {
        const sbUrl = env.SUPABASE_URL;
        const sbKey = env.SUPABASE_KEY;
        const headers = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };
        if (ctx.entity_type === 'event') {
          const r = await fetch(
            `${sbUrl}/rest/v1/events?id=eq.${safeEntityId}&select=title,location,tags&limit=1`,
            { headers }
          );
          const rows: any[] = await r.json();
          const row = rows[0];
          if (row?.title) {
            const tags = Array.isArray(row.tags) ? row.tags.slice(0,4).join(', ') : '';
            contextLines.push(`Brugeren ser på event: "${row.title}"${row.location ? ` (${row.location})` : ''} ${tags ? `— tags: ${tags}` : ''}.`);
          }
        } else {
          const r = await fetch(
            `${sbUrl}/rest/v1/places?id=eq.${safeEntityId}&select=name,city,main_categories&limit=1`,
            { headers }
          );
          const rows: any[] = await r.json();
          const row = rows[0];
          if (row?.name) {
            const cats = Array.isArray(row.main_categories) ? row.main_categories.slice(0,3).join(', ') : '';
            contextLines.push(`Brugeren ser på sted: "${row.name}"${row.city ? ` i ${row.city}` : ''} ${cats ? `— kategorier: ${cats}` : ''}.`);
          }
        }
      } catch {}
    }
    // Step 6: time + season awareness (server-side, always accurate)
    {
      const now = new Date();
      const days = ['søndag','mandag','tirsdag','onsdag','torsdag','fredag','lørdag'];
      const dayName = days[now.getDay()];
      const h = now.getHours();
      const timeOfDay = h < 6 ? 'nat' : h < 12 ? 'morgen' : h < 17 ? 'eftermiddag' : h < 21 ? 'aften' : 'sen aften';
      const mo = now.getMonth();
      const season = mo >= 2 && mo <= 4 ? 'forår' : mo >= 5 && mo <= 7 ? 'sommer' : mo >= 8 && mo <= 10 ? 'efterår' : 'vinter';
      const isWeekend = now.getDay() === 0 || now.getDay() === 6;
      contextLines.push(`Tidspunkt: ${dayName} ${timeOfDay}, ${season}${isWeekend ? ', weekend' : ', hverdag'}.`);
    }
    const contextNote = contextLines.length > 0
      ? `\n## Nuværende kontekst:\n${contextLines.map(l => `- ${l}`).join("\n")}`
      : "";

    // The static prompt already says "answer in Danish unless the user writes
    // in another language", and the model ignored it: probed live, "hello, can
    // you help me?" and "any good jazz concerts?" both came back in Danish.
    // A hint the model may or may not act on is not a language setting, so the
    // decision is made here and stated as an instruction it cannot miss.
    const replyLanguage = inferResponseLanguage(latestUserMessage(userMessages));
    const languageNote = replyLanguage === "en"
      ? [
          "",
          "## SPROG (VIGTIGST)",
          "Brugeren skriver ENGELSK. Svar UDELUKKENDE på engelsk — hele svaret,",
          "inklusive overskrifter og opfølgende spørgsmål. Skift ikke til dansk undervejs.",
        ].join("\n")
      : [
          "",
          "## SPROG (VIGTIGST)",
          "Brugeren skriver DANSK. Svar udelukkende på dansk.",
        ].join("\n");

    // Build the full conversation with system prompt
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT + contextNote + languageNote },
      ...userMessages,
    ];

    // Breaker: once the AI has failed repeatedly, calling it again only spends
    // the reader's patience on a timeout we already expect. Go straight to the
    // grounded database answer.
    if (aiBreakerIsOpen()) {
      console.error(JSON.stringify({ event: "ai_breaker_open", action: "direct_fallback" }));
      return await directDiscoveryFallback(env, userMessages, ctx);
    }

    // First AI call — may include tool calls
    let aiResponse: any;
    try {
      aiResponse = await runAiCounted(env.AI, "@cf/meta/llama-4-scout-17b-16e-instruct", {
        messages,
        tools: TOOLS,
        tool_choice: "auto",
      });
    } catch (error) {
      // ANY AI failure falls back, not just a quota error. The database answer
      // is grounded and useful; rethrowing gave the reader nothing at all.
      recordAiFailure();
      console.error(JSON.stringify({
        event: "ai_call_failed",
        quota: isAiQuotaError(error),
        detail: String(error instanceof Error ? error.message : error).slice(0, 140),
      }));
      return directDiscoveryFallback(env, userMessages, ctx);
    }
    recordAiSuccess();

    // If the model wants to call tools, execute them
    if (aiResponse.tool_calls && aiResponse.tool_calls.length > 0) {
      const supabase = createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY);

      // Add the assistant's tool-call message
      messages.push({
        role: "assistant",
        content: aiResponse.content || "",
        tool_calls: aiResponse.tool_calls,
      });

      // Execute each tool call; collect place/event IDs for structured response
            const collectedPlaceIds: string[] = [];
            const collectedEventIds: string[] = [];
            const collectedPlaces: { id?: string; name?: string; city?: string }[] = [];
            const collectedEvents: { id?: string; title?: string; location?: string; date?: string }[] = [];

            for (const toolCall of aiResponse.tool_calls) {
              const fnName = toolCall.function.name;
              const fnArgs =
                typeof toolCall.function.arguments === "string"
                  ? JSON.parse(toolCall.function.arguments)
                  : toolCall.function.arguments;

              let result: any;

              switch (fnName) {
                case "semantic_search": {
                  // Use our deployed /search flow internally
                  try {
                    const emb: any = await runAiCounted(env.AI, "@cf/baai/bge-m3", { text: [fnArgs.query] });
                    const vec = emb?.data?.[0];
                    if (!vec) { result = { error: "embedding failed" }; break; }
                    const sbHeaders = { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`, "Content-Type": "application/json" };
                    const kind = fnArgs.kind ?? "both";
                    // Location awareness (2026-07-22): a named city becomes a
                    // real bounding box on both RPCs. Unknown city → null →
                    // unfiltered, never an empty answer.
                    const bbox = cityToBBox(fnArgs.city);
                    const bboxParams = bbox
                      ? { filter_bbox_n: bbox.n, filter_bbox_s: bbox.s, filter_bbox_e: bbox.e, filter_bbox_w: bbox.w }
                      : {};
                    const out: any = { events: [], places: [] };
                    if (kind === "events" || kind === "both") {
                      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_events`, {
                        method: "POST", headers: sbHeaders,
                        body: JSON.stringify({ query_embedding: vec, match_count: 8, match_threshold: 0.3, filter_country: fnArgs.country ?? bbox?.country ?? null, ...bboxParams }),
                      });
                      out.events = await r.json();
                      (out.events || []).forEach((e: any) => {
                        if (!e?.id) return;
                        collectedEventIds.push(e.id);
                        collectedEvents.push({ id: e.id, title: e.title, location: e.location, date: e.date });
                      });
                    }
                    if (kind === "places" || kind === "both") {
                      const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_places`, {
                        method: "POST", headers: sbHeaders,
                        body: JSON.stringify({ query_embedding: vec, match_count: 8, match_threshold: 0.3, filter_country: fnArgs.country ?? bbox?.country ?? null, ...bboxParams }),
                      });
                      out.places = await r.json();
                      (out.places || []).forEach((p: any) => {
                        if (!p?.id) return;
                        collectedPlaceIds.push(p.id);
                        collectedPlaces.push({ id: p.id, name: p.name, city: p.city });
                      });
                    }
                    result = out;
                  } catch (e: any) { result = { error: String(e.message || e) }; }
                  break;
                }
                case "search_events":
                  result = await searchEvents(supabase, fnArgs);
                  if (result.results) {
                    result.results.forEach((e: any) => {
                      if (!e?.id) return;
                      collectedEventIds.push(e.id);
                      collectedEvents.push({ id: e.id, title: e.title, location: e.location, date: e.date });
                    });
                  }
                  break;
                case "search_routes":
                  result = await searchRoutes(supabase, fnArgs);
                  break;
                case "search_places":
                  result = await searchPlaces(supabase, fnArgs);
                  if (result.results) {
                    result.results.forEach((p: any) => {
                      if (!p?.id) return;
                      collectedPlaceIds.push(p.id);
                      collectedPlaces.push({ id: p.id, name: p.name, city: p.city });
                    });
                  }
                  break;

          // ── Write tools (JWT-baseret, RLS-sikrede) ──────────────────────
          case "save_user_tags": {
            if (!userId || !userJwt) { result = { error: "Du skal være logget ind for at gemme dette" }; break; }
            try {
              const userHeaders = {
                apikey: env.SUPABASE_KEY,
                Authorization: `Bearer ${userJwt}`,
                "Content-Type": "application/json",
                Prefer: "return=representation",
              };
              // GET current interests
              const getRes = await fetch(
                `${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}&select=interests`,
                { headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${userJwt}` } }
              );
              const profiles: any[] = await getRes.json();
              const existing: string[] = profiles[0]?.interests || [];
              const newTags: string[] = fnArgs.tags || [];
              const merged = [...new Set([...existing, ...newTags])];
              // PATCH profiles.interests
              await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
                method: "PATCH",
                headers: { ...userHeaders, Prefer: "return=minimal" },
                body: JSON.stringify({ interests: merged }),
              });
              // For each new tag: lookup tag_id in tags_normalized, then upsert user_tags_normalized
              const addedTags = newTags.filter(t => !existing.includes(t));
              const tagResults: { tag: string; saved: boolean }[] = [];
              for (const tag of addedTags) {
                try {
                  const tagLookup = await fetch(
                    `${env.SUPABASE_URL}/rest/v1/tags_normalized?slug=eq.${encodeURIComponent(tag)}&select=id&limit=1`,
                    { headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` } }
                  );
                  const tagRows: any[] = await tagLookup.json();
                  if (tagRows[0]?.id) {
                    await fetch(`${env.SUPABASE_URL}/rest/v1/user_tags_normalized?on_conflict=user_id,tag_id`, {
                      method: "POST",
                      headers: { ...userHeaders, Prefer: "resolution=merge-duplicates,return=minimal" },
                      body: JSON.stringify({ user_id: userId, tag_id: tagRows[0].id, weight: 1.0 }),
                    });
                    tagResults.push({ tag, saved: true });
                  } else {
                    tagResults.push({ tag, saved: false });
                  }
                } catch { tagResults.push({ tag, saved: false }); }
              }
              result = { ok: true, interests: merged, tag_results: tagResults };
            } catch (e: any) { result = { error: "Kunne ikke gemme tags", details: e.message }; }
            break;
          }

          case "save_user_prefs": {
            if (!userId || !userJwt) { result = { error: "Du skal være logget ind for at gemme dette" }; break; }
            try {
              const patch: Record<string, string> = {};
              if (fnArgs.city) patch.city = fnArgs.city;
              if (fnArgs.group_mode) patch.group_mode = fnArgs.group_mode;
              if (fnArgs.energy_level) patch.energy_level = fnArgs.energy_level;
              if (fnArgs.experience_mode) patch.experience_mode = fnArgs.experience_mode;
              if (Object.keys(patch).length === 0) { result = { ok: true, message: "Ingen ændringer" }; break; }
              await fetch(`${env.SUPABASE_URL}/rest/v1/profiles?id=eq.${userId}`, {
                method: "PATCH",
                headers: {
                  apikey: env.SUPABASE_KEY,
                  Authorization: `Bearer ${userJwt}`,
                  "Content-Type": "application/json",
                  Prefer: "return=minimal",
                },
                body: JSON.stringify(patch),
              });
              result = { ok: true, updated: patch };
            } catch (e: any) { result = { error: "Kunne ikke gemme præferencer", details: e.message }; }
            break;
          }

          case "bookmark_place": {
            if (!userId || !userJwt) { result = { error: "Du skal være logget ind for at gemme dette" }; break; }
            try {
              const record: Record<string, string> = { user_id: userId };
              if (fnArgs.place_id) record.place_id = fnArgs.place_id;
              if (fnArgs.event_id) record.event_id = fnArgs.event_id;
              if (!fnArgs.place_id && !fnArgs.event_id) { result = { error: "Angiv place_id eller event_id" }; break; }
              const r = await fetch(`${env.SUPABASE_URL}/rest/v1/saved_places`, {
                method: "POST",
                headers: {
                  apikey: env.SUPABASE_KEY,
                  Authorization: `Bearer ${userJwt}`,
                  "Content-Type": "application/json",
                  Prefer: "return=minimal",
                },
                body: JSON.stringify(record),
              });
              if (!r.ok && r.status !== 409) {
                const errText = await r.text();
                result = { error: "Kunne ikke gemme bogmærke", details: errText };
              } else {
                result = { ok: true, bookmarked: record };
              }
            } catch (e: any) { result = { error: "Kunne ikke gemme bogmærke", details: e.message }; }
            break;
          }

          case "rsvp_event": {
            if (!userId || !userJwt) { result = { error: "Du skal være logget ind for at gemme dette" }; break; }
            try {
              const status = fnArgs.status || "going";
              const r = await fetch(`${env.SUPABASE_URL}/rest/v1/event_rsvps?on_conflict=user_id,event_id`, {
                method: "POST",
                headers: {
                  apikey: env.SUPABASE_KEY,
                  Authorization: `Bearer ${userJwt}`,
                  "Content-Type": "application/json",
                  Prefer: "resolution=merge-duplicates,return=minimal",
                },
                body: JSON.stringify({ user_id: userId, event_id: fnArgs.event_id, status }),
              });
              if (!r.ok) {
                const errText = await r.text();
                result = { error: "Kunne ikke tilmelde til event", details: errText };
              } else {
                result = { ok: true, event_id: fnArgs.event_id, status };
              }
            } catch (e: any) { result = { error: "Kunne ikke tilmelde til event", details: e.message }; }
            break;
          }

          case "add_note": {
            if (!userId || !userJwt) { result = { error: "Du skal være logget ind for at gemme dette" }; break; }
            try {
              const notePayload: Record<string, any> = {
                user_id: userId,
                content: fnArgs.content,
              };
              if (fnArgs.title) notePayload.title = fnArgs.title;
              if (fnArgs.tags && fnArgs.tags.length > 0) notePayload.tags = fnArgs.tags;
              const r = await fetch(`${env.SUPABASE_URL}/rest/v1/notes`, {
                method: "POST",
                headers: {
                  apikey: env.SUPABASE_KEY,
                  Authorization: `Bearer ${userJwt}`,
                  "Content-Type": "application/json",
                  Prefer: "return=representation",
                },
                body: JSON.stringify(notePayload),
              });
              if (!r.ok) {
                const errText = await r.text();
                result = { error: "Kunne ikke oprette note", details: errText };
              } else {
                const rows: any[] = await r.json();
                result = { ok: true, note_id: rows[0]?.id, title: rows[0]?.title };
              }
            } catch (e: any) { result = { error: "Kunne ikke oprette note", details: e.message }; }
            break;
          }

          default:
            result = { error: `Ukendt funktion: ${fnName}` };
        }

        // Add tool result to conversation
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          tool_call_id: toolCall.id,
        });
      }

      // Second AI call — now with data from Supabase
      let finalResponse: any;
      try {
        finalResponse = await runAiCounted(env.AI, "@cf/meta/llama-4-scout-17b-16e-instruct", {
          messages,
        });
      } catch (error) {
        // Same rule as the first call: any failure falls back to grounded
        // database results rather than giving the reader nothing.
        recordAiFailure();
        console.error(JSON.stringify({
          event: "ai_followup_failed",
          quota: isAiQuotaError(error),
          detail: String(error instanceof Error ? error.message : error).slice(0, 140),
        }));
        return directDiscoveryFallback(env, userMessages, ctx);
      }

      // Collect tag slugs from tool arguments (for live filter update on frontend)
      const collectedTagSlugs: string[] = [];
      for (const toolCall of aiResponse.tool_calls) {
        const args = typeof toolCall.function.arguments === "string"
          ? JSON.parse(toolCall.function.arguments)
          : toolCall.function.arguments;
        if (args.category) collectedTagSlugs.push(args.category);
        // args.tags can be string (search_events / search_places) or string[]
        // (save_user_tags). Handle both shapes.
        if (args.tags) {
          const list: string[] = Array.isArray(args.tags)
            ? args.tags
            : String(args.tags).split(",").map((t: string) => t.trim());
          for (const t of list) if (t) collectedTagSlugs.push(t);
        }
      }

      return jsonResponse({
              reply: repairContradictoryGroundedReply(
                finalResponse.response || finalResponse.content || "",
                collectedPlaces,
                collectedEvents,
                inferResponseLanguage(userMessages.map((m) => m.content).join(" ")),
              ),
              tool_calls_made: aiResponse.tool_calls.map((tc: any) => tc.function.name),
              place_ids: collectedPlaceIds,
              event_ids: collectedEventIds,
              suggested_tag_slugs: [...new Set(collectedTagSlugs)],
            });
          }

    // No tool calls — never invent discovery results. Fall back to direct DB search.
    const latest = latestUserMessage(userMessages);
    if (
      isDiscoverySeekingMessage(latest) ||
      looksUngroundedDiscoveryReply(aiResponse.response || aiResponse.content || "")
    ) {
      return await directDiscoveryFallback(env, userMessages, ctx);
    }

    return jsonResponse({
      reply: aiResponse.response || aiResponse.content || "",
      tool_calls_made: [],
      place_ids: [],
      event_ids: [],
      suggested_tag_slugs: [],
    });
  } catch (err: any) {
    // NEVER return err.message here. /chat is unauthenticated, and the raw
    // exception text carries whatever the failure touched -- a red-team test on
    // 2026-07-22 got the Supabase service-role key, an internal IP and a port
    // back in `details` from a single forced error. The log keeps the detail;
    // the caller gets the sentence.
    console.error("Chat error:", err);
    return jsonResponse({ error: "Noget gik galt. Prøv igen." }, 500);
  }
}

// Helper to create JSON responses with CORS
function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Which prompt produced this answer. Without it, editing the prompt and
      // redeploying makes every previous answer unattributable — "it used to
      // say something different" stops being checkable.
      "X-Prompt-Version": PROMPT_VERSION,
      ...CORS_HEADERS,
    },
  });
}
