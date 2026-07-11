# B-Social Chat Worker

Production Cloudflare Worker for B-Social’s public discovery assistant, push delivery, and authenticated founder automation.

## Canonical ownership

- Repository: `https://github.com/nicbj96/b-social-chat-worker`
- Local: `C:\Users\45536\Desktop\CODING B-SOCIAL\b-social-chat-worker-nic-live`
- Worker: `b-social-chat`
- Live: `https://b-social-chat.nicbj96.workers.dev`
- Frontend: `https://github.com/nicbj96/b-social-pages`
- Supabase: `rbengtfrthqdfbcdcugp`

## Endpoints

- `POST /chat`, `/search`, `/embed`
- `POST /push/*`
- `GET /health`
- Authenticated founder endpoints: `/admin/ask`, `/admin/robot`, `/admin/fetch`, `/admin/transcribe`, `/admin/image`, `/admin/vision`

## Durable abuse budgets

A strongly consistent SQLite-backed Durable Object runs before request parsing, authentication work, database calls, or AI usage:

- Public AI (`/chat`, `/search`, `/embed`): 30 requests/minute per opaque route/actor key
- Push (`/push/send`, `/push/broadcast`): 60 requests/minute
- Founder admin (`/admin/*`): 30 requests/minute

Raw connecting addresses are SHA-256 hashed before use as keys. Every route/actor pair has one serialized durable counter. If the Durable Object is temporarily unavailable, the Worker uses a capped in-isolate fallback instead of taking public chat down. An exhausted budget returns 429 with `Retry-After`.

## Local verification

```bash
npm install
npm run verify:local
```

## Deploy

Deploy **only** from this canonical folder:

```bash
git remote get-url origin
npm run verify:local
git push origin main
npm run deploy
curl -f https://b-social-chat.nicbj96.workers.dev/health
```

`predeploy` automatically runs the full verification gate. Secrets are Cloudflare Worker secrets and must never appear in source, docs, shell output, or commits.

See `CLAUDE.md` for architecture, safety rules, and the complete production workflow.
