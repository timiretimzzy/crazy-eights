# Supabase setup

1. Create a Supabase project.
2. Enable **Anonymous sign-ins** under Authentication → Providers.
3. Run the SQL migration in `migrations/001_crazy_eights.sql` using the Supabase SQL editor or `supabase db push`.
4. Deploy the `game` Edge Function:

```bash
supabase functions deploy game --no-verify-jwt
```

The function uses the built-in `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` environment variables available to Edge Functions.

The frontend uses the anonymous auth session to identify a human seat. Never put the service role key in the browser.

## Security model

`crazy_eights_game_state`, `crazy_eights_game_events`, and `crazy_eights_player_hands` are not directly readable/writable by anonymous/authenticated clients. The Edge Function uses the service role to load private state and returns a sanitized snapshot containing only:

- the caller's own cards
- opponents' card counts
- top discard
- current suit
- draw pile count
- turn / winner metadata

The raw draw pile is never sent to clients.

## Rematches

After a finished game, the host can choose **Play again**. The existing player seats are preserved, the game returns to its lobby, and the host can start a fresh round with the same table configuration.
