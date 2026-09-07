import type { GameState } from './types.ts';

export function nextOccupiedSeat(state: GameState, fromSeat: number, direction: 1 | -1): number {
  const seats = state.players.map((player) => player.seatIndex).sort((a, b) => a - b);
  if (seats.length === 0) throw new Error('No players in game');
  let index = seats.indexOf(fromSeat);
  if (index < 0) index = 0;
  for (let i = 0; i < seats.length; i += 1) {
    index = (index + direction + seats.length) % seats.length;
    const candidate = seats[index];
    if (candidate !== fromSeat || seats.length === 1) return candidate;
  }
  return fromSeat;
}

/** Moves to the next seat in the current direction and clears per-turn flags.
 * carryOn is reset here: an extra play opportunity never survives a turn change. */
export function advanceTurn(state: GameState): void {
  state.turnSeatIndex = nextOccupiedSeat(state, state.turnSeatIndex, state.direction);
  state.hasDrawn = false;
  state.carryOn = false;
}

/** 7/J skip: the player who would have gone next is skipped entirely. */
export function skipNextPlayer(state: GameState): void {
  state.turnSeatIndex = nextOccupiedSeat(state, state.turnSeatIndex, state.direction);
  state.turnSeatIndex = nextOccupiedSeat(state, state.turnSeatIndex, state.direction);
  state.hasDrawn = false;
  state.carryOn = false;
}

/** 7/J reverse: flips the direction, then advances once. */
export function reverseTurn(state: GameState): void {
  state.direction = (state.direction * -1) as 1 | -1;
  advanceTurn(state);
}