import { isPlayable } from './rules.ts';
import type { Card, GameAction, GameState, Ruleset, Suit } from './types.ts';

export function chooseAiAction(state: GameState, seatIndex: number, ruleset: Ruleset): GameAction {
  const player = state.players.find((p) => p.seatIndex === seatIndex);
  const topCard = state.discardPile[state.discardPile.length - 1];
  if (!player || !topCard) throw new Error('AI cannot act without a player and discard card');

  const playable = player.hand.filter((card) => isPlayable(card, topCard, state.currentSuit, ruleset));
  if (playable.length > 0) {
    const suitMatches = playable.filter((card) => card.rank !== '8' && card.suit === state.currentSuit);
    if (suitMatches.length > 0) return { type: 'PLAY_CARD', cardId: suitMatches[0].id };
    const rankMatches = playable.filter((card) => card.rank === topCard.rank && card.rank !== '8');
    if (rankMatches.length > 0) return { type: 'PLAY_CARD', cardId: rankMatches[0].id };
    return { type: 'PLAY_CARD', cardId: playable[0].id };
  }

  if (!state.hasDrawn) return { type: 'DRAW_CARD' };
  return { type: 'END_TURN' };
}

export function chooseAiSuit(hand: Card[]): Suit {
  const counts: Record<Suit, number> = { hearts: 0, diamonds: 0, clubs: 0, spades: 0 };
  for (const card of hand) counts[card.suit] += 1;
  return (Object.entries(counts) as [Suit, number][]).sort((a, b) => b[1] - a[1])[0][0];
}
