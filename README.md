# Crazy Eights Arcade

A mobile-first Crazy Eights game built as a lightweight React/Vite arcade experience. It supports solo vs AI locally and, with Supabase configured, server-authoritative online humans-only and mixed multiplayer.

## What is included

- Standard 52-card Crazy Eights engine
- 1–5 AI opponents
- Humans-only and mixed multiplayer lobby flows
- Server-side action validation
- Private player hands via Supabase RLS + Edge Function boundary
- Server-side AI with a short thinking delay
- Disconnect → AI takeover data model
- Realtime broadcast refresh plus polling fallback
- Responsive dark arcade UI
- Invite URLs at `/game/{gameId}`
- X/Twitter share intents
- Automated engine tests
- GitHub Pages and Vercel deployment files

## Requirements

- Node.js >= 22.12.0 (the `npm run verify` script uses `--experimental-strip-types`)
- npm 10+

## Local development

```bash
npm install
npm run dev
```

Without Supabase environment variables, **Play vs AI** uses the local engine. Online lobbies require Supabase.

Create `.env.local` from `.env.example`:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
```

## Validate before deployment

```bash
npm run verify
npm test
npm run typecheck
npm run build
```

## Supabase

See [`supabase/README.md`](./supabase/README.md).

All Crazy Eights tables, triggers, indexes, and Postgres functions are namespaced with the `crazy_eights_` prefix. If this project shares a Supabase database, the pre-existing `scores`/`players` tables of the other game are never read, written, or altered.

Important: never expose `SUPABASE_SERVICE_ROLE_KEY` in `.env.local`, GitHub Pages, Vercel client environment variables, or browser code.

## GitHub Pages

This repo includes `.github/workflows/deploy-pages.yml` and a post-build `404.html` fallback. The workflow builds with `VITE_BASE=/crazy-eights-arcade/`, matching the repository name.

If you rename the GitHub repository, change `VITE_BASE` in the workflow.

GitHub Pages does not provide server-side functions. Supabase remains the backend.

## Vercel

Import the repo into Vercel and set:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

The included `vercel.json` handles the `/game/{gameId}` SPA route.

## Canonical v1 rules

- 5 cards each at 2–3 players
- 4 cards each at 4–6 players
- Match suit or rank, or play an 8
- An 8 requires a new suit declaration
- If no playable card exists, draw exactly one
- A playable drawn card may be played or kept
- Empty draw pile reshuffles discard cards except the top card
- First player to empty their hand wins
- House rules are represented in the ruleset but are not exposed in the v1 UI
