# B-Social Chat Worker — REFERENCE (Read this FIRST)

> **Last updated:** April 17, 2026

---

## What this repo is

Cloudflare Worker that powers the AI chat feature on b-social.net.

- **GitHub:** `bbssocialnico-bit/b-social-chat-worker`
- **Local path:** `C:\Users\45536\Desktop\b-social-chat-worker`
- **Live URL:** `https://b-social-chat.nicbj96.workers.dev/chat`
- **Endpoint:** `POST /chat` with JSON body `{ messages, context }`

---

## Companion repo (frontend)

- **GitHub:** `bbssocialnico-bit/b-social-pages`
- **Local path:** `C:\Users\45536\Desktop\b-social-repo`

Both repos must be kept in sync. Always push to BOTH when making changes that affect both.

---

## Deploy

```powershell
cd C:\Users\45536\Desktop\b-social-chat-worker

# Deploy to Cloudflare (live immediately)
npm run deploy

# Also push to GitHub (REQUIRED every time)
git add src/index.ts
"Worker: your change description" | Out-File -FilePath commitmsg.txt -Encoding utf8
git commit -F commitmsg.txt
git push https://REDACTED_GITHUB_PAT@github.com/bbssocialnico-bit/b-social-chat-worker.git main
```

> Worker changes are live immediately — no CI pipeline needed.

---

## GitHub PAT

```
REDACTED_GITHUB_PAT
```

---

## Architecture

### Model
`@cf/meta/llama-4-scout-17b-16e-instruct` (Cloudflare Workers AI)

### Tool calls
The model can call two tools to fetch live data from Supabase:
- `search_events` — searches events by title/description/category
- `search_places` — searches places by name/tags

### Context injection (system prompt)
The worker builds a dynamic system prompt based on `context` in the request body:

| Context field | What it does |
|---|---|
| `pageType` | Tells AI what page user is on (feed, search, event, place, map) |
| `search_query` | Current search term |
| `entity_id` + `entity_type` | Fetches event/place details from Supabase, injects title/tags |
| `recent_views` | Recently viewed event/place IDs |
| `last_session` | Last session summary |

### Time/season context
Automatically injected: day name, time of day, season, weekend/weekday.

---

## File structure

```
src/
  index.ts        ← main worker (all logic here)
wrangler.toml     ← worker config (name: b-social-chat)
package.json      ← deps: @cloudflare/workers-types, typescript
tsconfig.json
```

---

## Supabase REST API

Worker queries Supabase directly via REST (not the JS client):

```
https://rbengtfrthqdfbcdcugp.supabase.co/rest/v1/events?...
Headers: apikey: <anon key>, Authorization: Bearer <anon key>
```

Anon key: stored in Cloudflare Worker secrets (`SUPABASE_KEY`).

---

## Request format (from frontend)

```json
{
  "messages": [
    { "role": "user", "content": "Find events near me this weekend" }
  ],
  "context": {
    "pageType": "feed",
    "search_query": "",
    "entity_id": "123",
    "entity_type": "event",
    "recent_views": ["event:45", "place:12"],
    "last_session": "Looked at concerts last time"
  }
}
```

---

## Common issues

### Worker changes not showing on site
- Worker deploys instantly via `npm run deploy`
- If the frontend is not calling the worker, check `AIChatWidget.tsx` and `Soeg.tsx` — they POST to `https://b-social-chat.nicbj96.workers.dev/chat`

### Worker code out of sync with GitHub
- Always run `git push ...` after `npm run deploy`
- This was a historical problem — the worker was deployed many times without ever being pushed to GitHub

### Supabase entity lookup failing
- Check `SUPABASE_KEY` secret is set in Cloudflare dashboard for this worker
- Cloudflare dashboard → Workers → b-social-chat → Settings → Variables

---

## Brief for new Claude sessions

```
This is the Cloudflare Worker for B-Social AI chat.
GitHub: bbssocialnico-bit/b-social-chat-worker
Local: C:\Users\45536\Desktop\b-social-chat-worker
Deploy: npm run deploy (then git push to keep GitHub in sync)
PAT: REDACTED_GITHUB_PAT
Frontend lives at: bbssocialnico-bit/b-social-pages (C:\Users\45536\Desktop\b-social-repo)
Worker URL: https://b-social-chat.nicbj96.workers.dev/chat
```
