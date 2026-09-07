import { supabase } from './supabase.ts';
import type { DeclareSuit, GameAction, GameState, Ruleset } from '../engine/types.ts';

export type PublicPlayer = {
  seatIndex: number;
  displayName: string;
  isAI: boolean;
  connected: boolean;
  cardCount: number;
  replacedByAI: boolean;
};

export type PublicGameState = {
  gameId: string;
  mode: 'solo_ai' | 'mixed' | 'humans_only';
  status: 'lobby' | 'active' | 'finished';
  maxSeats: number;
  players: PublicPlayer[];
  turnSeatIndex: number | null;
  topDiscard: { id: string; rank: string; suit: string } | null;
  currentSuit: DeclareSuit | null;
  drawCount: number;
  direction: 1 | -1;
  hasDrawn: boolean;
  pendingPickup: number;
  carryOn: boolean;
  winnerSeatIndex: number | null;
  version: number;
  ruleset: Ruleset;
  mySeatIndex: number;
  isHost: boolean;
};

export type GameSnapshot = { publicState: PublicGameState; myHand: GameState['players'][number]['hand']; phase?: GameState['phase'] };

export async function callGame<T>(action: string, payload: Record<string, unknown> = {}): Promise<T> {
  if (!supabase) throw new Error('Supabase is not configured.');
  const { data, error } = await supabase.functions.invoke('game', {
    body: { action, ...payload },
  });
  if (error) throw error;
  if (data?.error) throw new Error(data.error.message || 'Game request failed.');
  return data as T;
}

export async function createSoloGame(displayName: string, opponents: number, ruleset?: Ruleset) {
  return callGame<{ gameId: string }>('create_solo', { displayName, opponents, ruleset });
}

export async function createLobby(mode: 'mixed' | 'humans_only', maxSeats: number, displayName: string, ruleset?: Ruleset) {
  return callGame<{ gameId: string }>('create_lobby', { mode, maxSeats, displayName, ruleset });
}

export async function joinGame(gameId: string, displayName: string) {
  return callGame<{ gameId: string }>('join_game', { gameId, displayName });
}

export async function playAgain(gameId: string) {
  return callGame<{ gameId: string }>('play_again', { gameId });
}

export async function lobbyAction(gameId: string, action: 'start_game' | 'add_ai' | 'remove_ai') {
  return callGame<{ gameId: string }>(action, { gameId });
}

export async function getGame(gameId: string) {
  return callGame<GameSnapshot>('get_game', { gameId });
}

export async function sendGameAction(gameId: string, gameAction: GameAction) {
  return callGame<GameSnapshot>('game_action', { gameId, gameAction });
}
