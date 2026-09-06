// Supabase Edge Function: the only public game mutation boundary.
// The browser sends intents; this function authenticates the caller,
// reconstructs authoritative state, applies the shared engine, and commits
// with an optimistic version check inside Postgres.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { DEFAULT_RULESET, type Card, type GameAction, type GameState, type Player, type Ruleset, type Suit } from '../_shared/types.ts';
import { applyAction, initializeGame } from '../_shared/reducer.ts';
import { isPlayable } from '../_shared/rules.ts';
import { chooseAiAction, chooseAiSuit } from '../_shared/ai.ts';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const publicClient = createClient(SUPABASE_URL, Deno.env.get('SUPABASE_ANON_KEY') ?? '');
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// Guards against multiple concurrent AI chains running for the same game.
// Only one background chain may mutate a game at a time; the versioned commit
// already protects the DB, but this avoids wasted compute and duplicate work.
const aiChainsInFlight = new Set<string>();

type DbPlayer = {
  id: string;
  game_id: string;
  seat_index: number;
  is_ai: boolean;
  display_name: string;
  owner_user_id: string | null;
  connected: boolean;
  replaced_by_ai: boolean;
  last_seen_at: string;
};

type DbHand = { player_id: string; cards: Card[] };

type Body = {
  action: string;
  gameId?: string;
  displayName?: string;
  opponents?: number;
  mode?: 'mixed' | 'humans_only';
  maxSeats?: number;
  ruleset?: Ruleset;
  gameAction?: GameAction;
};

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

function headers() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: headers() });
}

