import * as Sentry from "@sentry/cloudflare";
import { SYSTEM_PROMPT } from "./system-prompt";
import { TOOLS } from "./tools";
import {
  createSupabaseClient,
  searchEvents,
  searchRoutes,
  searchPlaces,
} from "./supabase-queries";
import { sendWebPush, type PushMessage } from "./webpush";
import { isSafeEntityId, isValidUuid, clampString, clampNumber } from "./validate";

// Env bindings
interface Env {
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

    if (url.pathname === "/health") {
      return jsonResponse({ status: "ok", service: "b-social-chat" });
    }

    return jsonResponse({ error: "Not found" }, 404);
  },

  // Scheduled weekly digest (configured in wrangler.toml)
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runWeeklyDigest(env));
  },
};

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
  // Send "5 events denne weekend" to all subscribed users
  const message: PushMessage = {
    title: "B-Social — Weekend guide 🎉",
    body: "Se hvad der sker i weekenden. Nye events matcher dine interesser.",
    url: "/feed",
    tag: "weekly-digest",
  };
  const r = await fetch(`${env.SUPABASE_URL}/rest/v1/push_subscriptions?enabled=eq.true&select=endpoint,p256dh,auth`, {
    headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` },
  });
  // C4 — coerce to [] if Supabase returned an error object instead of an array.
  const subsData = await r.json();
  const subs = (Array.isArray(subsData) ? subsData : []) as Array<{ endpoint: string; p256dh: string; auth: string }>;
  const vapid = vapidFromEnv(env);
  for (const s of subs) {
    try { await sendWebPush(s, message, vapid); } catch {}
  }
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

    const result: any = await env.AI.run("@cf/baai/bge-m3", { text: texts });
    // bge-m3 returns { data: number[][] } or { shape, data }
    const embeddings = result?.data ?? [];
    return jsonResponse({ embeddings, count: embeddings.length, dim: embeddings[0]?.length ?? 0 });
  } catch (err: any) {
    return jsonResponse({ error: "embed failed", details: err.message }, 500);
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

    const emb: any = await env.AI.run("@cf/baai/bge-m3", { text: [query] });
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
    return jsonResponse({ error: "search failed", details: err.message }, 500);
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

// S4 — conservative input caps (cost + prompt-injection blowup guard).
const MAX_MESSAGES = 30;        // keep only the last N turns
const MAX_MESSAGE_CHARS = 4000; // per-message content cap
const MAX_BODY_BYTES = 256 * 1024; // reject trivially-huge bodies early (256KB)

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

    const body = (await request.json()) as {
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

    // Support both { messages: [...] } and { message: "..." }
    let userMessages: ChatMessage[];

    if (body.messages && Array.isArray(body.messages)) {
      // S4 — cap to the last MAX_MESSAGES turns and clamp each content length.
      userMessages = body.messages
        .slice(-MAX_MESSAGES)
        .map((m) => ({
          role: m.role as ChatMessage["role"],
          content: clampString(m.content, MAX_MESSAGE_CHARS),
        }));
    } else if (body.message) {
      userMessages = [{ role: "user", content: clampString(body.message, MAX_MESSAGE_CHARS) }];
    } else {
      return jsonResponse({ error: "Mangler 'message' eller 'messages' felt" }, 400);
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

    // Build the full conversation with system prompt
    const messages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT + contextNote },
      ...userMessages,
    ];

    // First AI call — may include tool calls
    const aiResponse = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
      messages,
      tools: TOOLS,
      tool_choice: "auto",
    });

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
              const emb: any = await env.AI.run("@cf/baai/bge-m3", { text: [fnArgs.query] });
              const vec = emb?.data?.[0];
              if (!vec) { result = { error: "embedding failed" }; break; }
              const sbHeaders = { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}`, "Content-Type": "application/json" };
              const kind = fnArgs.kind ?? "both";
              const out: any = { events: [], places: [] };
              if (kind === "events" || kind === "both") {
                const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_events`, {
                  method: "POST", headers: sbHeaders,
                  body: JSON.stringify({ query_embedding: vec, match_count: 8, match_threshold: 0.3, filter_country: fnArgs.country ?? null }),
                });
                out.events = await r.json();
                (out.events || []).forEach((e: any) => e.id && collectedEventIds.push(e.id));
              }
              if (kind === "places" || kind === "both") {
                const r = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/match_places`, {
                  method: "POST", headers: sbHeaders,
                  body: JSON.stringify({ query_embedding: vec, match_count: 8, match_threshold: 0.3, filter_country: fnArgs.country ?? null }),
                });
                out.places = await r.json();
                (out.places || []).forEach((p: any) => p.id && collectedPlaceIds.push(p.id));
              }
              result = out;
            } catch (e: any) { result = { error: String(e.message || e) }; }
            break;
          }
          case "search_events":
            result = await searchEvents(supabase, fnArgs);
            if (result.results) {
              result.results.forEach((e: any) => e.id && collectedEventIds.push(e.id));
            }
            break;
          case "search_routes":
            result = await searchRoutes(supabase, fnArgs);
            break;
          case "search_places":
            result = await searchPlaces(supabase, fnArgs);
            if (result.results) {
              result.results.forEach((p: any) => p.id && collectedPlaceIds.push(p.id));
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
      const finalResponse = await env.AI.run("@cf/meta/llama-4-scout-17b-16e-instruct", {
        messages,
      });

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
        reply: finalResponse.response || finalResponse.content || "",
        tool_calls_made: aiResponse.tool_calls.map((tc: any) => tc.function.name),
        place_ids: collectedPlaceIds,
        event_ids: collectedEventIds,
        suggested_tag_slugs: [...new Set(collectedTagSlugs)],
      });
    }

    // No tool calls — direct response
    return jsonResponse({
      reply: aiResponse.response || aiResponse.content || "",
      tool_calls_made: [],
      place_ids: [],
      event_ids: [],
      suggested_tag_slugs: [],
    });
  } catch (err: any) {
    console.error("Chat error:", err);
    return jsonResponse(
      { error: "Noget gik galt. Prøv igen.", details: err.message },
      500
    );
  }
}

// Helper to create JSON responses with CORS
function jsonResponse(data: any, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...CORS_HEADERS,
    },
  });
}
