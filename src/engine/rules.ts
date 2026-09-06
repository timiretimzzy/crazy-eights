import type { Card, Ruleset, Suit } from './types.ts';

export function isPlayable(card: Card, topCard: Card, currentSuit: Suit | null, ruleset: Ruleset): boolean {
  if (ruleset.eightsWild && card.rank === '8') return true;
  if (currentSuit && card.suit === currentSuit) return true;
  return card.rank === topCard.rank;
}

export function cardsPerPlayer(playerCount: number, ruleset: Ruleset): number {
  return playerCount <= ruleset.dealRules.smallGameMaxPlayers
    ? ruleset.dealRules.smallGameCards
    : ruleset.dealRules.largeGameCards;
}

export function canDraw(hasDrawn: boolean): boolean {
  return !hasDrawn;
}
