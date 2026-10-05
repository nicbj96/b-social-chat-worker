import type { ChatTier } from "./chat-provider";

/**
 * Server-side Plus check. RLS on plus_subscriptions: select_own for
 * authenticated, ALL for service_role — the anon key alone sees nothing.
 * Credentials: service key if set, else the caller's user JWT (apikey = anon),
 * else no lookup. Fail-safe: any error → "free".
 */
export async function resolveChatTier(
  env: { SUPABASE_URL: string; SUPABASE_KEY: string; SUPABASE_SERVICE_KEY?: string },
  userId: string | null,
  userJwt: string | null,
  now = Date.now(),
): Promise<ChatTier> {
  if (!userId) return "free";
  let headers: Record<string, string>;
  if (env.SUPABASE_SERVICE_KEY) {
    headers = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
  } else if (userJwt) {
    headers = { apikey: env.SUPABASE_KEY, Authorization: `Bearer ${userJwt}` };
  } else {
    console.error(JSON.stringify({ event: "plus_lookup_failed", reason: "no_credentials" }));
    return "free";
  }
  try {
    const url = `${env.SUPABASE_URL}/rest/v1/plus_subscriptions?user_id=eq.${encodeURIComponent(userId)}&status=in.(active,trialing)&select=current_period_end&order=current_period_end.desc.nullsfirst&limit=1`;
    const res = await fetch(url, {
      headers,
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
