# b-social-chat-worker

Cloudflare Worker powering the AI chat feature for [b-social.net](https://b-social.net).

## Live URL

`POST https://b-social-chat.nicbj96.workers.dev/chat`

## What it does

- Accepts chat messages + page context from the frontend
- Uses Cloudflare Workers AI (`@cf/meta/llama-4-scout-17b-16e-instruct`) with tool calls
- Tools: `search_events`, `search_places` → queries Supabase REST API live
- Injects time/day/season context automatically
- Injects entity details when user is viewing a specific event or place
- Returns AI reply + any matched event/place IDs for the frontend to display

## Request format

```json
{
  "messages": [{ "role": "user", "content": "Find jazz events this weekend" }],
  "context": {
    "pageType": "feed",
    "search_query": "",
    "entity_id": "123",
    "entity_type": "event"
  }
}
```

## Deploy

```bash
npm run deploy
```

Then push to GitHub:

```bash
git push https://REDACTED_GITHUB_PAT@github.com/bbssocialnico-bit/b-social-chat-worker.git main
```

## Companion repo

Frontend: [bbssocialnico-bit/b-social-pages](https://github.com/bbssocialnico-bit/b-social-pages)

## Reference

See `CLAUDE.md` in this repo for full developer/AI session reference.
