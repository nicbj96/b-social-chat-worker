import { eventPriceLabel } from "./event-price";
import { normalizeToolCalls } from "./tool-calls";
import { parseSearchIntent } from "./discovery-contract";
import * as Sentry from "@sentry/cloudflare";
import { cityToBBox } from "./city-bbox";
import { narrowSemanticEvents, localizeSemanticRow, matchesTopic, idsByMention } from "./semantic-narrow";
import { SYSTEM_PROMPT } from "./system-prompt";
import { promptVersion } from "./promptVersion";

// Derived from the prompt text, not hand-maintained: a version somebody has
// to remember to bump is wrong the first time anyone edits in a hurry.
const PROMPT_VERSION = promptVersion(SYSTEM_PROMPT);
import { TOOLS } from "./tools";
import {fetchDiscoveryPage,DiscoveryError} from './discovery-retrieval';
import {createClient} from '@supabase/supabase-js';
import {
  createSupabaseClient,
  searchEvents,
  searchRoutes,
  searchPlaces,
} from "./supabase-queries";
import { sendWebPush, type PushMessage } from "./webpush";
import { isSafeEntityId, isValidUuid, clampString, clampNumber } from "./validate";
import { executeSecureAddNote, buildTelemetryEvent } from "./secure-actions";
import { guardedFetch } from "./fetchguard";
import { fetchWeather, haversineKm, estimateTravelMinutes, normalizeMode, isValidLatLng } from "./context-tools";
import { enforceRateLimit, enforceAiDailyBudget, aiCeilingReached, chargeAiDailyBudget, type RateLimitEnv } from "./ratelimit";
import { runAiCounted, aiCostSnapshot, setAiUsageReporter } from "./aiCost";
import { proposeIntentChange, type IntentProposal } from "./chat-intent-proposal";
import { buildGroundedSources, groundModelReply, type GroundedToolResult } from "./grounded-answer";
import { TurnBudget, TurnBudgetExceeded } from "./chat-budget";
import {
  TurnDeadline,
  TurnDeadlineExceeded,
  ResourceCapExceeded,
  RESOURCE_CAPS,
  assertEmbeddingDims,
  capReplyBytes,
  capRows,
  classifyProviderFailure,
  CHAT_TIERS,
  SESSION_BUDGET_WINDOW_MS,
  consumeSessionTurnBudget,
  degradationNotice,
  sessionBudgetKey,
  turnDeadlineMs,
  type DegradationReason,
} from "./chat-provider";
import { rateLimitActorKey } from "./ratelimit";
import { resolveChatTier } from "./plus-tier";
import { chainGenre, rowIsGenre, topicWordHit, nonGenreTopics, GENRES, honestEmptyReply, topicTagList, placeNameNeedles, placeTopicsOf } from "./discovery-fallback";
import { resolveTurnDiscovery, looksLikeEventListing, looksLikeUngroundedFact, clarifyDiscoveryReply } from "./discovery-fallback";
import { aiBreakerIsOpen, searchEventsRelaxing, formatFallbackReply, formatNonCatalogueReply, inferDiscoveryIntent, inferResponseLanguage, isAiQuotaError, isDiscoverySeekingMessage, looksUngroundedDiscoveryReply, recordAiFailure, recordAiSuccess, repairContradictoryGroundedReply } from "./discovery-fallback";
import type { DiscoveryIntent, Relaxation } from "./discovery-fallback";

export { RateLimitDurableObject } from "./rate-limit-do";

// Env bindings
interface Env extends RateLimitEnv {
  AI: any; // Workers AI binding
  SUPABASE_URL: string;
  SUPABASE_KEY: string;
  /** Optional. Preferred for AI-usage telemetry if ever added; the anon
   *  SUPABASE_KEY works too because record_ai_call is token-gated. */
  SUPABASE_SERVICE_ROLE_KEY?: string;
  /** Optional service_role key; lets resolveChatTier read plus_subscriptions without a user JWT. */
  SUPABASE_SERVICE_KEY?: string;
  /** Shared token proving this worker may increment ai_usage_daily. Without it
   *  record_ai_call is a no-op, so the public anon key alone cannot inflate it. */
  AI_USAGE_TOKEN?: string;
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
  CHAT_TURN_DEADLINE_MS?: string; // Plan §9 P188: per-turn wall-clock budget override (tests)
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

// Constant-time secret compare, matching the project's own standard
// (telegram-notify/auth.ts). The eight admin-key checks below used `!==`, a
// short-circuiting compare; unifying them removes the last timing-comparison
// inconsistency in the worker. Fails closed: a null header or an unset env
// secret is not a string, so it returns false and the caller denies. The
// length check leaks length only, which is fixed and public for these keys.
function timingSafeEqualStr(a: string | null | undefined, b: string | null | undefined): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ab = new TextEncoder().encode(a);
  const bb = new TextEncoder().encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}
/** True iff the request carries the correct admin-ask key. Fails closed when
 *  ADMIN_ASK_KEY is unset (an unset secret can never match). */
function adminAskKeyOk(request: Request, env: { ADMIN_ASK_KEY?: string }): boolean {
  return timingSafeEqualStr(request.headers.get("X-Admin-Ask-Key"), env.ADMIN_ASK_KEY);
}

