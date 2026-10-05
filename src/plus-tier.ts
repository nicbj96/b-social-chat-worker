import type { ChatTier } from "./chat-provider";

/** Server-side Plus check with the service key. Fail-safe: any error → "free". */
export async function resolveChatTier(
  env: { SUPABASE_URL: string; SUPABASE_KEY: string },
  userId: string | null,
  now = Date.now(),
): Promise<ChatTier> {
  if (!userId) return "free";
  try {
    const url = `${env.SUPABASE_URL}/rest/v1/plus_subscriptions?user_id=eq.${encodeURIComponent(userId)}&status=in.(active,trialing)&select=current_period_end&order=current_period_end.desc.nullsfirst&limit=1`;
    const res = await fetch(url, {
      headers: { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${env.SUPABASE_KEY}` },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const rows = (await res.json()) as { current_period_end: string | null }[];
    if (!rows[0]) return "free";
    const end = rows[0].current_period_end;
    return end === null || Date.parse(end) > now ? "plus" : "free";
  } catch (err) {
    console.error(JSON.stringify({ event: "plus_lookup_failed", detail: String(err).slice(0, 120) }));
    return "free";
  }
}
