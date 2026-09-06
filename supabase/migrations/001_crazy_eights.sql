create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Crazy Eights: fully namespaced schema.
--
-- All Crazy Eights objects are prefixed "crazy_eights_" so they cannot collide
-- with the existing scores / players tables used by the other game in this
-- shared Supabase project.
--
-- This migration NEVER reads, writes, alters, or references the "scores" or
-- "players" tables belonging to the other game.
-- ---------------------------------------------------------------------------

create table if not exists public.crazy_eights_games (
  id uuid primary key default gen_random_uuid(),
  mode text not null check (mode in ('solo_ai', 'mixed', 'humans_only')),
  ruleset jsonb not null,
  status text not null default 'lobby' check (status in ('lobby', 'active', 'finished')),
  max_seats int not null check (max_seats between 2 and 6),
  host_user_id uuid not null references auth.users(id),
  winner_seat_index int,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

create table if not exists public.crazy_eights_game_players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.crazy_eights_games(id) on delete cascade,
  seat_index int not null check (seat_index between 0 and 5),
  is_ai boolean not null default false,
  display_name text not null check (char_length(display_name) between 1 and 18),
  owner_user_id uuid references auth.users(id),
  connected boolean not null default true,
  replaced_by_ai boolean not null default false,
  last_seen_at timestamptz not null default now(),
  joined_at timestamptz not null default now(),
  unique (game_id, seat_index),
  check ((is_ai and owner_user_id is null) or (not is_ai and owner_user_id is not null))
);

create index if not exists crazy_eights_game_players_game_idx
  on public.crazy_eights_game_players(game_id);

create unique index if not exists crazy_eights_game_players_user_game_idx
  on public.crazy_eights_game_players(game_id, owner_user_id)
  where owner_user_id is not null;

create table if not exists public.crazy_eights_player_hands (
  player_id uuid primary key references public.crazy_eights_game_players(id) on delete cascade,
  cards jsonb not null default '[]'::jsonb
);

