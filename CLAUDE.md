# B-Social Chat Worker — canonical reference

> Last verified: 2026-07-11

## Production ownership

- **Repository:** `nicbj96/b-social-chat-worker`
- **Canonical local path:** `C:\Users\45536\Desktop\CODING B-SOCIAL\b-social-chat-worker-nic-live`
- **Branch:** `main`
- **Cloudflare Worker:** `b-social-chat`
- **Live base URL:** `https://b-social-chat.nicbj96.workers.dev`
- **Supabase:** `rbengtfrthqdfbcdcugp` (`B-social1`)
- **Frontend:** `nicbj96/b-social-pages` under the same `CODING B-SOCIAL` monorepo

This folder is the **only** valid chat-worker deployment source on this machine. Never deploy from an archive, loose Desktop clone, fork, or alternate organization.

## Responsibilities

Public:
- `POST /chat` — grounded event/place assistant
- `POST /search` — search support
- `POST /embed` — embeddings
- `POST /push/*` — authenticated push delivery
- `GET /health` — liveness

Founder/admin (all gated by `ADMIN_ASK_KEY`):
- `POST /admin/ask` — relay to Command Center brain
- `POST /admin/robot` — run an approved robot
- `POST /admin/fetch` — SSRF-guarded public-web research
- `POST /admin/transcribe` — admin voice transcription
- `POST /admin/image` — admin image generation
- `POST /admin/vision` — admin image understanding

Scheduled:
- Friday 17:00 UTC — weekly push digest
- Monday 06:00 UTC — ad-pack robot
- Wednesday 07:00 UTC — partner-finder robot

## Models and data

- Main model: `@cf/meta/llama-4-scout-17b-16e-instruct`
- Search tools query live B-Social Supabase data.
- The worker must never invent event/place facts when tools fail.
- Secrets live in Cloudflare Worker secrets, never in source or documentation.

## Required verification

```bash
npm run verify:local
```

This must pass before every deploy. `npm run deploy` runs it automatically through `predeploy`.

## Safe deploy sequence

```bash
git status --short
git remote get-url origin
npm run verify:local
git add <narrow file list>
git commit -m "..."
git push origin main
npm run deploy
curl -f https://b-social-chat.nicbj96.workers.dev/health
```

Confirm the remote is exactly `https://github.com/nicbj96/b-social-chat-worker.git` before deploying. Push and deploy must reference the same reviewed commit.

## Security rules

- Never print, commit, paste, or document secret values.
- `/push/send` and all `/admin/*` endpoints must fail closed without credentials.
- All outbound arbitrary URLs must pass through `src/fetchguard.ts`.
- Validate IDs, cap strings/arrays, enforce timeouts, and avoid reflecting sensitive upstream errors.
- Consequential founder actions are draft-first and human-approved.
- Keep CORS restricted to approved B-Social origins.

## Completion standard

A change is complete only when:
1. Tests, TypeScript, production dependency audit, and safety guard pass.
2. The commit is pushed to `nicbj96/b-social-chat-worker`.
3. The worker is deployed from this canonical folder.
4. `/health` and changed endpoint behavior are verified live.
