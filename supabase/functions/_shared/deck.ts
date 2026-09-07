import { JOKER_SUIT, RANKS, SUITS } from './types.ts';
import type { Card } from './types.ts';

export const JOKER_COUNT = 2;

export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      if (rank === 'JOKER') continue;
      deck.push({
        id: `${rank}-${suit}`,
        suit,
        rank,
      });
    }
  }
  for (let i = 0; i < JOKER_COUNT; i += 1) {
    deck.push({
      id: `JOKER-${i === 0 ? 'A' : 'B'}`,
      suit: JOKER_SUIT,
      rank: 'JOKER',
    });
  }
  return deck;
}

export function shuffle<T>(items: T[], random: () => number = Math.random): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}