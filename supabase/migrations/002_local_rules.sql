-- ---------------------------------------------------------------------------
-- Crazy Eights "local rules" update.
--
-- Adds the carryOn / pendingPickup state fields that underpin the house rules
-- from the ruleset feature (King extra play, pickup stacking & Ace block), and
-- rewrites the version-checked commit RPC so those fields are persisted on
-- every snapshot.
-- ---------------------------------------------------------------------------

alter table public.crazy_eights_game_state
  add column if not exists pending_pickup int not null default 0,
  add column if not exists carry_on boolean not null default false;

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
      carry_on           = coalesce((p_state->>'carryOn')::boolean, false),
      pending_pickup     = coalesce((p_state->>'pendingPickup')::int, 0),
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