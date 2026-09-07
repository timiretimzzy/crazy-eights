import type { Card, DeclareSuit, Ruleset } from './types.ts';

export const STARTER_RANKS = new Set(['3', '4', '5', '6', '9', '10', 'Q']);
export const WINNING_RANKS = STARTER_RANKS;

export function isStarterRank(rank: Card['rank'] | string): boolean {
  return STARTER_RANKS.has(rank);
}

export function isWinningRank(rank: Card['rank'] | string): boolean {
  return WINNING_RANKS.has(rank);
}

/** A pickup response: Ace (block), Joker (add), or 2 (add). */
export function canRespondToPickup(card: Card, ruleset: Ruleset): boolean {
  if (card.rank === 'A') return ruleset.aceBlocksPickup;
  if (card.rank === 'JOKER') return ruleset.jokerEnabled && ruleset.jokerPickup > 0;
  if (card.rank === '2') return ruleset.twoPickup > 0;
  return false;
}

export function hasPickupResponse(cards: Card[], ruleset: Ruleset): boolean {
  return cards.some((card) => canRespondToPickup(card, ruleset));
}

/**
 * Normal cards are not playable while a pickup is pending: the acting player
 * may only respond with Ace (block), Joker, or 2, or pick up automatically.
 * King does not bypass a pickup and pickup ranks ignore suit.
 */
export function isPlayable(
  card: Card,
  topCard: Card,
  currentSuit: DeclareSuit | null,
  ruleset: Ruleset,
  options: { pendingPickup?: number } = {},
): boolean {
  if (card.rank === 'JOKER') return ruleset.jokerEnabled;
  if ((options.pendingPickup ?? 0) > 0) return canRespondToPickup(card, ruleset);
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