// Bare worker — Sentry wraps this below.
const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    // Parse the URL
    const url = new URL(request.url);

    // Persist AI usage per CALL so the day's neuron spend survives the isolate
    // (workplan 1111). The in-memory counters are per-isolate, so only a per-call
    // write gives the DB a true daily total to divide by active users.
    //
    // This worker's SUPABASE_KEY is the ANON key — proven live: the write was
    // refused with 42501 until anon was briefly granted execute, at which point
    // the row landed immediately. Granting anon outright would be unsafe, since
    // that key ships in the public frontend and anyone could then inflate a COST
    // counter. So record_ai_call is instead TOKEN-GATED (migration
    // 20260724730000): anon may call it, but without AI_USAGE_TOKEN it is a
    // silent no-op. That keeps the counter trustworthy while needing no
    // service-role key here.
    // ONE reporter, always installed, fires per real env.AI.run() call. It does
    // two independent fire-and-forget jobs:
    //   1. Charge the global daily neuron budget by this call's real cost. This
    //      is what makes the budget a spend ceiling instead of a per-request
    //      tax — and it must run regardless of telemetry config, so it lives
    //      OUTSIDE the usageKey/token guard below (an unconfigured telemetry
    //      write must not disable the runaway catch).
    //   2. Persist per-call usage to the DB when telemetry is configured.
    const usageKey = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_KEY;
    const canWriteUsage = Boolean(usageKey && env.AI_USAGE_TOKEN);
    setAiUsageReporter((model, neurons) => {
      // (1) Budget accounting — always. Never blocks or breaks a chat answer.
      ctx.waitUntil(chargeAiDailyBudget(env, neurons));

      // (2) Telemetry — only when a usable key + token exist.
      if (!canWriteUsage) return;
      ctx.waitUntil(
        fetch(`${env.SUPABASE_URL}/rest/v1/rpc/record_ai_call`, {
          method: "POST",
          headers: {
            apikey: usageKey as string,
            Authorization: `Bearer ${usageKey as string}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ p_model: model, p_neurons: neurons, p_token: env.AI_USAGE_TOKEN }),
        })
          .then(async (r) => {
            const body = await r.text().catch(() => "");
            if (!r.ok) {
              console.error(JSON.stringify({ event: "ai_usage_write_failed", status: r.status, detail: body.slice(0, 200) }));
            } else if (body.trim() === "false") {
              // A token mismatch returns HTTP 200 with the body `false`, so
              // checking r.ok alone reports a silent failure as success —
              // exactly the trap that hid this during development. If the
              // token in Cloudflare and ai_usage_config ever drift apart,
              // this is the line that says so.
              console.error(JSON.stringify({ event: "ai_usage_write_rejected", detail: "token mismatch — AI_USAGE_TOKEN does not match ai_usage_config" }));
            }
            return undefined;
          })
          .catch((e) => {
            console.error(JSON.stringify({ event: "ai_usage_write_threw", detail: String(e).slice(0, 200) }));
            return undefined;
          }),
      );
    });

    // Native Cloudflare limits protect every AI-, push-, and admin-cost path
    // before body parsing, authorization work, database calls, or model usage.
    const rateLimitResponse = await enforceRateLimit(request, env, url.pathname, CORS_HEADERS);
    if (rateLimitResponse) return rateLimitResponse;

    // Global daily AI spend ceiling (aggregate neuron budget across all actors,
    // which the per-actor velocity limit above cannot see). Fail-open.
    const aiBudgetResponse = await enforceAiDailyBudget(request, env, url.pathname, CORS_HEADERS);
    if (aiBudgetResponse) return aiBudgetResponse;

    if (url.pathname === "/chat" && request.method === "POST") {
      // Compute truncation from a CLONE — a body can only be read once, and
      // handleChat must still receive an unread stream. Oversized bodies are
      // skipped here: handleChat rejects those with 400 before any of this
      // matters. Best-effort throughout: a probe failure must never fail a
      // legitimate chat request.
      let truncated = false;
      try {
        const raw = await request.clone().text();
        if (raw.length <= MAX_BODY_BYTES) truncated = isChatInputTruncated(JSON.parse(raw));
      } catch {
        truncated = false;
      }
      return await tagTruncatedResponse(await handleChat(request, env, ctx), truncated);
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
      if (!adminAskKeyOk(request, env)) {
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
  if (!adminAskKeyOk(request, env)) {
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
  if (!adminAskKeyOk(request, env)) {
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
  if (!adminAskKeyOk(request, env)) {
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
  if (!adminAskKeyOk(request, env)) {
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
  if (!adminAskKeyOk(request, env)) {
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
  if (!timingSafeEqualStr(adminKey, env.PUSH_ADMIN_KEY)) return jsonResponse({ error: "unauthorized" }, 401);
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
// EVENTS: query text → embedding → pgvector match via Supabase RPC.
// PLACES: the catalogue path. Deliberately not pgvector — see below.
//
// MEASURED LIVE 2026-09-22 (public endpoint, 148,122 places, role anon with
// statement_timeout = 3s):
//
//   POST /search {query:"spisesteder Aarhus", kind:"places"}
//     -> HTTP 200 after ~3.99s, with
//        places = {"code":"57014","message":"canceling statement due to
//                   statement timeout"}
//
// Two defects in one response. `places` has NO vector index, so match_places
// is a full scan that cannot finish inside 3s — the only route to places was
// the one route that always failed, and the caller waited the full timeout to
// receive nothing. And a failed RPC was passed through verbatim, so the field
// the /soeg frontend reads as a list was a PostgREST error OBJECT.
//
// The catalogue path (filter first, rank on `id`, then fetch the wide columns
// by primary key — supabase-queries.ts searchPlaces) answers the same question
// in tens of milliseconds, so that is what serves place queries now. The vector
// scan is not a fallback to wait for; it is not on the request path at all.
const SEARCH_PLACES_DEADLINE_MS = 2500;

/**
 * Why one half of a search came back empty.
 *
 * An empty array carried three different meanings at once — nothing matched,
 * the query was never run, and the backend threw — so the model told the reader
 * "no places found" whether or not a search had happened. The coarse reason
 * travels with the empty array now, to the caller of /search and to the model
 * that called the tool. Coarse on purpose: this endpoint is public, so the
 * upstream message stays in the log.
 *
 *   error    something went wrong: "query_failed", "deadline", "rpc_failed",
 *            "rpc_unreachable", "embedding_failed"
 *   skipped  nothing was searched, deliberately: "no_place_intent",
 *            "no_city_or_category", "no_query_or_city"
 */
type SearchOutcome = { results: any[]; error?: string; skipped?: string };

/**
 * Is a place search warranted at all?
 *
 * H1, measured live 2026-09-22: the model's semantic_search passed the parsed
 * `city` and the catalogue query ran with no category, so "jazz koncert i
 * Aarhus" — an events-only question — was answered with Aarhus' best-rated
 * cafes and restaurants. Two rules close that:
 *
 *   1. PLACE INTENT ONLY. When the query's own intent is events-only there is
 *      no place question to answer; returning the city's top-N anyway invents a
 *      question and then answers it.
 *   2. NEVER THE NATIONAL TOP-N. With no city and no category the catalogue
 *      query is an unfiltered ORDER BY rating_avg over 148k rows — the top of
 *      the country, which is an answer to nothing. It is also the class of
 *      query that put "camping niffer — tozeur" at the top of a Danish search
 *      before the NULLS LAST fix.
 *
 * Same parser and same routing as directDiscoveryFallback, so the place paths
 * cannot drift apart.
 */
function placeSearchGate(intent: DiscoveryIntent): { skipped?: string } {
  if (intent.kind === "events") return { skipped: "no_place_intent" };
  if (!intent.city && !intent.placeCategory) return { skipped: "no_city_or_category" };
  return {};
}

async function searchPlacesForQuery(
  env: Env,
  query: string,
  count: number,
  contextCity?: string,
): Promise<SearchOutcome> {
  const intent = inferDiscoveryIntent(query, contextCity);
  // H1 — no place intent, or nothing to narrow on: the catalogue is not asked.
  const gate = placeSearchGate(intent);
  if (gate.skipped) return { results: [], skipped: gate.skipped };

  const supabase = createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY);
  const work = searchPlaces(
    supabase,
    { city: intent.city, category: intent.placeCategory },
    count,
  ).catch((err: any) => {
    // Public endpoint: the exception text goes to the log, never to the caller.
    console.error("Places search failed:", err);
    return { results: [] as any[], error: "query_failed" };
  });

  // Bounded on purpose. The catalogue path is fast, but this endpoint is public
  // and a slow database must not become a hanging request: an empty array is a
  // shape the caller can act on, a request that never answers is not.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result: any = await Promise.race([
      work,
      new Promise((resolve) => {
        timer = setTimeout(
          () => resolve({ results: [] as any[], error: "deadline" }),
          SEARCH_PLACES_DEADLINE_MS,
        );
      }),
    ]);
    const results = Array.isArray(result?.results) ? result.results : [];
    // The catalogue can also answer with an upstream message ("canceling
    // statement due to statement timeout"). The caller gets a coarse code; the
    // message stays in the log with the rest of the diagnostics.
    if (result?.error) {
      return { results, error: result.error === "deadline" ? "deadline" : "query_failed" };
    }
    return { results };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Vector-matched events for a free-text query.
 *
 * An embedding failure does not become a 5xx: events normalise to [] and the
 * caller keeps whatever the place half produced. /soeg treats an empty result
 * as "path A found nothing" and falls back to /chat, which is the same outcome
 * a 500 produced — without taking the whole response down with it.
 */
async function searchEventsForQuery(
  env: Env,
  query: string,
  count: number,
  threshold: number,
  country: string | undefined,
  sbHeaders: Record<string, string>,
): Promise<SearchOutcome> {
  let vec: number[] | undefined;
  try {
    const emb: any = await runAiCounted(env.AI, "@cf/baai/bge-m3", { text: [query] });
    vec = emb?.data?.[0];
  } catch (err) {
    console.error("Search embedding failed:", err);
  }
  // M3 — an empty array has to mean ONE thing. "No vector" is a failure, not an
  // empty result, so it travels with a reason instead of silently joining the
  // case where the search ran and genuinely matched nothing.
  if (!vec) return { results: [], error: "embedding_failed" };

  let failed = false;
  let results: any[] = [];
  try {
    results = await rpcResultRows(
      `${env.SUPABASE_URL}/rest/v1/rpc/match_events`,
      sbHeaders,
      {
        query_embedding: vec,
        match_count: count,
        match_threshold: threshold,
        filter_country: country ?? null,
      },
      () => { failed = true; },
    );
  } catch (err) {
    console.error("Events search failed:", err);
    failed = true;
  }
  return failed ? { results, error: "rpc_failed" } : { results };
}

/**
 * Rows from a Supabase RPC, always as an array.
 *
 * PostgREST reports a failed RPC as a JSON OBJECT ({code:"57014", …}), which
 * this endpoint used to hand to the caller as if it were the result list. A
 * search that failed has to read as "no rows", never as a record the caller
 * has to guess at.
 */
async function rpcResultRows(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  /** Called when the payload was NOT a row list, so a caller that must tell a
   *  failed search from an empty one can record it (M3). */
  onFailure?: () => void,
): Promise<any[]> {
  const r = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
  const payload: any = await r.json().catch(() => null);
  if (Array.isArray(payload)) return payload;
  console.error("Search RPC returned a non-array payload:", payload?.message ?? payload);
  onFailure?.();
  return [];
}

async function handleSemanticSearch(request: Request, env: Env): Promise<Response> {
  // The response SHAPE is part of the contract: `events` and `places` are
  // arrays on EVERY path out of this handler — the 400s and the 500 included —
  // and a failure carries a coarse reason BESIDE the empty array, so the caller
  // can tell "nothing matched" from "the search did not run" (M3).
  const out: {
    events: any[];
    places: any[];
    places_skipped?: string;
    places_error?: string;
    events_error?: string;
  } = { events: [], places: [] };

  // M2 — a body that is not JSON is the CALLER's mistake, so it is a 400, not
  // the 500 the umbrella catch produced by reading the body inside it. Reading
  // it out here also keeps "you sent me junk" distinguishable from "we broke".
  let body: any;
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "invalid JSON body", ...out }, 400);
  }

  try {
    if (!body?.query) return jsonResponse({ error: "query required", ...out }, 400);

    // C3 — clamp the query length before embedding (cost/abuse guard).
    const query = clampString(body.query, 1000);
    if (query.trim().length === 0) return jsonResponse({ error: "query required", ...out }, 400);

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

    const wantsPlaces = kind === "places" || kind === "both";
    const wantsEvents = kind === "events" || kind === "both";

    // Both halves run together: neither can delay the other, which is what let
    // a 4s place timeout sit in front of an events answer that took 80ms.
    // Each half answers with its rows PLUS why it has none, if it has none.
    const [placeOutcome, eventOutcome] = await Promise.all([
      wantsPlaces
        ? searchPlacesForQuery(env, query, count)
        : Promise.resolve({ results: [] } as SearchOutcome),
      wantsEvents
        ? searchEventsForQuery(env, query, count, threshold, body.country, sbHeaders)
        : Promise.resolve({ results: [] } as SearchOutcome),
    ]);

    out.places = placeOutcome.results;
    if (placeOutcome.skipped) out.places_skipped = placeOutcome.skipped;
    if (placeOutcome.error) out.places_error = placeOutcome.error;
    out.events = eventOutcome.results;
    if (eventOutcome.error) out.events_error = eventOutcome.error;
    return jsonResponse(out);
  } catch (err: any) {
    // Public endpoint: the exception text goes to the log, never to the caller.
    // The empty arrays ride along so the caller's list handling cannot break.
    console.error("Search error:", err);
    return jsonResponse({ error: "search failed", ...out }, 500);
  }
}

function latestUserMessage(messages: ChatMessage[]) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "user" && messages[index].content) return messages[index].content;
  }
  return "";
}

/** Model tool arguments are often a JSON string, and sometimes not valid JSON. */
function parseToolArgs(raw: unknown): Record<string, any> | null {
  if (raw && typeof raw === "object" && !Array.isArray(raw)) return raw as Record<string, any>;
  if (typeof raw !== "string") return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, any>;
  } catch {
    return null;
  }
}

async function notifyCommandCenter(env: Env, message: string, context: unknown) {
  if (!env.COMMAND_CENTER_INGEST_URL || !env.COMMAND_CENTER_INGEST_TOKEN || !message) return;

  // Plan §8 P183: standard telemetry carries NO raw chat text, no raw query
  // and no precise GPS. The forwarded payload is a coarse allowlisted event;
  // the reader-visible answer always lives on the site, not in the pipeline.
  // Auth headers and secret handling are unchanged.
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
      body: "[chat-indhold videresendes ikke]",
      sentiment: "warm",
      metadata: buildTelemetryEvent(context),
      worker: "b-social-chat",
      received_at: new Date().toISOString(),
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
  if (!adminAskKeyOk(request, env)) {
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
const CHAT_REPLY_MAX_TOKENS = 1024;
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

// ── Truncation transparency (2026-09-26) ─────────────────────────────────────
// MAX_MESSAGE_CHARS / MAX_MESSAGES are SILENT clamps: a caller who pastes a
// long text gets an answer to a shortened question and no way to know. The cap
// itself is right (cost + prompt-injection blowup guard) — hiding it is not.
//
// Chosen shape: keep answering (a 413 on a paste is a worse experience on a
// public endpoint, and existing clients would surface a hard error), and flag
// `truncated: true` on the JSON reply so the client can tell the user.
function isChatInputTruncated(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  const b = body as { messages?: unknown; message?: unknown };
  if (Array.isArray(b.messages)) {
    if (b.messages.length > MAX_MESSAGES) return true;
    return b.messages.some((item) => {
      const content = item && typeof item === "object" ? (item as { content?: unknown }).content : null;
      return typeof content === "string" && content.length > MAX_MESSAGE_CHARS;
    });
  }
  return typeof b.message === "string" && b.message.length > MAX_MESSAGE_CHARS;
}

/** Add `truncated: true` to a JSON chat response.
 *
 *  Passes anything that is not a JSON object body straight through: a reply is
 *  never corrupted (or re-serialized) just to attach a flag to it. Headers are
 *  carried over verbatim so CORS survives the re-wrap. */
async function tagTruncatedResponse(res: Response, truncated: boolean): Promise<Response> {
  if (!truncated) return res;
  if (!(res.headers.get("content-type") || "").includes("application/json")) return res;
  try {
    const body: unknown = await res.clone().json();
    if (!body || typeof body !== "object" || Array.isArray(body)) return res;
    const headers = new Headers(res.headers);
    headers.set("content-type", "application/json; charset=utf-8");
    return new Response(JSON.stringify({ ...(body as Record<string, unknown>), truncated: true }), {
      status: res.status,
      headers,
    });
  } catch {
    // A reply we cannot re-read is still a reply. Never fail the request over
    // an informational flag.
    return res;
  }
}

function turnDiscovery(userMessages: ChatMessage[], context?: { user_prefs?: { city?: string } }) {
  const t = resolveTurnDiscovery(userMessages.filter((m) => m.role === "user").map((m) => String(m.content ?? "")), context?.user_prefs?.city);
  // "hvad sker der i aften" names no city: a Danish reader means Denmark,
  // never a Duke flu clinic in North Carolina.
  if (!t.intent.city && inferResponseLanguage(latestUserMessage(userMessages)) !== "en") t.intent.country = "DK";
  return t;
}

async function directDiscoveryFallback(
  env: Env,
  userMessages: ChatMessage[],
  context: { user_prefs?: { city?: string } },
): Promise<Response> {
  const latestMessage = latestUserMessage(userMessages);
  const intent = turnDiscovery(userMessages, context).intent;
  const language = inferResponseLanguage(latestMessage);
  const supabase = createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY);
  let places: any[] = [];
  let events: any[] = [];
  let failed = false;
  let relaxed: Relaxation[] = [];

  if (intent.kind === "places" || intent.kind === "both") {
    // H1 — the SAME gate the /search path uses, which is the point of putting
    // it in placeSearchGate: without it this safety net answered "find et godt
    // sted" with an unfiltered catalogue query, i.e. the national top-N.
    const gate = placeSearchGate(intent);
    if (!gate.skipped) {
      const result = await searchPlaces(supabase, {
        city: intent.city,
        category: intent.placeCategory,
      });
      if (result.error) failed = true;
      places = result.results || [];
    }
  }

  if (intent.kind === "events" || intent.kind === "both") {
    const result = await searchEventsRelaxing(intent, (filters) => searchEvents(supabase, filters));
    relaxed = result.relaxed;
    if (result.error) failed = true;
    events = result.results || [];
    // R27: "i morgen" must not list tonight's concert that merely ends after
    // midnight; keep started rows only when they are genuine multi-day runs.
    const fromMs = intent.dateWindow ? Date.parse(intent.dateWindow.from) : NaN;
    if (Number.isFinite(fromMs) && !result.relaxed?.includes("date")) {
      events = events.filter((e: any) => {
        const start = Date.parse(e.date_raw ?? "");
        if (!Number.isFinite(start) || start >= fromMs) return true;
        const end = e.end_date ? Date.parse(e.end_date) : NaN;
        return Number.isFinite(end) && end - start >= 20 * 3600 * 1000;
      });
    }
  }

  // "techno" → "og i Aarhus?": the genre still rules; no shelters or comedy.
  const fbGenre = chainGenre(userMessages.filter((m) => m.role === "user").map((m) => String(m.content ?? "")));
  if (fbGenre && !failed && userMessages.filter((m) => m.role === "user").length > 1) {
    places = [];
    events = events.filter((e: any) => rowIsGenre(e, fbGenre));
    if (events.length === 0) {
      const again = await searchEvents(supabase, { city: intent.city, tags: Array.from(new Set([fbGenre, ...(GENRES[fbGenre] ?? [])])).join(","), ...(intent.dateWindow ? { date_from: intent.dateWindow.from, date_to: intent.dateWindow.to } : {}), ...(intent.free ? { free: true } : {}) } as any);
      events = ((again.results || []) as any[]).filter((e: any) => rowIsGenre(e, fbGenre));
    }
    if (events.length === 0) {
      return jsonResponse({ reply: honestEmptyReply(intent, fbGenre, language === "en" ? "en" : "da"), tool_calls_made: ["direct_discovery_fallback"], place_ids: [], event_ids: [], suggested_tag_slugs: [] });
    }
  }
  if (failed && places.length === 0 && events.length === 0) {
    return jsonResponse({
      reply: language === "en"
        ? "I couldn't search the catalogue right now. Please try again in a moment."
        : "Jeg kunne ikke søge i kataloget lige nu. Prøv igen om lidt.",
      tool_calls_made: ["direct_discovery_fallback"], place_ids: [], event_ids: [],
      suggested_tag_slugs: [], degraded: true, retrieval_error: true,
    });
  }

  return jsonResponse(formatFallbackReply(intent, places, events, language, relaxed));
}

/**
 * What a /chat turn gets once the model path has failed.
 *
 * The catalogue safety net exists for DISCOVERY questions. Running it for every
 * parsed turn — what 4b924a1 did by dropping the outer gate — answered "hej,
 * hvad kan du?", "godmorgen" and "Gem at jeg elsker jazz" with "Jeg fandt ingen
 * resultater med de valgte filtre.": a claim about a search nobody asked for,
 * paid for with two Supabase queries that could not have changed the answer.
 *
 * So the gate goes here, in front of EVERY failure path (breaker open, first AI
 * call, follow-up AI call, umbrella catch), not just the outer one: only a turn
 * that actually asks us to look something up may be answered from the
 * catalogue. Everything else gets an honest 200 — not a 5xx, because the outage
 * is ours, and not catalogue copy, because there is nothing to report.
 */
/**
 * Deterministic retrieval for a discovery question the model did not tool for.
 * Returns OpenAI-shaped tool calls whose arguments are the filters that
 * actually produced rows (after the fallback's relaxing steps); [] when the
 * message is not discovery-seeking or nothing matched.
 */
async function synthesizeDiscoveryToolCalls(
  env: Env,
  userMessages: ChatMessage[],
  context: { user_prefs?: { city?: string } },
): Promise<{ id: string; type: "function"; function: { name: string; arguments: string } }[]> {
  const turn = turnDiscovery(userMessages, context);
  if (!turn.seeking) return [];
  const intent = turn.intent;
  const supabase = createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY);
  const calls: { id: string; type: "function"; function: { name: string; arguments: string } }[] = [];
  try {
    if (intent.kind === "events" || intent.kind === "both") {
      let used: Record<string, unknown> | null = null;
      const res = await searchEventsRelaxing(intent, (filters) => { used = filters; return searchEvents(supabase, filters as any); });
      // A relaxed hit (date/category dropped) goes to the honest fallback,
      // which says what was loosened — the model would present it as a match.
      if (!res.error && (res.relaxed?.length ?? 0) === 0 && (res.results?.length ?? 0) > 0 && used) {
        calls.push({ id: "call_auto_events", type: "function", function: { name: "search_events", arguments: JSON.stringify(used) } });
      }
    }
    if (intent.kind === "places" || intent.kind === "both") {
      const gate = placeSearchGate(intent);
      if (!gate.skipped) {
        const args = { city: intent.city, category: intent.placeCategory };
        const res = await searchPlaces(supabase, args);
        if (!res.error && (res.results?.length ?? 0) > 0) {
          calls.push({ id: "call_auto_places", type: "function", function: { name: "search_places", arguments: JSON.stringify(args) } });
        }
      }
    }
  } catch (error) {
    console.error(JSON.stringify({ event: "auto_retrieval_failed", detail: String(error instanceof Error ? error.message : error).slice(0, 140) }));
    return [];
  }
  return calls;
}

async function catalogueFallbackForTurn(
  env: Env,
  userMessages: ChatMessage[],
  context: { user_prefs?: { city?: string } },
  // Plan §9 P190: a degraded provider must be DECLARED in the response — the
  // deterministic answer never masquerades as an assistant success.
  degradation?: { reason: DegradationReason; retryAfterSeconds?: number },
): Promise<Response> {
  const extraHeaders =
    degradation?.reason === "provider_429"
      ? { "Retry-After": String(degradation.retryAfterSeconds ?? 60) }
      : undefined;
  const degradationField = degradation ? degradationNotice(degradation.reason, degradation.retryAfterSeconds) : null;
  const withDegradation = (payload: any): any =>
    degradationField ? { ...payload, degraded: true, degradation: degradationField } : payload;
  const latest = latestUserMessage(userMessages);
  if (!turnDiscovery(userMessages, context).seeking) {
    return jsonResponse(withDegradation(formatNonCatalogueReply(latest)), 200, extraHeaders);
  }
  const res = await directDiscoveryFallback(env, userMessages, context);
  // directDiscoveryFallback queries the catalogue LIVE on every call — the
  // degraded answer is freshly grounded, never a cached/fake replay.
  const body = await res.json();
  return jsonResponse(withDegradation(body), 200, extraHeaders);
}

/** Map an upstream failure to the degradation contract, 429 carrying its
 *  Retry-After guidance (Plan §9 P190). */
function providerDegradation(error: unknown): { reason: DegradationReason; retryAfterSeconds?: number } {
  const reason = classifyProviderFailure(error);
  return reason === "provider_429" ? { reason, retryAfterSeconds: 60 } : { reason };
}

/** Plan §9 M41: the response byte cap applies to EVERY /chat reply path
 *  (tool, no-tool, degraded fallback). An over-cap reply is cut and flagged. */
// Quota of the turn, set by handleChatInner at the budget charge and read (once)
// by handleChat so every 200 reply carries { tier, cap, remaining }.
const chatQuotaByRequest = new WeakMap<Request, { tier: string; cap: number; remaining: number | null }>();

async function handleChat(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
  const res = await handleChatInner(request, env, executionCtx);
  if (res.status !== 200) return res;
  let text = await res.text();
  const quota = chatQuotaByRequest.get(request);
  if (quota) {
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) text = JSON.stringify({ ...parsed, quota });
    } catch { /* not JSON: leave unchanged */ }
  }
  const rebuilt = (t: string) => new Response(t, { status: res.status, headers: res.headers });
  if (text.length <= RESOURCE_CAPS.response_bytes) return rebuilt(text);
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed.reply === "string") return rebuilt(JSON.stringify(capReplyBytes(parsed).payload));
  } catch { /* not JSON: fall through unchanged */ }
  return rebuilt(text);
}

async function handleChatInner(request: Request, env: Env, executionCtx: ExecutionContext): Promise<Response> {
  // Kept in the outer scope so the catch below can still answer a discovery
  // question after the model path has failed (see the catch for why).
  let fallbackMessages: ChatMessage[] | null = null;
  let fallbackCtx: { user_prefs?: { city?: string } } = {};
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
      /** The widget's validated current search intent for proposal turns. */
      current_intent?: unknown;
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

    // Explicit intent bypasses legacy model/telemetry paths. Missing RPC fails
    // closed; unsupported region metadata never silently widens geography.
    if (Object.prototype.hasOwnProperty.call(body, "discovery_intent")) {
      let intent;
      try {intent=parseSearchIntent((body as {discovery_intent?:unknown}).discovery_intent);}
      catch {return jsonResponse({error:'invalid_discovery_intent',contract_version:1},400);}
      try {
        // Verified user token or public anon; never service-role discovery.
        const client=createClient(env.SUPABASE_URL,env.SUPABASE_KEY,{auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false},
          global:{headers:userId && userJwt?{Authorization:`Bearer ${userJwt}`}:{}}});
        const cursor=(body as {discovery_cursor?:unknown}).discovery_cursor;
        const page=await fetchDiscoveryPage(client,{version:1,intent,pageSize:8,...(cursor!==undefined?{cursor:cursor as any}:{})},request.signal);
        const sources=page.items.map(item=>({id:item.data.id,kind:item.kind,
          url:`/${item.kind==='event'?'event':'sted'}/${item.data.id}`,verified_fields:item.data,
          retrieved_at:page.retrievedAt,source_updated_at:null}));
        const labels=page.items.map(item=>{
          const d=item.data;
          if(item.kind==='place') return String(d.name);
          const price=eventPriceLabel(d.price, d.price_currency);
          return `${d.title} — ${price}`;
        });
        return jsonResponse({reply:labels.length?labels.join('\n'):'Ingen resultater med de valgte filtre.',
          event_ids:page.items.filter(i=>i.kind==='event').map(i=>i.data.id),place_ids:page.items.filter(i=>i.kind==='place').map(i=>i.data.id),
          sources,applied_filters:intent,retrieval_status:page.status,consistency:page.consistency,
          hasMore:page.hasMore,nextCursor:page.nextCursor,contract_version:1});
      } catch(error) {
        const code=error instanceof DiscoveryError?error.code:'discovery_unavailable';
        const unsupported=code==='unsupported_region_metadata';
        return jsonResponse({error:code,retrieval_status:unsupported?'unsupported':'failed',applied_filters:null,
          reply:unsupported?'Regionen mangler verificeret metadata. Filtrene er bevaret.':'Søgningen kunne ikke gennemføres. Prøv igen.',contract_version:1},
          unsupported?422:code.startsWith('invalid_')?400:503);
      }
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
    fallbackMessages = userMessages;

    // Plan §9 P189/M41: the per-session/per-account turn ledger, persisted
    // account-scoped in the Durable Object store. Exhaustion is a NAMED 429
    // (session_budget_exhausted) with Retry-After and a Danish message; a
    // missing/broken store fails open (the per-actor rate limiter still
    // applies) and never takes chat down.
    const sessionBudgetKey_ = sessionBudgetKey(userId, await rateLimitActorKey(request, "/chat"));
    const tier = await resolveChatTier(env, userId, userJwt);
    const sessionStore = env.RATE_LIMITER ? env.RATE_LIMITER.getByName(sessionBudgetKey_) : undefined;
    const sessionCap = CHAT_TIERS[tier];
    const quotaExhausted429 = (d: { retryAfterSeconds: number; persisted: boolean; cap: number }) => {
      console.error(JSON.stringify({ event: "session_budget_exhausted", tier, persisted: d.persisted }));
      const notice = degradationNotice(tier === "plus" ? "plus_fair_use_exhausted" : "session_budget_exhausted", d.retryAfterSeconds);
      return jsonResponse(
        { error: "session_budget_exhausted", retry_after_seconds: d.retryAfterSeconds, degraded: true, degradation: notice, notice: notice.notice,
          quota: { tier, cap: d.cap, remaining: 0 }, upgrade: tier === "free" ? { href: "/plus" } : undefined },
        429,
        { "Retry-After": String(d.retryAfterSeconds) },
      );
    };
    // Read-only pre-check (charges nothing): an already-exhausted account gets
    // its 429 without any AI work. The actual debit happens just before the
    // first model call, so turns that never reach the model cost no quota.
    if (sessionStore && typeof (sessionStore as any).peek === "function") {
      try {
        const pk = await (sessionStore as any).peek(sessionCap, SESSION_BUDGET_WINDOW_MS);
        if (!pk.success) return quotaExhausted429({ retryAfterSeconds: pk.retryAfterSeconds, persisted: true, cap: sessionCap });
      } catch { /* fail-open: consume below decides */ }
    }
    chatQuotaByRequest.set(request, { tier, cap: sessionCap, remaining: null });

    executionCtx.waitUntil(notifyCommandCenter(env, latestUserMessage(userMessages), body.context || {}));

    // Build page-aware context injection for the system prompt
    const ctx = body.context || {};
    fallbackCtx = ctx;
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

    // Plan §9 P188/M41: one wall-clock deadline for the whole turn. Expiry is
    // a NAMED error (turn_deadline_exceeded), distinct from a model/upstream
    // failure — a timed-out turn is OUR budget spent, not the provider being
    // sick, so it must not open the AI breaker or fake a completion.
    const deadline = new TurnDeadline(turnDeadlineMs(env.CHAT_TURN_DEADLINE_MS));

    // Breaker: once the AI has failed repeatedly, calling it again only spends
    // the reader's patience on a timeout we already expect. Go straight to the
    // grounded database answer.
    if (aiBreakerIsOpen()) {
      console.error(JSON.stringify({ event: "ai_breaker_open", action: "direct_fallback" }));
      // Breaker open = the provider has been failing: declare it.
      return await catalogueFallbackForTurn(env, userMessages, ctx, { reason: "provider_error" });
    }

    // R26: "hvad sker der i morgen/i weekenden" with no city, topic or genre
    // is a pure date question. The model path timed out on it and the
    // semantic path surfaced Stanford rows; answer straight from the Danish
    // catalogue instead (deterministic, local time, DK only).
    {
      const td = turnDiscovery(userMessages, ctx);
      const latestQ = latestUserMessage(userMessages);
      const it = td.intent;
      if (td.seeking && !td.followUp && !it.city && it.dateWindow && !it.eventCategory && !it.queryTag && !it.placeCategory
        && nonGenreTopics(it.topicWords).length === 0 && !chainGenre([latestQ]) && inferResponseLanguage(latestQ) !== "en") {
        console.log(JSON.stringify({ event: "date_only_direct", label: it.dateWindow.label }));
        return await directDiscoveryFallback(env, userMessages, ctx);
      }
    }

    // Global daily neuron ceiling (kill switch): skip every model call and
    // answer from the catalogue, declared as provider_429. Fail-open.
    const ceiling = await aiCeilingReached(env);
    if (ceiling.reached) {
      console.error(JSON.stringify({ event: "ai_daily_ceiling_reached", action: "direct_fallback" }));
      return await catalogueFallbackForTurn(env, userMessages, ctx, { reason: "provider_429", retryAfterSeconds: ceiling.retryAfterSeconds ?? 60 });
    }

    // Debit the session quota now: this is the first point where a model call
    // is certain (greeting/catalogue fallbacks, open breaker and the neuron
    // ceiling all returned above without cost).
    const sessionBudget = await consumeSessionTurnBudget(sessionStore, sessionBudgetKey_, 1, sessionCap);
    if (!sessionBudget.allowed) return quotaExhausted429(sessionBudget);
    chatQuotaByRequest.set(request, { tier, cap: sessionBudget.cap, remaining: sessionBudget.remaining });

    // First AI call — may include tool calls
    let aiResponse: any;
    const budget = new TurnBudget();
    try {
      budget.reserveModel();
      aiResponse = await deadline.race(runAiCounted(env.AI, "@cf/meta/llama-4-scout-17b-16e-instruct", {
        messages,
        tools: TOOLS,
        tool_choice: "auto",
        max_tokens: CHAT_REPLY_MAX_TOKENS,
      }));
    } catch (error) {
      if (error instanceof TurnDeadlineExceeded) {
        console.error(JSON.stringify({ event: "turn_deadline_exceeded", phase: "first_model_call" }));
        return catalogueFallbackForTurn(env, userMessages, ctx, { reason: "turn_deadline_exceeded" });
      }
      // ANY AI failure falls back, not just a quota error. The database answer
      // is grounded and useful; rethrowing gave the reader nothing at all.
      recordAiFailure();
      console.error(JSON.stringify({
        event: "ai_call_failed",
        quota: isAiQuotaError(error),
        detail: String(error instanceof Error ? error.message : error).slice(0, 140),
      }));
      return catalogueFallbackForTurn(env, userMessages, ctx, providerDegradation(error));
    }
    recordAiSuccess();

    // A turn that hit the wall clock mid-tools gets an HONEST PARTIAL answer:
    // only what the tools actually retrieved, with the deadline declared.
    let deadlineHitMidTools = false;
    let rowsCapped = false;

    // If the model wants to call tools, execute them
    // Workers AI returns tool calls either OpenAI-style ({function:{name,arguments}})
    // or flat ({name, arguments}) depending on model/version. Normalise once so
    // every consumer below can rely on tc.function.name.
    if (Array.isArray(aiResponse?.tool_calls)) {
      aiResponse.tool_calls = normalizeToolCalls(aiResponse.tool_calls);
    }
    // The model often answers Danish discovery questions WITHOUT calling a
    // tool, which used to drop the turn to the plain catalogue list. Instead,
    // retrieve deterministically (same relaxing search as the fallback) and
    // hand the rows to the model as tool results, so the reply is still an
    // AI-written answer grounded in real catalogue rows.
    if (!(aiResponse?.tool_calls?.length > 0)) {
      const synthesized = await synthesizeDiscoveryToolCalls(env, userMessages, ctx);
      if (synthesized.length > 0) aiResponse = { ...aiResponse, content: "", response: undefined, tool_calls: synthesized };
    }
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
            const groundedToolResults: GroundedToolResult[] = [];
            let turnIntentProposal: IntentProposal | undefined;
            const toolResultErrors: string[] = [];
    // Plan §8 P180/P181: one turn = one durable action per identical payload.
    const turnActionMemo = new Map<string, Record<string, unknown>>();

            for (const toolCall of aiResponse.tool_calls) {
              // Plan §9 P188: a tool that would start after the wall clock
              // expired must not start. The turn degrades honestly below.
              if (deadline.expired()) {
                deadlineHitMidTools = true;
                toolResultErrors.push("turn_deadline_exceeded");
                break;
              }
              const fnName = toolCall.function.name;
              const fnArgs = parseToolArgs(toolCall.function?.arguments);
              // The model often drops the city ("jazz i København" → semantic_search
              // without city → Zürich/Montreal rows). The reader named it, so the
              // worker fills it in from the latest user message before searching.
              if (fnArgs && !fnArgs.city && (fnName === "semantic_search" || fnName === "search_events" || fnName === "search_places")) {
                const namedCity = turnDiscovery(userMessages, ctx).intent.city;
                if (namedCity) fnArgs.city = namedCity;
              } else if (fnArgs && typeof fnArgs.city === "string" && /^(kbh|cph|copenhagen|kobenhavn)$/i.test(fnArgs.city.trim())) {
                // "KBH" from the model matches no row: use the catalogue's name.
                fnArgs.city = "København";
              }
              // The reader's date window and free filter are facts about the
              // question, not suggestions: the model's own dates never widen them.
              // "gratis"/"free"/"billig" are price filters, not catalogue tags: as
              // tags they match nothing and turned "gratis koncerter KBH" empty.
              if (fnArgs && typeof fnArgs.tags === "string") {
                const kept = fnArgs.tags.split(",").map((t: string) => t.trim()).filter((t: string) => t && !/^(gratis|free|billig|cheap|kbh|københavn|copenhagen|i dag|today|weekend)$/i.test(t));
                if (/(^|,)\s*(gratis|free)\s*(,|$)/i.test(fnArgs.tags)) fnArgs.free = true;
                if (kept.length) fnArgs.tags = kept.join(","); else delete fnArgs.tags;
              }
              if (fnArgs && fnName === "search_events") {
                const ti = turnDiscovery(userMessages, ctx).intent;
                if (ti.dateWindow) { fnArgs.date_from = ti.dateWindow.from; fnArgs.date_to = ti.dateWindow.to; delete fnArgs.timezone; }
                if (ti.free) fnArgs.free = true;
              }

              let result: any;
              if (!fnArgs) {
                result = { error: "ugyldige tool-argumenter" };
                messages.push({
                  role: "tool",
                  content: JSON.stringify(result),
                  tool_call_id: toolCall.id,
                });
                continue;
              }

              const rowCapFlag = { hit: false };
              const capToolRows = <T,>(rows: T[] | undefined): T[] => {
                const c = capRows(rows || []);
                if (c.capped) { rowsCapped = true; rowCapFlag.hit = true; }
                return c.rows;
              };
              // Plan §9 P188: EVERY tool (places/routes/RPC/writes/events) runs
              // under the same wall clock. A hanging tool stops the turn at the
              // deadline instead of spending it unboundedly.
              try {
              await deadline.race((async () => {
              switch (fnName) {
                case "semantic_search": {
                  // EVENTS: embedding -> match_events, as before.
                  // PLACES: the catalogue path, NOT match_places. Same root
                  // cause as /search: `places` has no vector index, so
                  // match_places is a full scan that cannot finish inside the
                  // anon statement_timeout -- measured 2026-09-21, "Find
                  // spisesteder i Aarhus" came back with place_ids [] after
                  // ~4s of waiting. The catalogue path answers the same
                  // question in tens of ms, and it is already the shape the
                  // grounded fallback trusts.
                  try {
                    const kind = fnArgs.kind ?? "both";
                    // Location awareness (2026-07-22): a named city still
                    // becomes a real bounding box on match_events. Places are
                    // narrowed by city/nearest_city inside the catalogue query.
                    const bbox = cityToBBox(fnArgs.city);
                    const bboxParams = bbox
                      ? { filter_bbox_n: bbox.n, filter_bbox_s: bbox.s, filter_bbox_e: bbox.e, filter_bbox_w: bbox.w }
                      : {};
                    const out: any = { events: [], places: [] };
                    if (kind === "events" || kind === "both") {
                      // An embedding failure costs the event half only: it must
                      // not turn into a tool error the model answers around.
                      // M3 — it is still a FAILURE, and the model has to be able
                      // to tell it from "no events match", or it reports a
                      // search it never made as one that found nothing.
                      let vec: number[] | undefined;
                      try {
                        // Plan §9 P188: at most ONE embedding call per turn; a
                        // second one is refused by name and reported as an
                        // error, never replaced by a fake answer.
                        // Plan §9 P188: at most ONE embedding call per turn; a
                        // second one is refused by name and reported as an
                        // error, never replaced by a fake answer. The call is
                        // also raced against the turn deadline so a hung
                        // embedding cannot spend the whole wall clock.
                        budget.reserveEmbedding();
                        const emb: any = await deadline.race(runAiCounted(env.AI, "@cf/baai/bge-m3", { text: [fnArgs.query] }));
                        vec = emb?.data?.[0];
                        // M41 resource cap: assert the vector shape/dimension
                        // before it reaches the RPC — a wrong-shaped vector is
                        // a named cap error, never a silently degraded search.
                        if (vec) assertEmbeddingDims(vec);
                      } catch (err) {
                        if (err instanceof TurnBudgetExceeded) out.events_error = "budget_exhausted_embedding_calls";
                        else if (err instanceof TurnDeadlineExceeded) { out.events_error = "turn_deadline_exceeded"; deadlineHitMidTools = true; }
                        else if (err instanceof ResourceCapExceeded) { out.events_error = `cap_exceeded_${err.cap}`; vec = undefined; }
                        else { console.error("Events embedding failed:", err); }
                      }
                      if (!vec && !out.events_error) out.events_error = "embedding_failed";
                      if (vec) {
                        const sbHeaders = { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`, "Content-Type": "application/json" };
                        out.events = await rpcResultRows(`${env.SUPABASE_URL}/rest/v1/rpc/match_events`, sbHeaders, {
                          query_embedding: vec,
                          // Over-fetch, then narrow to what the reader asked:
                          // the city (radius, not the loose box) and the date
                          // window ("i weekenden") the embedding cannot express.
                          match_count: 40,
                          match_threshold: 0.3,
                          // A Danish question with no city means Denmark, never Lachine,
                          // Québec. English/explicit-country questions stay worldwide.
                          filter_country: fnArgs.country ?? bbox?.country ?? (inferResponseLanguage(latestUserMessage(userMessages)) === "en" ? null : "DK"),
                          ...bboxParams,
                        }, () => { out.events_error = "rpc_failed"; });
                        const turnIntent = turnDiscovery(userMessages, ctx).intent;
                        const turnWindow = turnIntent.dateWindow;
                        out.events = narrowSemanticEvents(out.events || [], bbox, turnWindow, 25, fnArgs.city);
                        // A named genre ("jazz") must be what we answer with:
                        // keep rows that mention it, top up from the tag search.
                        if (turnIntent.queryTag && !out.events_error) {
                          // Only narrow when something actually matches; never
                          // turn a usable semantic answer into an empty one.
                          const onTopic = out.events.filter((e: any) => matchesTopic(e, turnIntent.queryTag!));
                          if (onTopic.length > 0) out.events = onTopic;
                          else {
                            // Nothing semantic is actually on-genre: answer from the
                            // tag search instead of calling rock/electronica "jazz".
                            const res = await searchEventsRelaxing({ ...turnIntent, ...(fnArgs.city ? { city: fnArgs.city } : {}) }, (filters) => searchEvents(createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY), filters));
                            // Only an unrelaxed hit: a dropped date window ("i weekenden" → July
                            // 2027) must never be presented as matching the question.
                            if (!res.error && (res.relaxed || []).length === 0 && (res.results || []).length > 0) out.events = res.results;
                            // Nothing on-topic anywhere: an honest empty answer beats a
                            // 22:00 DJ night offered as a kids' event.
                            else if (!res.error) out.events = [];
                          }
                        }
                        if (turnIntent.free) {
                          // Semantic rows carry no price: free questions are
                          // answered only from price-verified catalogue rows.
                          const fr = await searchEvents(createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY), {
                            ...(fnArgs.city ? { city: fnArgs.city } : {}),
                            ...(turnWindow ? { date_from: turnWindow.from, date_to: turnWindow.to } : {}),
                            free: true,
                          } as any);
                          out.events = fr.error ? [] : (fr.results || []);
                          if (fr.error) out.events_error = "rpc_failed";
                        }
                        // Final topic gate: date/free top-ups must not reintroduce off-topic rows.
                        if (turnIntent.queryTag && turnIntent.queryTag !== "musik") out.events = (out.events || []).filter((e: any) => matchesTopic(e, turnIntent.queryTag!) || (turnIntent.queryTag === turnIntent.eventCategory && turnIntent.eventCategory && String(e.category || "").includes(turnIntent.eventCategory === "familie" ? "børn" : turnIntent.eventCategory)));
                        {
                          const g = chainGenre(userMessages.filter((m) => m.role === "user").map((m) => String(m.content ?? "")));
                          if (g) out.events = (out.events || []).filter((e: any) => rowIsGenre(e, g));
                        }
                        // "stand-up Aarhus i morgen → og dagen efter?" stays stand-up.
                        { const tws = nonGenreTopics(turnIntent.topicWords); if (tws.length) out.events = (out.events || []).filter((e: any) => tws.some((w) => topicWordHit(e, w))); }
                        out.events = out.events.slice(0, 8);
                        // A date-bounded question ("i weekenden", "tonight") rarely
                        // has its events in the semantic top-N. Top up from the
                        // deterministic city+date search so the window is answered
                        // with what is actually on, not "nothing found".
                        if (turnWindow && out.events.length < 4) {
                          const sup = await searchEvents(createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY), {
                            ...(fnArgs.city ? { city: fnArgs.city } : {}), date_from: turnWindow.from, date_to: turnWindow.to,
                            // The top-up obeys the same free filter as the answer.
                            ...(turnIntent.free ? { free: true } : {}),
                            // "comedy København lørdag": ask for the topic's tags, not
                            // the first 8 rows of a busy Saturday.
                            ...(nonGenreTopics(turnIntent.topicWords).length ? { tags: topicTagList(nonGenreTopics(turnIntent.topicWords)).join(",") } : {}),
                          } as any);
                          const seen = new Set(out.events.map((e: any) => e?.id));
                          // R22: the top-up obeys the same topic + genre gate as the
                          // answer ("kun børn" in Aarhus must not add a vinyl night;
                          // "jazz … dagen efter" must not add comedy).
                          const gTop = chainGenre(userMessages.filter((m) => m.role === "user").map((m) => String(m.content ?? "")));
                          const onTopicTop = (e: any) =>
                            (!turnIntent.queryTag || turnIntent.queryTag === "musik" || matchesTopic(e, turnIntent.queryTag) || (turnIntent.queryTag === turnIntent.eventCategory && !!turnIntent.eventCategory && String(e.category || "").includes(turnIntent.eventCategory === "familie" ? "børn" : turnIntent.eventCategory)))
                            && (!gTop || rowIsGenre(e, gTop))
                            && (nonGenreTopics(turnIntent.topicWords).length === 0 || nonGenreTopics(turnIntent.topicWords).some((w) => topicWordHit(e, w)));
                          for (const e of sup.results || []) if (e?.id && !seen.has(e.id) && out.events.length < 8 && onTopicTop(e)) { out.events.push(e); seen.add(e.id); }
                        }
                        // M41 row cap: the model is never handed more than one
                        // page; a cap is flagged, not hidden.
                        out.events = capToolRows(out.events).map((e: any) => localizeSemanticRow(e));
                        if (rowCapFlag.hit) out.rows_capped = RESOURCE_CAPS.rows;
                      }
                      (out.events || []).forEach((e: any) => {
                        if (!e?.id) return;
                        collectedEventIds.push(e.id);
                        collectedEvents.push({ id: e.id, title: e.title, location: e.location, date: e.date });
                      });
                      if ((out.events || []).length > 0 && !out.events_error) {
                        groundedToolResults.push({ kind: "event", retrieved_at: new Date().toISOString(), rows: out.events });
                      }
                    }
                    if (kind === "places" || kind === "both") {
                      const placeQuery = String(fnArgs.query ?? "").trim();
                      // No query text and no city is nothing to search on: an
                      // unfiltered top-8 of the catalogue would be an answer to
                      // a question nobody asked.
                      const placeOutcome: SearchOutcome = placeQuery || fnArgs.city
                        ? await searchPlacesForQuery(env, placeQuery, 8, fnArgs.city)
                        : { results: [], skipped: "no_query_or_city" };
                      out.places = capToolRows(placeOutcome.results);
                      { const tws = Array.from(new Set([...nonGenreTopics(turnDiscovery(userMessages, ctx).intent.topicWords), ...placeTopicsOf([latestUserMessage(userMessages)])])); if (tws.length) {
                        out.places = out.places.filter((p: any) => tws.some((w) => topicWordHit(p, w)));
                        const needles = placeNameNeedles(tws);
                        if (out.places.length === 0 && needles.length && fnArgs.city) {
                          const byName = await searchPlaces(createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY), { city: fnArgs.city, name_like: needles.join(",") } as any);
                          out.places = capToolRows((byName.results || []) as any[]);
                        }
                      } }
                      // H1/M3 — the model is told WHY the place half is empty
                      // ("no_place_intent", "no_city_or_category") or that it
                      // FAILED, so it cannot narrate a top-8 it never received.
                      if (placeOutcome.skipped) out.places_skipped = placeOutcome.skipped;
                      if (placeOutcome.error) out.places_error = placeOutcome.error;
                      out.places.forEach((p: any) => {
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
                  // A Danish question that names no city or country is about
                  // Denmark (not Lachine, Québec) — filtered in the same query.
                  // Prefer Denmark; only if Denmark has nothing does the worldwide
                  // catalogue answer (the CHF contract stays intact).
                  if (fnArgs && !fnArgs.city && !fnArgs.country && inferResponseLanguage(latestUserMessage(userMessages)) !== "en") {
                    result = await searchEvents(supabase, { ...fnArgs, country: "DK" } as any);
                    if (!result.error && (result.results || []).length === 0) result = await searchEvents(supabase, fnArgs);
                  } else {
                    result = await searchEvents(supabase, fnArgs);
                  }
                  console.log(JSON.stringify({ event: "search_events_args", args: { city: fnArgs?.city ?? null, category: fnArgs?.category ?? null, tags: fnArgs?.tags ?? null, free: fnArgs?.free ?? null, country: fnArgs?.country ?? null, date_from: fnArgs?.date_from ?? null, date_to: fnArgs?.date_to ?? null }, rows: (result?.results || []).length, error: result?.error ?? null }));
                  if (result.results) {
                    result.results = capToolRows(result.results);
                    // A named genre ("jazz") is the answer's subject: drop nu-metal etc.
                    {
                      // A named genre is the subject: nothing in that genre is an
                      // honest empty answer, not STEP & AMBIENT called "jazz".
                      const g = chainGenre(userMessages.filter((m) => m.role === "user").map((m) => String(m.content ?? "")));
                      { const tws = nonGenreTopics(turnDiscovery(userMessages, ctx).intent.topicWords); if (tws.length) {
                        result.results = result.results.filter((e: any) => tws.some((w) => topicWordHit(e, w)));
                        if (result.results.length === 0 && !fnArgs.tags) {
                          const again = await searchEvents(supabase, { ...fnArgs, category: undefined, tags: topicTagList(tws).join(",") } as any);
                          result.results = capToolRows(((again.results || []) as any[]).filter((e: any) => tws.some((w) => topicWordHit(e, w))));
                        }
                      } }
                      if (g) {
                        result.results = result.results.filter((e: any) => rowIsGenre(e, g));
                        // The first 8 music rows by date may hold no jazz at all:
                        // ask the catalogue for the genre tag before answering empty.
                        if (result.results.length === 0 && !fnArgs.tags) {
                          // "elektronisk" is tagged "electronic"/"techno" in the catalogue.
                          const again = await searchEvents(supabase, { ...fnArgs, tags: Array.from(new Set([g, ...(GENRES[g] ?? [])])).join(",") } as any);
                          result.results = capToolRows(((again.results || []) as any[]).filter((e: any) => rowIsGenre(e, g)));
                        }
                      }
                    }
                    result.results.forEach((e: any) => {
                      if (!e?.id) return;
                      collectedEventIds.push(e.id);
                      collectedEvents.push({ id: e.id, title: e.title, location: e.location, date: e.date });
                    });
                    if (result.results.length > 0) groundedToolResults.push({ kind: "event", retrieved_at: new Date().toISOString(), rows: result.results });
                  }
                  break;
                case "search_routes":
                  result = await searchRoutes(supabase, fnArgs);
                  if (result?.results) result.results = capToolRows(result.results);
                  break;
                case "search_places": {
                  // A genre EVENT question ("elektronisk musik København") is not a
                  // venue question: venue blurbs then read as genre claims. (Jazz clubs
                  // are genuine jazz venues, so jazz keeps its places.)
                  if (((g0) => g0 !== null && g0 !== "jazz")(chainGenre(userMessages.filter((m) => m.role === "user").map((m) => String(m.content ?? "")))) && !/(?<!\p{L})(sted|steder|venue|klub|club|bar|spillested)/iu.test(latestUserMessage(userMessages))) { result = { results: [], places_skipped: "genre_event_question" }; break; }
                  // H1 — this tool filters on city, category and tags, and
                  // nothing else. A call that carries none of them is an
                  // unfiltered ORDER BY over the whole catalogue, i.e. the
                  // national top-N: the same non-answer the semantic_search gate
                  // refuses, so it is not run here either.
                  const hasPlaceFilter = !!(fnArgs.city || fnArgs.category || fnArgs.tags);
                  if (!hasPlaceFilter) {
                    result = { results: [], places_skipped: "no_city_or_category" };
                    break;
                  }
                  result = await searchPlaces(supabase, fnArgs);
                  if (result.results) {
                    result.results = capToolRows(result.results);
                    // R23-4: "børneteater" places must be theatres, not a zoo.
                    { const tws = Array.from(new Set([...nonGenreTopics(turnDiscovery(userMessages, ctx).intent.topicWords), ...placeTopicsOf([latestUserMessage(userMessages)])])); if (tws.length) {
                      result.results = result.results.filter((p: any) => tws.some((w) => topicWordHit(p, w)));
                      const needles = placeNameNeedles(tws);
                      if (result.results.length === 0 && needles.length && fnArgs.city) {
                        const byName = await searchPlaces(supabase, { city: fnArgs.city, name_like: needles.join(",") } as any);
                        result.results = capToolRows((byName.results || []) as any[]);
                      }
                    } }
                    result.results.forEach((p: any) => {
                      if (!p?.id) return;
                      collectedPlaceIds.push(p.id);
                      collectedPlaces.push({ id: p.id, name: p.name, city: p.city });
                    });
                    if (result.results.length > 0) groundedToolResults.push({ kind: "place", retrieved_at: new Date().toISOString(), rows: result.results });
                  }
                  break;
                }

                case "propose_discovery_intent": {
                  // Plan §6 P163–166 / M38: the model only PROPOSES; the change
                  // is validated here against the shared contract and an
                  // invalid or unknown field is reported back verbatim, never
                  // guessed into a contract value.
                  const proposal = proposeIntentChange(body.current_intent, fnArgs.change);
                  if (proposal.accepted) {
                    turnIntentProposal = proposal.proposal;
                    result = { proposal_ok: true, proposal_id: proposal.proposal.proposalId, changes: proposal.proposal.changes };
                  } else {
                    result = { proposal_ok: false, reason: proposal.reason, ...(proposal.invalid_fields ? { invalid_fields: proposal.invalid_fields } : {}) };
                  }
                  break;
                }

                // Weather for an outdoor event/place (open-meteo, free, ~16d horizon).
                // Returns a clear "too far out"/"unavailable" note rather than inventing.
                case "get_weather": {
                  const lat = fnArgs.latitude, lng = fnArgs.longitude;
                  const date = String(fnArgs.date ?? "").slice(0, 10);
                  if (!isValidLatLng(lat, lng)) { result = { error: "Ugyldige koordinater" }; break; }
                  // Plain fetch is safe here: the host is HARDCODED (api.open-meteo.com)
                  // inside fetchWeather and only validated numbers/date reach the query
                  // string — there is no user-controlled URL, so the fetchguard (which
                  // targets arbitrary/user URLs) does not apply.
                  const w = await fetchWeather((u, init) => fetch(u, init), lat, lng, date);
                  result = w
                    ? { ...w, note: "Vejrudsigt fra open-meteo — kun vejledende" }
                    : { unavailable: true, note: "Ingen vejrudsigt for den dato (mere end ~16 dage frem, ukendt sted, eller tjenesten er nede lige nu). Opfind ikke vejr." };
                  break;
                }

                // Rough door-to-door travel estimate from a great-circle distance.
                // Deliberately approximate — used for "is it nearby" and multi-stop plans.
                case "estimate_travel_time": {
                  const { from_latitude: fLat, from_longitude: fLng, to_latitude: tLat, to_longitude: tLng } = fnArgs;
                  if (!isValidLatLng(fLat, fLng) || !isValidLatLng(tLat, tLng)) { result = { error: "Ugyldige koordinater" }; break; }
                  const km = haversineKm(fLat, fLng, tLat, tLng);
                  const mode = normalizeMode(fnArgs.mode);
                  result = {
                    distance_km: Math.round(km * 10) / 10,
                    mode,
                    estimated_minutes: estimateTravelMinutes(km, mode),
                    note: "Groft skøn ud fra fugleflugtsafstand — reel rejsetid varierer",
                  };
                  break;
                }

                // Save a shareable plan (item 703). Login-gated (writes with the
                // user's JWT under RLS). Uses the events the AI passes, or falls back
                // to the events surfaced in THIS conversation. Returns a public link.
                case "save_plan": {
                  if (!userId || !userJwt) { result = { error: "Du skal være logget ind for at gemme og dele en plan" }; break; }
                  try {
                    const title = clampString(String(fnArgs.title ?? "Min aften-plan"), 120) || "Min aften-plan";
                    const note = fnArgs.note ? clampString(String(fnArgs.note), 500) : null;
                    let ids: string[] = Array.isArray(fnArgs.event_ids)
                      ? fnArgs.event_ids.filter((x: unknown): x is string => typeof x === "string" && isValidUuid(x))
                      : [];
                    if (ids.length === 0) ids = collectedEventIds.filter((x) => isValidUuid(x));
                    ids = [...new Set(ids)].slice(0, 20);
                    if (ids.length === 0) { result = { error: "Ingen events at gemme endnu — find nogle events først, så laver jeg en plan" }; break; }
                    const insertRes = await fetch(`${env.SUPABASE_URL}/rest/v1/shared_plans`, {
                      method: "POST",
                      headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${userJwt}`, "Content-Type": "application/json", Prefer: "return=representation" },
                      body: JSON.stringify({ title, note, event_ids: ids, created_by: userId }),
                    });
                    if (!insertRes.ok) { result = { error: "Kunne ikke gemme planen lige nu" }; break; }
                    const rows = (await insertRes.json()) as Array<{ id?: string }>;
                    const planId = rows?.[0]?.id;
                    result = planId
                      ? { ok: true, plan_id: planId, share_url: `https://b-social.net/plan/${planId}`, event_count: ids.length }
                      : { error: "Kunne ikke gemme planen lige nu" };
                  } catch (e: any) { result = { error: "Kunne ikke gemme planen", details: String(e.message || e) }; }
                  break;
                }

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
                result = { error: "Kunne ikke gemme deltagelsesmarkering", details: errText };
              } else {
                const statusLabel = status === "interested" ? "interesseret" : status === "not_going" ? "deltager ikke" : "deltager";
                result = {
                  ok: true, event_id: fnArgs.event_id, status, action: "participation_marker",
                  message: `Din deltagelsesmarkering i B Social er gemt: ${statusLabel}. Det er ikke billetkøb eller reservation hos arrangøren.`,
                };
              }
            } catch (e: any) { result = { error: "Kunne ikke gemme deltagelsesmarkering", details: e.message }; }
            break;
          }

          case "add_note": {
            // Plan §§8 P176–181: the whole write runs through the secure
            // actions contract — server-validated args, stable action id,
            // durable dedup, exact-row readback before any saved confirmation.
            result = await executeSecureAddNote(env, userId, userJwt, fnArgs, userMessages, turnActionMemo);
            break;
          }

          default:
            result = { error: `Ukendt funktion: ${fnName}` };
        }
              })());
              } catch (toolErr) {
                if (toolErr instanceof TurnDeadlineExceeded) {
                  console.error(JSON.stringify({ event: "turn_deadline_exceeded", phase: "tool_call", tool: fnName }));
                  deadlineHitMidTools = true;
                  toolResultErrors.push("turn_deadline_exceeded");
                  break;
                }
                throw toolErr;
              }

        // Retrieval/tool failures travel to the grounding layer by name: they
        // must be reported as errors, never reinterpreted as empty results.
        for (const code of [result?.events_error, result?.places_error]) {
          if (typeof code === "string" && !toolResultErrors.includes(code)) toolResultErrors.push(code);
        }
        // Add tool result to conversation
        messages.push({
          role: "tool",
          content: JSON.stringify(result),
          tool_call_id: toolCall.id,
        });
      }

      // Second AI call — now with data from Supabase. Skipped entirely when
      // the turn deadline expired mid-tools (Plan §9 P188): the honest
      // partial answer is built from what the tools retrieved, never from an
      // invented wrap-up.
      let finalResponse: any;
      if (deadlineHitMidTools || deadline.expired()) {
        deadlineHitMidTools = true;
        finalResponse = null;
        console.error(JSON.stringify({ event: "turn_deadline_exceeded", phase: "followup_skipped" }));
      } else {
        try {
          budget.reserveModel();
          finalResponse = await deadline.race(runAiCounted(env.AI, "@cf/meta/llama-4-scout-17b-16e-instruct", {
            messages,
            // The provider default (256) cut lists off mid-word ("Københav").
            max_tokens: CHAT_REPLY_MAX_TOKENS,
          }));
        } catch (error) {
          if (error instanceof TurnDeadlineExceeded) {
            deadlineHitMidTools = true;
            finalResponse = null;
            console.error(JSON.stringify({ event: "turn_deadline_exceeded", phase: "followup_call" }));
          } else {
            // Same rule as the first call: any failure falls back to grounded
            // database results rather than giving the reader nothing.
            recordAiFailure();
            console.error(JSON.stringify({
              event: "ai_followup_failed",
              quota: isAiQuotaError(error),
              detail: String(error instanceof Error ? error.message : error).slice(0, 140),
            }));
            return catalogueFallbackForTurn(env, userMessages, ctx, providerDegradation(error));
          }
        }
      }

      // Collect tag slugs from tool arguments (for live filter update on frontend)
      const collectedTagSlugs: string[] = [];
      for (const toolCall of aiResponse.tool_calls) {
        const args = parseToolArgs(toolCall.function?.arguments) || {};
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

      // Plan §7 P168–174 / M39: the model's reply is grounded against the
      // evidence the deterministic tool path retrieved. Contradictory or
      // invented facts are removed and re-rendered from verified fields; a
      // failed retrieval surfaces as an explicit error, never as a null or a
      // faked "no results". Evidence without any rows plus a named error is a
      // failed retrieval; evidence without rows and no error is genuinely empty.
      // R28: final subject gate for the model path. Whatever tool the model
      // picked, rows off the asked topic/genre/"koncert" never reach the reply;
      // nothing left means the deterministic honest empty answer below.
      {
        const tdG = turnDiscovery(userMessages, ctx);
        if (tdG.seeking) {
          const userTexts = userMessages.filter((m) => m.role === "user").map((m) => String(m.content ?? ""));
          const gG = chainGenre(userTexts);
          const twG = Array.from(new Set([...nonGenreTopics(tdG.intent.topicWords), ...placeTopicsOf([latestUserMessage(userMessages)])]));
          const wantsConcert = /koncert|concert/iu.test(latestUserMessage(userMessages));
          const on = (r: any, kind: string) => {
            if (gG && !rowIsGenre(r, gG)) return false;
            if (twG.length && !twG.some((w) => topicWordHit(r, w))) return false;
            if (wantsConcert && kind === "event" && (r.category || (r.interest_tags || []).length) && !/musik|koncert|concert|jazz|rock|band/iu.test(`${r.category ?? ""} ${(r.interest_tags || []).join(" ")} ${r.title ?? ""}`)) return false;
            return true;
          };
          if (gG || twG.length || wantsConcert) {
            // Semantic rows carry no category/tags: fetch them so the gate can judge.
            const bare = (groundedToolResults as any[]).filter((g) => g.kind === "event").flatMap((g) => g.rows || []).filter((r: any) => r?.id && r.category === undefined && r.interest_tags === undefined).map((r: any) => String(r.id));
            if (bare.length && wantsConcert && (aiResponse.tool_calls || []).some((tc: any) => tc?.function?.name === "semantic_search")) {
              try {
                const { data } = await createSupabaseClient(env.SUPABASE_URL, env.SUPABASE_KEY).from("events").select("id, category, interest_tags").in("id", bare.slice(0, 40));
                const byId = new Map(((data || []) as any[]).map((d) => [String(d.id), d]));
                for (const g of groundedToolResults as any[]) if (g.kind === "event") g.rows = (g.rows || []).map((r: any) => byId.has(String(r.id)) ? { ...r, category: byId.get(String(r.id)).category, interest_tags: byId.get(String(r.id)).interest_tags } : r);
              } catch { /* gate on what we have */ }
            }
            const placeOnly = twG.length > 0 && twG.every((w) => ["café", "bar", "biograf", "museum"].includes(w));
            const keepIds = new Set<string>();
            for (const g of groundedToolResults as any[]) {
              g.rows = placeOnly && g.kind === "event" ? [] : (g.rows || []).filter((r: any) => on(r, g.kind));
              for (const r of g.rows) if (r?.id) keepIds.add(String(r.id));
            }
            for (let i = groundedToolResults.length - 1; i >= 0; i--) if (!((groundedToolResults[i] as any).rows || []).length) groundedToolResults.splice(i, 1);
            const prune = (arr: any[], idOf: (x: any) => any) => { for (let i = arr.length - 1; i >= 0; i--) if (!keepIds.has(String(idOf(arr[i])))) arr.splice(i, 1); };
            prune(collectedEventIds, (x) => x); prune(collectedPlaceIds, (x) => x);
            prune(collectedEvents, (x) => x?.id); prune(collectedPlaces, (x) => x?.id);
          }
        }
      }
      const groundedSources = buildGroundedSources(groundedToolResults);
      const isNamedError = (code: string) =>
        ["budget_exhausted_embedding_calls", "embedding_failed", "rpc_failed", "rpc_unreachable", "turn_deadline_exceeded"].includes(code)
        || code.startsWith("cap_exceeded_");
      const namedError = groundedToolResults.length === 0
        ? toolResultErrors.find(isNamedError) ?? null
        : null;
      const replyLang = inferResponseLanguage(userMessages.map((m) => m.content).join(" ")) === "en" ? "en" : "da";
      // Plan §9 P188 / M41: a deadline-expired turn answers honestly from the
      // tool evidence alone — no second model call, no invented completion.
      // groundModelReply with empty model text renders ONLY verified rows.
      let grounded: { reply: string; grounding: string; corrections: string[] };
      let deadlineDegradation: ReturnType<typeof degradationNotice> | undefined;
      if (deadlineHitMidTools) {
        const partial = groundModelReply("", groundedSources, { lang: replyLang, retrievalError: namedError ?? null });
        deadlineDegradation = degradationNotice("turn_deadline_exceeded");
        grounded = {
          reply: partial.reply ? `${deadlineDegradation.notice}\n\n${partial.reply.split("\n").filter((l) => !/^(Hentet:|Kilde opdateret:|Kildens opdateringstid|Retrieved:|Source updated:|Source update time)/.test(l.trim())).join("\n").trim()}` : deadlineDegradation.notice,
          grounding: partial.grounding,
          corrections: partial.corrections,
        };
      } else {
        const repaired = repairContradictoryGroundedReply(
          finalResponse.response || finalResponse.content || "",
          collectedPlaces,
          collectedEvents,
          replyLang,
        );
        grounded = groundModelReply(repaired, groundedSources, { lang: replyLang, retrievalError: namedError ?? null });
      }

      // R24: an empty discovery answer is written from the resolved intent,
      // never from the model ("ingen events lørdag" when the window is fredag).
      if (groundedSources.length === 0 && collectedEventIds.length === 0 && collectedPlaceIds.length === 0 && !namedError && !deadlineHitMidTools) {
        const td = turnDiscovery(userMessages, ctx);
        // A retrieval that returned nothing cannot back a bulleted list either
        // ("legepladser i Odense" → three invented playgrounds).
        const listsRows = /^[ \t]*(?:[*•\-]|\d+\.)[ \t]+\S/m.test(String(grounded.reply || ""));
        if (td.seeking || listsRows) grounded = { ...grounded, reply: honestEmptyReply(td.intent, chainGenre(userMessages.filter((m) => m.role === "user").map((m) => String(m.content ?? ""))), replyLang === "en" ? "en" : "da"), grounding: "verified" } as any;
      }

      // M41 resource cap: the response payload is byte-capped, and any cut is
      // flagged on the payload — never a silently clipped answer.
      const chatPayload = capReplyBytes({
              reply: grounded.reply,
              grounding: grounded.grounding,
              corrections: grounded.corrections,
              intent_proposal: turnIntentProposal,
              tool_calls_made: aiResponse.tool_calls.map((tc: any) => tc.function.name),
              // Cards follow the prose: the rows the reply names, first.
              place_ids: idsByMention(collectedPlaces.length ? collectedPlaces : collectedPlaceIds.map((id) => ({ id })), grounded.reply),
              event_ids: idsByMention(collectedEvents.length ? collectedEvents : collectedEventIds.map((id) => ({ id })), grounded.reply),
              suggested_tag_slugs: [...new Set(collectedTagSlugs)],
              partial: deadlineHitMidTools || undefined,
              ...(rowsCapped ? { rows_capped: RESOURCE_CAPS.rows } : {}),
              ...(deadlineDegradation ? { degraded: true, degradation: deadlineDegradation } : {}),
              budget: budget.snapshot(),
            });
      return jsonResponse(chatPayload.payload);
          }

    // No tool calls — never invent discovery results. Fall back to direct DB search.
    const latest = latestUserMessage(userMessages);
    if (
      turnDiscovery(userMessages, ctx).seeking ||
      looksUngroundedDiscoveryReply(aiResponse.response || aiResponse.content || "")
    ) {
      return await directDiscoveryFallback(env, userMessages, ctx);
    }
    // No tool, not a discovery turn, yet the model lists timed events: those
    // came from nowhere. Answer honestly instead of passing invention through.
    if (looksLikeUngroundedFact(aiResponse.response || aiResponse.content || "")) {
      console.log(JSON.stringify({ event: "ungrounded_listing_blocked" }));
      const lang = inferResponseLanguage(latest) === "en" ? "en" : "da";
      return jsonResponse(clarifyDiscoveryReply(lang));
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
    // Structured, bounded detail so the cause is visible in Workers Logs (the
    // bare Error above serialises to a stack only). Never sent to the caller.
    console.error(JSON.stringify({
      event: "chat_turn_failed",
      name: err?.name ?? null,
      code: err?.code ?? null,
      detail: String(err instanceof Error ? err.message : err).replace(/eyJ[\w.-]+/g, "[jwt]").slice(0, 140),
    }));

    // The MODEL failing is not the same as having no answer. Workers AI has a
    // daily neuron allowance, models have outages, and calls time out -- none
    // of which the reader can act on, and all of which used to surface as
    // "Noget gik galt" on a question we could answer perfectly well.
    // directDiscoveryFallback is pure Supabase (no env.AI at all), so when the
    // question was a discovery question, answer it instead of apologising.
    // (2026-08-01 customer audit: every event-search query 500'd this way while
    // plain chitchat, which needs no tools, returned 200.)
    if (fallbackMessages) {
      try {
        // The catalogue answer is only for a turn that asked us to look
        // something up. The 503 class this branch fixes (golden-set cases 1/2)
        // is discovery-shaped and keeps directDiscoveryFallback; a chitchat or
        // save turn must not be answered with "Jeg fandt ingen resultater".
        return await catalogueFallbackForTurn(env, fallbackMessages, fallbackCtx, providerDegradation(err));
      } catch (fallbackErr) {
        console.error("Chat fallback error:", fallbackErr);
      }
    }

    // Nothing left to answer with. Say what is actually true -- the old copy
    // ("Tjek dit internet") blamed the reader's connection for our outage --
    // and point at the surface that does not need the assistant.
    return jsonResponse({
      error: "Jeg kan ikke søge lige nu. Prøv igen om lidt, eller find events direkte under Udforsk.",
    }, 503);
  }
}

// Helper to create JSON responses with CORS
function jsonResponse(data: any, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      // Which prompt produced this answer. Without it, editing the prompt and
      // redeploying makes every previous answer unattributable — "it used to
      // say something different" stops being checkable.
      "X-Prompt-Version": PROMPT_VERSION,
      ...CORS_HEADERS,
      ...extraHeaders,
    },
  });
}

// ── Test-only exports ────────────────────────────────────────────────────────
// Pure helpers the vitest suite exercises without touching Cloudflare globals.
// Prefixed __test so the Worker export surface stays the default handler.
export const __test = {
  isChatInputTruncated,
  tagTruncatedResponse,
  normalizePublicChatMessages,
  MAX_MESSAGE_CHARS,
  MAX_MESSAGES,
};

