# Security model

The browser is an untrusted client.

All gameplay mutations go through the `game` Supabase Edge Function. The function identifies the current anonymous Supabase Auth user, finds their seat, reconstructs authoritative state, validates the action using the shared game engine, and commits the result through the `commit_game_snapshot` Postgres function with an expected-version check.

The raw draw pile and opponent hands are never exposed to browser clients. Public snapshots contain only the top discard, current suit, draw count, opponent card counts, turn metadata, and the caller's private hand.

RLS intentionally prevents direct browser mutation of `crazy_eights_game_state`, `crazy_eights_player_hands`, and `crazy_eights_game_events`.

The Crazy Eights schema is fully namespaced with the `crazy_eights_` prefix and is independent of the `scores` and `players` tables owned by the other game in this shared Supabase project. No Crazy Eights migration or function reads, writes, or alters those tables.

Never put `SUPABASE_SERVICE_ROLE_KEY` in a `VITE_*` variable or browser bundle.