async function getUser(req: Request) {
  const authHeader = req.headers.get('Authorization');
  if (!authHeader?.startsWith('Bearer ')) return null;
  const token = authHeader.slice('Bearer '.length);
  const { data, error } = await publicClient.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

function cleanName(name: string | undefined) {
  const value = (name ?? '').trim().replace(/[<>]/g, '').slice(0, 18);
  return value || 'Player';
}

function normalizeRuleset(ruleset?: Ruleset): Ruleset {
  // Treat the stored ruleset as configuration, not arbitrary executable input.
  return {
    eightsWild: ruleset?.eightsWild ?? DEFAULT_RULESET.eightsWild,
    dealRules: { ...DEFAULT_RULESET.dealRules, ...(ruleset?.dealRules ?? {}) },
    houseRules: { ...DEFAULT_RULESET.houseRules, ...(ruleset?.houseRules ?? {}) },
  };
}

async function gameRows(gameId: string) {
  const [{ data: game, error: gameError }, { data: players, error: playersError }] = await Promise.all([
    admin.from('crazy_eights_games').select('*').eq('id', gameId).single(),
    admin.from('crazy_eights_game_players').select('*').eq('game_id', gameId).order('seat_index'),
  ]);
  if (gameError || !game) throw new Error('GAME_NOT_FOUND');
  if (playersError) throw playersError;
  return { game, players: (players ?? []) as DbPlayer[] };
}

async function getAuthoritativeState(gameId: string): Promise<GameState> {
  const [{ data: state, error: stateError }, { data: players, error: playerError }] = await Promise.all([
    admin.from('crazy_eights_game_state').select('*').eq('game_id', gameId).single(),
    admin.from('crazy_eights_game_players').select('*').eq('game_id', gameId).order('seat_index'),
  ]);
  if (stateError || !state) throw new Error('GAME_STATE_NOT_FOUND');
  if (playerError) throw playerError;
  const rows = (players ?? []) as DbPlayer[];
  const ids = rows.map(p => p.id);
  const { data: hands, error: handError } = await admin.from('crazy_eights_player_hands').select('player_id,cards').in('player_id', ids);
  if (handError) throw handError;
  const handMap = new Map((hands ?? []).map((h: DbHand) => [h.player_id, h.cards]));
  return {
    phase: state.phase,
    players: rows.map(p => ({
      id: p.id,
      displayName: p.display_name,
      isAI: p.is_ai || p.replaced_by_ai,
      seatIndex: p.seat_index,
      hand: handMap.get(p.id) ?? [],
      connected: p.connected,
    })),
    drawPile: state.draw_pile as Card[],
    discardPile: state.discard_pile as Card[],
    currentSuit: state.current_suit as Suit | null,
    turnSeatIndex: state.turn_seat_index,
    direction: state.direction as 1 | -1,
    hasDrawn: state.has_drawn,
    pendingEightCardId: state.pending_eight_card_id,
    winnerSeatIndex: state.winner_seat_index,
    version: Number(state.version),
  };
}

function toPublicState(game: any, state: GameState, players: DbPlayer[], mySeatIndex: number) {
  const topDiscard = state.discardPile[state.discardPile.length - 1] ?? null;
  return {
    gameId: game.id,
    mode: game.mode,
    status: game.status,
    maxSeats: game.max_seats,
    players: players.map(p => {
      const hand = state.players.find(sp => sp.seatIndex === p.seat_index)?.hand ?? [];
      return {
        seatIndex: p.seat_index,
        displayName: p.display_name,
        isAI: p.is_ai || p.replaced_by_ai,
        connected: p.connected,
        replacedByAI: p.replaced_by_ai,
        cardCount: hand.length,
      };
    }),
    turnSeatIndex: game.status === 'lobby' ? null : state.turnSeatIndex,
    topDiscard: topDiscard ? { id: topDiscard.id, rank: topDiscard.rank, suit: topDiscard.suit } : null,
    currentSuit: state.currentSuit,
    drawCount: state.drawPile.length,
    direction: state.direction,
    hasDrawn: state.hasDrawn,
    winnerSeatIndex: state.winnerSeatIndex,
    version: state.version,
    ruleset: normalizeRuleset(game.ruleset),
    mySeatIndex,
    isHost: game.host_user_id === players.find(p => p.seat_index === mySeatIndex)?.owner_user_id,
    phase: state.phase,
  };
}

async function takeoverStalePlayers(gameId: string) {
  const { data: stale, error } = await admin.from('crazy_eights_game_players')
    .select('id,seat_index,display_name,owner_user_id,is_ai,replaced_by_ai,last_seen_at')
    .eq('game_id', gameId)
    .eq('is_ai', false)
    .eq('replaced_by_ai', false)
    .eq('connected', true)
    .lt('last_seen_at', new Date(Date.now() - 20000).toISOString());
  if (error) throw error;
  if (!stale?.length) return false;
  for (const player of stale as DbPlayer[]) {
    await admin.from('crazy_eights_game_players').update({ connected: false, replaced_by_ai: true }).eq('id', player.id);
    await admin.from('crazy_eights_game_events').insert({ game_id: gameId, seat_index: player.seat_index, event_type: 'ai_takeover', payload: { displayName: player.display_name, reason: 'heartbeat_timeout' } });
  }
  await broadcast(gameId, Date.now());
  return true;
}

async function snapshotForUser(gameId: string, userId: string) {
  let { game, players } = await gameRows(gameId);
  const mine = players.find(p => p.owner_user_id === userId);
  if (!mine) throw new Error('NOT_A_PLAYER');
  if (!mine.is_ai && !mine.replaced_by_ai) {
    await admin.from('crazy_eights_game_players').update({ last_seen_at: new Date().toISOString(), connected: true }).eq('id', mine.id);
  }
  if (game.status === 'active') {
    await takeoverStalePlayers(gameId);
    ({ game, players } = await gameRows(gameId));
  }
  const state = game.status === 'lobby'
    ? ({ phase: 'LOBBY', players: [], drawPile: [], discardPile: [], currentSuit: null, turnSeatIndex: 0, direction: 1, hasDrawn: false, pendingEightCardId: null, winnerSeatIndex: null, version: 0 } as GameState)
    : await getAuthoritativeState(gameId);
  const myHand = state.players.find(p => p.seatIndex === mine.seat_index)?.hand ?? [];
  if (game.status === 'active' && state.phase === 'PLAYING' && state.players.find(p => p.seatIndex === state.turnSeatIndex)?.isAI) {
    EdgeRuntime.waitUntil(runAiChain(gameId));
  }
  return { publicState: toPublicState(game, state, players, mine.seat_index), myHand, phase: state.phase };
}

async function commitState(gameId: string, oldState: GameState, next: GameState, events: { type: string; seatIndex?: number; payload?: Record<string, unknown> }[]) {
  const gameStatus = next.phase === 'FINISHED' ? 'finished' : 'active';
  const eventRows = events.map(e => ({ eventType: e.type, seatIndex: e.seatIndex ?? null, payload: e.payload ?? null }));
  const hands = next.players.map(p => ({ playerId: p.id, cards: p.hand }));
  const { error } = await admin.rpc('crazy_eights_commit_game_snapshot', {
    p_game_id: gameId,
    p_expected_version: oldState.version,
    p_state: {
      drawPile: next.drawPile,
      discardPile: next.discardPile,
      currentSuit: next.currentSuit,
      turnSeatIndex: next.turnSeatIndex,
      direction: next.direction,
      phase: next.phase,
      hasDrawn: next.hasDrawn,
      pendingEightCardId: next.pendingEightCardId,
      winnerSeatIndex: next.winnerSeatIndex,
      version: next.version,
    },
    p_hands: hands,
    p_events: eventRows,
    p_game_status: gameStatus,
    p_winner_seat_index: next.winnerSeatIndex,
  });
  if (error) {
    if (String(error.message).includes('stale_game_state')) throw new Error('STALE_GAME_STATE');
    throw error;
  }
}

async function broadcast(gameId: string, version: number) {
  const channel = admin.channel(`game:${gameId}`);
  await channel.subscribe();
  await channel.send({ type: 'broadcast', event: 'GAME_UPDATED', payload: { version } });
  await admin.removeChannel(channel);
}

async function requireMember(gameId: string, userId: string) {
  const { game, players } = await gameRows(gameId);
  const mine = players.find(p => p.owner_user_id === userId);
  if (!mine) throw new Error('NOT_A_PLAYER');
  return { game, players, mine };
}

async function createSolo(userId: string, body: Body) {
  const opponents = Math.max(1, Math.min(5, Number(body.opponents ?? 3)));
  const ruleset = normalizeRuleset(body.ruleset);
  const { data: game, error: gameError } = await admin.from('crazy_eights_games').insert({
    mode: 'solo_ai', max_seats: opponents + 1, ruleset, status: 'active', host_user_id: userId, started_at: new Date().toISOString(),
  }).select().single();
  if (gameError || !game) throw gameError ?? new Error('Could not create game');

  const playerRows = [
    { game_id: game.id, seat_index: 0, is_ai: false, display_name: cleanName(body.displayName), owner_user_id: userId },
    ...Array.from({ length: opponents }, (_, i) => ({ game_id: game.id, seat_index: i + 1, is_ai: true, display_name: `Bot ${i + 1}`, owner_user_id: null })),
  ];
  const { data: inserted, error: playerError } = await admin.from('crazy_eights_game_players').insert(playerRows).select();
  if (playerError || !inserted) throw playerError ?? new Error('Could not create players');

  const state = initializeGame(inserted.map((p: any) => ({ id: p.id, displayName: p.display_name, isAI: p.is_ai, seatIndex: p.seat_index, hand: [], connected: true })), ruleset);
  await admin.from('crazy_eights_game_state').insert({
    game_id: game.id,
    draw_pile: state.drawPile,
    discard_pile: state.discardPile,
    current_suit: state.currentSuit,
    turn_seat_index: state.turnSeatIndex,
    direction: state.direction,
    phase: state.phase,
    has_drawn: state.hasDrawn,
    pending_eight_card_id: state.pendingEightCardId,
    winner_seat_index: null,
    version: state.version,
  });
  await admin.from('crazy_eights_player_hands').insert(state.players.map(p => ({ player_id: p.id, cards: p.hand })));
  await admin.from('crazy_eights_game_events').insert({ game_id: game.id, event_type: 'game_started', payload: { mode: 'solo_ai' } });
  EdgeRuntime.waitUntil(runAiChain(game.id));
  return { gameId: game.id };
}

async function createLobby(userId: string, body: Body) {
  const mode = body.mode === 'humans_only' ? 'humans_only' : 'mixed';
  const maxSeats = Math.max(2, Math.min(6, Number(body.maxSeats ?? 4)));
  const ruleset = normalizeRuleset(body.ruleset);
  const { data: game, error: gameError } = await admin.from('crazy_eights_games').insert({ mode, max_seats: maxSeats, ruleset, status: 'lobby', host_user_id: userId }).select().single();
  if (gameError || !game) throw gameError ?? new Error('Could not create lobby');
  const { data: player, error: playerError } = await admin.from('crazy_eights_game_players').insert({ game_id: game.id, seat_index: 0, is_ai: false, display_name: cleanName(body.displayName), owner_user_id: userId }).select().single();
  if (playerError || !player) throw playerError ?? new Error('Could not create host');
  await broadcast(game.id, 0);
  return { gameId: game.id };
}

async function joinLobby(userId: string, body: Body) {
  if (!body.gameId) throw new Error('GAME_NOT_FOUND');
  const { game, players } = await gameRows(body.gameId);
  if (game.status !== 'lobby') throw new Error('GAME_NOT_ACTIVE');
  if (players.some(p => p.owner_user_id === userId)) return { gameId: game.id };
  const seat = Array.from({ length: game.max_seats }, (_, i) => i).find(i => !players.some(p => p.seat_index === i));
  if (seat === undefined) throw new Error('LOBBY_FULL');
  const { error } = await admin.from('crazy_eights_game_players').insert({ game_id: game.id, seat_index: seat, is_ai: false, display_name: cleanName(body.displayName), owner_user_id: userId });
  if (error) {
    if (String(error.message).includes('duplicate')) throw new Error('LOBBY_BUSY');
    throw error;
  }
  await broadcast(game.id, players.length + 1);
  return { gameId: game.id };
}

async function assertHost(gameId: string, userId: string) {
  const { game, players } = await gameRows(gameId);
  if (game.host_user_id !== userId) throw new Error('NOT_HOST');
  return { game, players };
}

async function startGame(userId: string, gameId: string) {
  const { game, players } = await assertHost(gameId, userId);
  if (game.status !== 'lobby') return { gameId };
  let finalPlayers = players;
  if (game.mode === 'mixed') {
    const empty = Array.from({ length: game.max_seats }, (_, i) => i).filter(i => !players.some(p => p.seat_index === i));
    if (empty.length) {
      const existingBotCount = players.filter(p => p.is_ai).length;
      const aiRows = empty.map((seat, index) => ({ game_id: gameId, seat_index: seat, is_ai: true, display_name: `Bot ${existingBotCount + index + 1}`, owner_user_id: null, last_seen_at: new Date().toISOString() }));
      const { data: added, error } = await admin.from('crazy_eights_game_players').insert(aiRows).select();
      if (error || !added) throw error ?? new Error('Could not fill AI seats');
      finalPlayers = [...players, ...(added as DbPlayer[])].sort((a, b) => a.seat_index - b.seat_index);
    }
  } else {
    // Humans-only games shrink to the seats that are actually occupied.
    // Reinsert the same player IDs at compact seat indexes to avoid unique-key
    // collisions while preserving player identity. Lobby rows have no hands yet.
    if (finalPlayers.length < 2) throw new Error('INSUFFICIENT_PLAYERS');
    finalPlayers = [...finalPlayers].sort((a, b) => a.seat_index - b.seat_index);
    const needsReseat = finalPlayers.some((p, i) => p.seat_index !== i);
    if (needsReseat) {
      const rows = finalPlayers.map((p, i) => ({
        id: p.id, game_id: gameId, seat_index: i, is_ai: false, display_name: p.display_name,
        owner_user_id: p.owner_user_id, connected: p.connected, replaced_by_ai: p.replaced_by_ai, joined_at: p.joined_at,
      }));
      const { error: deleteError } = await admin.from('crazy_eights_game_players').delete().eq('game_id', gameId);
      if (deleteError) throw deleteError;
      const { data: reinserted, error: insertError } = await admin.from('crazy_eights_game_players').insert(rows).select();
      if (insertError || !reinserted) throw insertError ?? new Error('Could not reseat players');
      finalPlayers = (reinserted as DbPlayer[]).sort((a, b) => a.seat_index - b.seat_index);
    }
  }
  if (finalPlayers.length < 2) throw new Error('INSUFFICIENT_PLAYERS');
  const ruleset = normalizeRuleset(game.ruleset);
  const state = initializeGame(finalPlayers.map(p => ({ id: p.id, displayName: p.display_name, isAI: p.is_ai, seatIndex: p.seat_index, hand: [], connected: true })), ruleset);
  await admin.from('crazy_eights_game_state').insert({ game_id: gameId, draw_pile: state.drawPile, discard_pile: state.discardPile, current_suit: state.currentSuit, turn_seat_index: state.turnSeatIndex, direction: state.direction, phase: state.phase, has_drawn: false, pending_eight_card_id: null, version: 1 });
  await admin.from('crazy_eights_player_hands').insert(state.players.map(p => ({ player_id: p.id, cards: p.hand })));
  await admin.from('crazy_eights_games').update({ status: 'active', started_at: new Date().toISOString() }).eq('id', gameId);
  await admin.from('crazy_eights_game_events').insert({ game_id: gameId, event_type: 'game_started', payload: { playerCount: finalPlayers.length } });
  await broadcast(gameId, state.version);
  EdgeRuntime.waitUntil(runAiChain(gameId));
  return { gameId };
}

async function addAi(userId: string, gameId: string) {
  const { game, players } = await assertHost(gameId, userId);
  if (game.status !== 'lobby' || game.mode !== 'mixed') throw new Error('GAME_NOT_ACTIVE');
  const seat = Array.from({ length: game.max_seats }, (_, i) => i).find(i => !players.some(p => p.seat_index === i));
  if (seat === undefined) throw new Error('LOBBY_FULL');
  const botCount = players.filter(p => p.is_ai).length + 1;
  await admin.from('crazy_eights_game_players').insert({ game_id: gameId, seat_index: seat, is_ai: true, display_name: `Bot ${botCount}`, owner_user_id: null });
  await broadcast(gameId, players.length + 1);
  return { gameId };
}

async function removeAi(userId: string, gameId: string) {
  const { game, players } = await assertHost(gameId, userId);
  if (game.status !== 'lobby') throw new Error('GAME_NOT_ACTIVE');
  const ai = [...players].reverse().find(p => p.is_ai);
  if (!ai) return { gameId };
  await admin.from('crazy_eights_game_players').delete().eq('id', ai.id);
  await broadcast(gameId, players.length - 1);
  return { gameId };
}

async function playAgain(userId: string, gameId: string) {
  const { game } = await assertHost(gameId, userId);
  if (game.status !== 'finished') throw new Error('GAME_NOT_ACTIVE');
  await admin.from('crazy_eights_game_state').delete().eq('game_id', gameId);
  const { data: players, error } = await admin.from('crazy_eights_game_players').select('*').eq('game_id', gameId);
  if (error) throw error;
  const allIds = (players ?? []).map((p: DbPlayer) => p.id);
  if (allIds.length) await admin.from('crazy_eights_player_hands').delete().in('player_id', allIds);
  await admin.from('crazy_eights_games').update({ status: 'lobby', winner_seat_index: null, finished_at: null }).eq('id', gameId);
  await admin.from('crazy_eights_game_players').update({ connected: true, replaced_by_ai: false, last_seen_at: new Date().toISOString() }).eq('game_id', gameId);
  await admin.from('crazy_eights_game_events').insert({ game_id: gameId, event_type: 'game_created', payload: { rematch: true } });
  await broadcast(gameId, 0);
  return { gameId };
}

async function humanAction(userId: string, gameId: string, action: GameAction) {
  const { game, players, mine } = await requireMember(gameId, userId);
  if (game.status !== 'active') throw new Error('GAME_NOT_ACTIVE');
  if (mine.is_ai || mine.replaced_by_ai || !mine.connected) throw new Error('NOT_A_PLAYER');
  const state = await getAuthoritativeState(gameId);
  if (state.turnSeatIndex !== mine.seat_index) throw new Error('NOT_YOUR_TURN');
  const result = applyAction(state, mine.seat_index, action, normalizeRuleset(game.ruleset));
  if (!result.success) throw new Error(result.error.code);
  await commitState(gameId, state, result.state, result.events);
  await broadcast(gameId, result.state.version);
  if (result.state.phase === 'FINISHED') return await snapshotForUser(gameId, userId);
  const next = result.state.players.find(p => p.seatIndex === result.state.turnSeatIndex);
  if (result.state.phase === 'PLAYING' && next?.isAI) EdgeRuntime.waitUntil(runAiChain(gameId));
  return await snapshotForUser(gameId, userId);
}

async function takeAiTurn(gameId: string) {
  const { game } = await gameRows(gameId);
  if (game.status !== 'active') return false;
  const before = await getAuthoritativeState(gameId);
  const player = before.players.find(p => p.seatIndex === before.turnSeatIndex);
  if (!player?.isAI) return false;
  const ruleset = normalizeRuleset(game.ruleset);

  if (before.hasDrawn) {
    const top = before.discardPile[before.discardPile.length - 1];
    const drawn = player.hand[player.hand.length - 1];
    if (drawn && top && isPlayable(drawn, top, before.currentSuit, ruleset)) {
      const played = applyAction(before, player.seatIndex, { type: 'PLAY_CARD', cardId: drawn.id }, ruleset);
      if (!played.success) throw new Error(played.error.code);
      await commitState(gameId, before, played.state, played.events);
      await broadcast(gameId, played.state.version);
      if (played.state.phase === 'DECLARING_SUIT') {
        const ai = played.state.players.find(p => p.seatIndex === player.seatIndex)!;
        const declared = chooseAiSuit(ai.hand);
        const declaredResult = applyAction(played.state, player.seatIndex, { type: 'DECLARE_SUIT', suit: declared }, ruleset);
        if (!declaredResult.success) throw new Error(declaredResult.error.code);
        await commitState(gameId, played.state, declaredResult.state, declaredResult.events);
        await broadcast(gameId, declaredResult.state.version);
      }
      return true;
    }
    const ended = applyAction(before, player.seatIndex, { type: 'END_TURN' }, ruleset);
    if (!ended.success) throw new Error(ended.error.code);
    await commitState(gameId, before, ended.state, ended.events);
    await broadcast(gameId, ended.state.version);
    return true;
  }

  const action = chooseAiAction(before, player.seatIndex, ruleset);
  const result = applyAction(before, player.seatIndex, action, ruleset);
  if (!result.success) throw new Error(result.error.code);
  await commitState(gameId, before, result.state, result.events);
  await broadcast(gameId, result.state.version);
  if (result.state.phase === 'DECLARING_SUIT') {
    await new Promise(resolve => setTimeout(resolve, 350));
    const ai = result.state.players.find(p => p.seatIndex === player.seatIndex)!;
    const declaredResult = applyAction(result.state, player.seatIndex, { type: 'DECLARE_SUIT', suit: chooseAiSuit(ai.hand) }, ruleset);
    if (!declaredResult.success) throw new Error(declaredResult.error.code);
    await commitState(gameId, result.state, declaredResult.state, declaredResult.events);
    await broadcast(gameId, declaredResult.state.version);
  }
  return true;
}

async function runAiChain(gameId: string) {
  // Branches can be triggered from several callers simultaneously (polling,
  // human actions, earlier finished chains). Keep one mutating chain per game.
  if (aiChainsInFlight.has(gameId)) return;
  aiChainsInFlight.add(gameId);
  try {
    for (let i = 0; i < 20; i += 1) {
      const { game } = await gameRows(gameId);
      if (game.status !== 'active') return;
      const state = await getAuthoritativeState(gameId);
      const active = state.players.find(p => p.seatIndex === state.turnSeatIndex);
      if (!active?.isAI) return;
      await new Promise(resolve => setTimeout(resolve, 650 + Math.round(Math.random() * 500)));
      const changed = await takeAiTurn(gameId);
      if (!changed) return;
      const after = await getAuthoritativeState(gameId);
      if (after.phase === 'FINISHED') return;
    }
  } catch (error) {
    if (error instanceof Error && error.message !== 'STALE_GAME_STATE') {
      console.error('AI chain failed', error);
    }
  } finally {
    aiChainsInFlight.delete(gameId);
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: headers() });
  if (req.method !== 'POST') return json({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Use POST.' } }, 405);

  try {
    const user = await getUser(req);
    if (!user) return json({ error: { code: 'UNAUTHORIZED', message: 'Sign in anonymously to play.' } }, 401);
    const body = await req.json() as Body;
    switch (body.action) {
      case 'create_solo': return json(await createSolo(user.id, body));
      case 'create_lobby': return json(await createLobby(user.id, body));
      case 'join_game': return json(await joinLobby(user.id, body));
      case 'start_game': if (!body.gameId) throw new Error('GAME_NOT_FOUND'); return json(await startGame(user.id, body.gameId));
      case 'add_ai': if (!body.gameId) throw new Error('GAME_NOT_FOUND'); return json(await addAi(user.id, body.gameId));
      case 'remove_ai': if (!body.gameId) throw new Error('GAME_NOT_FOUND'); return json(await removeAi(user.id, body.gameId));
      case 'play_again': if (!body.gameId) throw new Error('GAME_NOT_FOUND'); return json(await playAgain(user.id, body.gameId));
      case 'get_game': if (!body.gameId) throw new Error('GAME_NOT_FOUND'); return json(await snapshotForUser(body.gameId, user.id));
      case 'game_action': if (!body.gameId || !body.gameAction) throw new Error('INVALID_MOVE'); return json(await humanAction(user.id, body.gameId, body.gameAction));
      default: return json({ error: { code: 'UNKNOWN_ACTION', message: 'Unknown game action.' } }, 400);
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : 'INTERNAL_ERROR';
    const known: Record<string, [number, string]> = {
      GAME_NOT_FOUND: [404, 'Game not found.'], GAME_STATE_NOT_FOUND: [500, 'Game state is unavailable.'], NOT_A_PLAYER: [403, 'You are not a player in this game.'], GAME_NOT_ACTIVE: [409, 'This game is not accepting that action.'], NOT_YOUR_TURN: [409, 'It is not your turn.'], INVALID_PLAY: [400, 'That card cannot be played.'], CARD_NOT_OWNED: [400, 'You do not have that card.'], ALREADY_DREW: [400, 'You may only draw once per turn.'], MUST_DRAW_OR_PLAY: [400, 'Draw a card or play before ending your turn.'], INVALID_SUIT: [400, 'Choose a valid suit.'], SUIT_REQUIRED: [400, 'Choose a suit first.'], LOBBY_FULL: [409, 'That lobby is full.'], LOBBY_BUSY: [409, 'Another player just took that seat. Refresh and try again.'], NOT_HOST: [403, 'Only the host can do that.'], INSUFFICIENT_PLAYERS: [409, 'At least two players are required.'], STALE_GAME_STATE: [409, 'The table changed. Your view will refresh.'], NO_CARDS_AVAILABLE: [409, 'There are no cards left to draw.'], INVALID_MOVE: [400, 'Invalid move.'],
    };
    const [status, message] = known[code] ?? [500, 'Something went wrong.'];
    if (status >= 500) console.error(error);
    return json({ error: { code, message } }, status);
  }
});
