# Deployment checklist

## 1. Create the Supabase project

Create a Supabase project and enable **Anonymous sign-ins** in Authentication → Providers.

Run:

```text
supabase/migrations/001_crazy_eights.sql
```

in the Supabase SQL editor. All objects are namespaced with the `crazy_eights_` prefix and do not touch any pre-existing `scores`/`players` tables in the same database.

Deploy:

```bash
supabase functions deploy game --no-verify-jwt
```

The Edge Function validates the Supabase access token itself because its public HTTP entrypoint is configured with JWT gateway verification disabled. Do not expose the service role key in the frontend.

## 2. Configure the frontend

Copy `.env.example` to `.env.local` for local development:

```env
VITE_SUPABASE_URL=https://YOUR_PROJECT.supabase.co
VITE_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY
```

The anon/publishable key is intended for browser use. The service role key is not.

## 3. Test locally

Requires Node.js >= 22.12.0.

```bash
npm install
npm run verify
npm test
npm run build
npm run dev
```

With no Supabase environment variables, the **Play vs AI** button uses the local rules engine so the UI can be exercised before backend setup.

## 4. GitHub Pages

Push the repository to GitHub with the repository named `crazy-eights-arcade` or change `VITE_BASE` in `.github/workflows/deploy-pages.yml`.

In repository Settings → Secrets and variables → Actions → Variables, add:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`

Enable GitHub Pages with **GitHub Actions** as the source. The workflow builds and publishes `dist`.

The generated `404.html` is a SPA fallback, which keeps `/game/{gameId}` invite URLs working on GitHub Pages.

## 5. Vercel

Import the repository into Vercel and add the two `VITE_*` environment variables. `vercel.json` handles direct `/game/{gameId}` navigation.

## 6. Production security verification

Before calling production ready:

- Open two different browsers and complete a human-only game.
- Inspect Network responses and confirm an opponent's hand is never present.
- Confirm the draw pile order is never present in client responses.
- Manually send an invalid card action and confirm the Edge Function rejects it.
- Attempt to act twice in parallel and confirm one action is rejected as stale/not-your-turn.
- Close a player tab during an active game and confirm another connected client's polling triggers AI takeover within the configured timeout window.
- Copy an invite URL into a fresh private window and confirm it opens the join screen.
- Test the X share link from the production domain.
