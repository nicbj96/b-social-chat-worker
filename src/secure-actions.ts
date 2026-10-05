// Plan §§8–9 P176–184: secure chat actions — server-validated arguments and
// ownership, stable action ids, durable dedup + atomic action/receipt
// transaction (via add_chat_note_v1), exact-row readback BEFORE any saved
// confirmation, and a telemetry allowlist with no raw chat text, raw query
// or precise GPS. This module owns the add_note write path; other write
// tools migrate onto it in later slices (see evidence/secure-actions rapport).

export const NOTE_CONTENT_MAX = 2000;
export const NOTE_TITLE_MAX = 120;
export const NOTE_TAGS_MAX = 10;
const TAG_SLUG = /^[a-z0-9_-]{1,40}$/;

export type NoteArgs = { content: string; title?: string; tags?: string[] };
export type SecureResult = Record<string, unknown>;

/** Server-side validation. The model's tool arguments are untrusted input. */
export function normalizeNoteArgs(args: unknown): { ok: true; args: NoteArgs } | { ok: false; error: string } {
  const a = (args ?? {}) as Record<string, unknown>;
  const content = typeof a.content === "string" ? a.content.trim() : "";
  if (!content) return { ok: false, error: "Noten mangler indhold" };
  if (content.length > NOTE_CONTENT_MAX) return { ok: false, error: "Noten er for lang (maks 2000 tegn)" };
  const out: NoteArgs = { content };
  if (a.title !== undefined && a.title !== null) {
    const title = typeof a.title === "string" ? a.title.trim() : "";
    if (title.length > NOTE_TITLE_MAX) return { ok: false, error: "Titlen er for lang (maks 120 tegn)" };
    if (title) out.title = title;
  }
  if (a.tags !== undefined && a.tags !== null) {
    if (!Array.isArray(a.tags) || a.tags.some((t) => typeof t !== "string")) {
      return { ok: false, error: "Ugyldige note-tags" };
    }
    const tags = (a.tags as string[]).map((t) => t.trim().toLowerCase()).filter(Boolean);
    if (tags.length > NOTE_TAGS_MAX) return { ok: false, error: "For mange note-tags (maks 10)" };
    if (tags.some((t) => !TAG_SLUG.test(t))) return { ok: false, error: "Ugyldige note-tags" };
    if (tags.length) out.tags = [...new Set(tags)];
  }
  return { ok: true, args: out };
}

/** Canonical JSON (sorted keys) — the payload that the action id binds. */
export function canonicalNotePayload(args: NoteArgs): string {
  const canonical: Record<string, unknown> = { content: args.content };
  if (args.title !== undefined) canonical.title = args.title;
  if (args.tags !== undefined) canonical.tags = [...args.tags].sort();
  const keys = Object.keys(canonical).sort();
  const ordered: Record<string, unknown> = {};
  for (const k of keys) ordered[k] = canonical[k];
  return JSON.stringify(ordered);
}

