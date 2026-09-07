import { isPlayable, isWinningRank } from './rules.ts';
import type { Card, DeclareSuit, GameAction, GameState, Ruleset } from './types.ts';

export function chooseAiAction(state: GameState, seatIndex: number, ruleset: Ruleset): GameAction {
  const player = state.players.find((p) => p.seatIndex === seatIndex);
  const topCard = state.discardPile[state.discardPile.length - 1];
  if (!player || !topCard) throw new Error('AI cannot act without a player and discard card');

  if (state.pendingPickup > 0) {
    // Pickup response priority: Ace (block) > Joker (add) > 2 (add); otherwise
    // pick up the accumulated penalty automatically.
    const ace = player.hand.find((c) => c.rank === 'A' && ruleset.aceBlocksPickup);
    if (ace) return { type: 'PLAY_CARD', cardId: ace.id };
    const joker = player.hand.find((c) => c.rank === 'JOKER');
    if (joker) return { type: 'PLAY_CARD', cardId: joker.id };
    const two = player.hand.find((c) => c.rank === '2');
    if (two) return { type: 'PLAY_CARD', cardId: two.id };
    return { type: 'RESOLVE_PICKUP' };
  }

  const playable = player.hand.filter((card) => isPlayable(card, topCard, state.currentSuit, ruleset));
  if (playable.length === 0) {
    return state.hasDrawn ? { type: 'END_TURN' } : { type: 'DRAW_CARD' };
  }

  let candidates = playable;
  if (player.hand.length === 1) {
    // Avoid emptying the hand with a prohibited final card (it would auto-draw).
    const winning = playable.filter((card) => isWinningRank(card.rank));
    if (winning.length > 0) {
      candidates = winning;
    } else if (!state.hasDrawn) {
      return { type: 'DRAW_CARD' };
    }
  }

  const suitMatches = candidates.filter((card) => card.rank !== '8' && card.rank !== 'JOKER' && card.suit === state.currentSuit);
  if (suitMatches.length > 0) return { type: 'PLAY_CARD', cardId: suitMatches[0].id };
  const rankMatches = candidates.filter((card) => card.rank === topCard.rank && card.rank !== '8' && card.rank !== 'JOKER');
  if (rankMatches.length > 0) return { type: 'PLAY_CARD', cardId: rankMatches[0].id };
  return { type: 'PLAY_CARD', cardId: candidates[0].id };
}

export function chooseAiSuit(hand: Card[]): DeclareSuit {
  const counts: Record<DeclareSuit, number> = { hearts: 0, diamonds: 0, clubs: 0, spades: 0 };
  for (const card of hand) {
    if (card.suit in counts) counts[card.suit as DeclareSuit] += 1;
  }
  return (Object.entries(counts) as [DeclareSuit, number][]).sort((a, b) => b[1] - a[1])[0][0];
}