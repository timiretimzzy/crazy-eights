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

export function advanceTurn(state: GameState): void {
  state.turnSeatIndex = nextOccupiedSeat(state, state.turnSeatIndex, state.direction);
  state.hasDrawn = false;
}