create table if not exists public.crazy_eights_game_state (
  game_id uuid primary key references public.crazy_eights_games(id) on delete cascade,
  draw_pile jsonb not null,
  discard_pile jsonb not null,
  current_suit text,
  turn_seat_index int not null,
  direction int not null default 1 check (direction in (-1, 1)),
  phase text not null default 'PLAYING',
  has_drawn boolean not null default false,
  pending_eight_card_id text,
  winner_seat_index int,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

create table if not exists public.crazy_eights_game_events (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.crazy_eights_games(id) on delete cascade,
  seat_index int,
  event_type text not null,
  payload jsonb,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------

alter table public.crazy_eights_games      enable row level security;
alter table public.crazy_eights_game_players enable row level security;
alter table public.crazy_eights_player_hands enable row level security;
alter table public.crazy_eights_game_state   enable row level security;
alter table public.crazy_eights_game_events  enable row level security;

-- Membership helper (SECURITY DEFINER so it works inside RLS policies).

create or replace function public.crazy_eights_is_game_member(p_game_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.crazy_eights_game_players
    where game_id = p_game_id and owner_user_id = auth.uid()
  );
$$;

revoke all on function public.crazy_eights_is_game_member(uuid) from public, anon;
grant  execute on function public.crazy_eights_is_game_member(uuid) to authenticated;

-- Games: readable by members or the host.

drop policy if exists crazy_eights_games_select_member on public.crazy_eights_games;
create policy crazy_eights_games_select_member on public.crazy_eights_games
  for select using (
    public.crazy_eights_is_game_member(id) or host_user_id = auth.uid()
  );

-- Game players: readable by any member of the same game.

drop policy if exists crazy_eights_game_players_select_member on public.crazy_eights_game_players;
create policy crazy_eights_game_players_select_member on public.crazy_eights_game_players
  for select using (public.crazy_eights_is_game_member(crazy_eights_game_players.game_id));

-- Hands are PRIVATE. Only the owning human can SELECT their own hand.
-- No INSERT / UPDATE / DELETE policies — only the Edge Function (service_role)
-- mutates hands through the commit RPC.

drop policy if exists crazy_eights_player_hands_select_owner on public.crazy_eights_player_hands;
create policy crazy_eights_player_hands_select_owner on public.crazy_eights_player_hands
  for select using (
    exists (
      select 1 from public.crazy_eights_game_players gp
      where gp.id = crazy_eights_player_hands.player_id and gp.owner_user_id = auth.uid()
    )
  );

-- game_state and game_events intentionally have NO client-facing policies and
-- NO table-level grants, so clients cannot read or write the draw pile, live
-- state, or the event stream. The Edge Function uses the service_role to
-- read/write these directly.
revoke all on public.crazy_eights_game_state   from anon, authenticated;
revoke all on public.crazy_eights_game_events  from anon, authenticated;

-- Grant SELECT so the RLS policies above actually take effect for signed-in
-- anonymous users (the `authenticated` role): a player can read public game
-- info, public player rows (names/status/card counts), and their own hand row.
-- No write privileges are granted anywhere; only the Edge Function mutates data.
grant select on public.crazy_eights_games       to authenticated;
grant select on public.crazy_eights_game_players to authenticated;
grant select on public.crazy_eights_player_hands to authenticated;

-- ---------------------------------------------------------------------------
-- Commit RPC (service_role only, version-checked optimistic concurrency)
-- ---------------------------------------------------------------------------

create or replace function public.crazy_eights_commit_game_snapshot(
  p_game_id uuid,
  p_expected_version bigint,
  p_state jsonb,
  p_hands jsonb,
  p_events jsonb,
  p_game_status text,
  p_winner_seat_index int
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_current bigint;
  v_hand jsonb;
  v_player_id uuid;
begin
  if auth.role() <> 'service_role' then
    raise exception 'forbidden';
  end if;

  select version into v_current
  from public.crazy_eights_game_state
  where game_id = p_game_id
  for update;

  if v_current is null then raise exception 'game_state_not_found'; end if;
  if v_current <> p_expected_version then raise exception 'stale_game_state'; end if;

  update public.crazy_eights_game_state
  set draw_pile          = p_state->'drawPile',
      discard_pile       = p_state->'discardPile',
      current_suit       = nullif(p_state->>'currentSuit', ''),
      turn_seat_index    = (p_state->>'turnSeatIndex')::int,
      direction          = (p_state->>'direction')::int,
      phase              = p_state->>'phase',
      has_drawn          = coalesce((p_state->>'hasDrawn')::boolean, false),
      pending_eight_card_id = p_state->>'pendingEightCardId',
      winner_seat_index  = nullif(p_state->>'winnerSeatIndex', '')::int,
      version            = (p_state->>'version')::bigint,
      updated_at         = now()
  where game_id = p_game_id;

  for v_hand in select * from jsonb_array_elements(coalesce(p_hands, '[]'::jsonb)) loop
    v_player_id := (v_hand->>'playerId')::uuid;
    update public.crazy_eights_player_hands
    set cards = v_hand->'cards'
    where player_id = v_player_id;
  end loop;

  update public.crazy_eights_games
  set status = p_game_status,
      winner_seat_index = p_winner_seat_index,
      started_at = case
        when p_game_status = 'active' and started_at is null then now()
        else started_at
      end,
      finished_at = case
        when p_game_status = 'finished' and finished_at is null then now()
        else finished_at
      end
  where id = p_game_id;

  for v_hand in select * from jsonb_array_elements(coalesce(p_events, '[]'::jsonb)) loop
    insert into public.crazy_eights_game_events(game_id, seat_index, event_type, payload)
    values (
      p_game_id,
      nullif(v_hand->>'seatIndex', '')::int,
      v_hand->>'eventType',
      v_hand->'payload'
    );
  end loop;

  return jsonb_build_object('ok', true, 'version', (p_state->>'version')::bigint);
end;
$$;

revoke all on function public.crazy_eights_commit_game_snapshot(uuid, bigint, jsonb, jsonb, jsonb, text, int)
  from public, anon, authenticated;
grant  execute on function public.crazy_eights_commit_game_snapshot(uuid, bigint, jsonb, jsonb, jsonb, text, int)
  to service_role;