/** Stable action id: sha256(user | action | payload). Replay-safe. */
export async function stableActionKey(userId: string, actionType: string, canonicalPayload: string): Promise<string> {
  const data = new TextEncoder().encode(`${userId}|${actionType}|${canonicalPayload}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A write is only executed when the user explicitly requested it (Plan P180:
 * "tydeligt anmodede harmløse handlinger skal ikke have unødige ekstra
 * prompts" — and the converse: unrequested writes are refused). Catalog or
 * memory content that says "gem alt om mig" must never become a tool call
 * the user asked for; the note-intent patterns are narrow on purpose.
 */
export function noteRequested(userMessage: string | undefined | null): boolean {
  if (!userMessage) return false;
  return /\bnotér\b|\bnoter\b|\bhusk at\b|\bmemo\b|\bskriv en note\b/i.test(userMessage);
}

/**
 * Plan P183: standard telemetry carries NO raw chat text, no raw query and
 * no precise GPS — only a coarse allowlisted event shape.
 */
export function buildTelemetryEvent(context: unknown): Record<string, unknown> {
  const ctx = (context ?? {}) as Record<string, unknown>;
  return {
    page: typeof ctx.pageType === "string" ? ctx.pageType : null,
    active_tags_count: Array.isArray(ctx.active_tags) ? ctx.active_tags.length : 0,
    has_entity: Boolean(ctx.entity_id),
    has_viewport: Boolean(ctx.viewport),
  };
}

function noteReadbackMismatch(row: Record<string, unknown>, userId: string, args: NoteArgs): boolean {
  if (row.user_id !== userId) return true;
  if (row.content !== args.content) return true;
  if ((row.title ?? null) !== (args.title ?? null)) return true;
  if (JSON.stringify(row.tags ?? []) !== JSON.stringify(args.tags ?? [])) return true;
  return false;
}

/**
 * The whole secure add_note action through the real caller's credentials:
 * RPC (atomic note + action + receipt inside one database transaction,
 * durable dedup on action_key) → exact-row readback with the user's own JWT
 * under RLS → only then a saved confirmation. Any failure (expired JWT,
 * foreign ownership, RPC refusal, readback timeout/mismatch) returns an
 * error result and never a fake "saved" receipt (Plan P181).
 */
export async function executeSecureAddNote(
  env: { SUPABASE_URL: string; SUPABASE_KEY: string },
  userId: string | null,
  userJwt: string | null,
  fnArgs: unknown,
  userMessages: { role: string; content: string }[],
  memo?: Map<string, SecureResult>,
): Promise<SecureResult> {
  if (!userId || !userJwt) return { error: "Du skal være logget ind for at gemme en note" };
  const normalized = normalizeNoteArgs(fnArgs);
  if (!normalized.ok) return { error: normalized.error };
  const latestUser = [...(userMessages ?? [])].reverse().find((m) => m.role === "user");
  if (!noteRequested(latestUser?.content)) {
    return { error: "Noter oprettes kun når du selv beder om det — sig fx 'noter at ...'" };
  }
  const actionKey = await stableActionKey(userId, "add_note", canonicalNotePayload(normalized.args));
  // Turn-scoped double-click guard: two identical tool calls in the same turn
  // share ONE stable action id and therefore ONE write + ONE readback.
  if (memo?.has(actionKey)) {
    return { ...(memo.get(actionKey) as SecureResult), deduped: true, action: "replayed" };
  }
  const headers: Record<string, string> = {
    apikey: env.SUPABASE_KEY,
    Authorization: `Bearer ${userJwt}`,
    "Content-Type": "application/json",
  };
  // Atomic action/receipt transaction; replay of an already-committed
  // action_key returns the SAME note from the durable receipt table.
  let rpcRes: Response;
  try {
    rpcRes = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/add_chat_note_v1`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        p_action_key: actionKey,
        p_title: normalized.args.title ?? null,
        p_content: normalized.args.content,
        p_tags: normalized.args.tags ?? null,
      }),
    });
  } catch {
    return { error: "Kunne ikke gemme noten lige nu", code: "action_rpc_unreachable" };
  }
  if (!rpcRes.ok) {
    return { error: "Kunne ikke gemme noten lige nu", code: "action_rpc_failed", status: rpcRes.status };
  }
  let rows: any[] = [];
  try {
    rows = (await rpcRes.json()) as any[];
  } catch {
    return { error: "Kunne ikke gemme noten lige nu", code: "action_rpc_bad_response" };
  }
  const outcome = rows?.[0];
  const noteId = outcome?.note?.id;
  if (!outcome || !noteId) {
    return { error: "Kunne ikke gemme noten lige nu", code: "action_rpc_bad_response" };
  }
  // Exact-row readback BEFORE saved confirmation — never trust the write's
  // own response; the receipt must match the request payload exactly.
  let readRes: Response;
  try {
    readRes = await fetch(
      `${env.SUPABASE_URL}/rest/v1/notes?id=eq.${encodeURIComponent(String(noteId))}&user_id=eq.${encodeURIComponent(userId)}&select=id,user_id,title,content,tags&limit=1`,
      { headers },
    );
  } catch {
    return { error: "Noten er gemt, men kunne ikke verificeres — prøv igen", code: "action_readback_unreachable" };
  }
  if (!readRes.ok) {
    return { error: "Noten er gemt, men kunne ikke verificeres — prøv igen", code: "action_readback_failed", status: readRes.status };
  }
  let readRows: any[] = [];
  try {
    readRows = (await readRes.json()) as any[];
  } catch {
    return { error: "Noten er gemt, men kunne ikke verificeres — prøv igen", code: "action_readback_bad_response" };
  }
  const row = readRows?.[0];
  if (!row || noteReadbackMismatch(row, userId, normalized.args)) {
    return { error: "Den gemte note stemmer ikke med anmodningen", code: "action_readback_mismatch" };
  }
  const replayed = outcome.action === "replayed";
  const confirmed: SecureResult = {
    ok: true,
    note_id: row.id,
    title: row.title ?? null,
    action: replayed ? "replayed" : "executed",
    deduped: replayed,
    readback: "verified",
  };
  memo?.set(actionKey, confirmed);
  return confirmed;
}
