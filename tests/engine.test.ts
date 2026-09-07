import { describe, expect, it } from 'vitest';
import { createDeck } from '../src/engine/deck.ts';
import { applyAction, initializeGame } from '../src/engine/reducer.ts';
import { canRespondToPickup, isPlayable, isStarterRank, isWinningRank, cardsPerPlayer } from '../src/engine/rules.ts';
import { DEFAULT_RULESET, SUITS, RANKS } from '../src/engine/types.ts';
import type { Card, GameState, Player, DeclareSuit } from '../src/engine/types.ts';
import { chooseAiAction, chooseAiSuit } from '../src/engine/ai.ts';

const players = (n: number): Player[] => Array.from({ length: n }, (_, i) => ({
  id: `p${i}`, displayName: `P${i + 1}`, isAI: i > 0, seatIndex: i, hand: [], connected: true,
}));

const card = (rank: Card['rank'], suit: Card['suit']): Card => ({ id: `${rank}-${suit}`, rank, suit });
const joker = () => card('JOKER', 'jokers');

type StateOpts = Partial<GameState> & { hand?: Card[]; opponentHands?: Card[][]; topCard?: Card };

// Build a GameState with a fully controlled hand / pile so rule tests are
// deterministic instead of depending on shuffle outcomes.
function makeState(overrides: StateOpts): GameState {
  const { hand, opponentHands, ...rest } = overrides;
  const seats = Math.max(2, 1 + (opponentHands?.length ?? 1));
  const playersRow = Array.from({ length: seats }, (_, i) => ({
    id: `p${i}`,
    displayName: `P${i + 1}`,
    isAI: i > 0,
    seatIndex: i,
    hand: i === 0 ? (hand ?? []) : (opponentHands?.[i - 1] ?? []),
    connected: true,
  }));
  const top = rest.topCard ?? card('7', 'hearts');
  return {
    phase: rest.phase ?? 'PLAYING',
    players: playersRow,
    drawPile: rest.drawPile ?? [],
    discardPile: rest.discardPile ?? [top],
    currentSuit: rest.currentSuit ?? (top.suit as DeclareSuit),
    turnSeatIndex: rest.turnSeatIndex ?? 0,
    direction: rest.direction ?? 1,
    hasDrawn: rest.hasDrawn ?? false,
    carryOn: rest.carryOn ?? false,
    pendingPickup: rest.pendingPickup ?? 0,
    pendingEightCardId: rest.pendingEightCardId ?? null,
    winnerSeatIndex: rest.winnerSeatIndex ?? null,
    version: rest.version ?? 1,
  };
}

const fixed = () => 0.42;

function cardsInPlay(state: GameState): Card[] {
  const inHands = state.players.flatMap(p => p.hand);
  return [...inHands, ...state.drawPile, ...state.discardPile];
}

describe('Deck', () => {
  it('contains 54 cards: 52 standard plus two Jokers', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(54);
    const jokers = deck.filter(c => c.rank === 'JOKER');
    expect(jokers).toHaveLength(2);
    expect(jokers.map(c => c.suit)).toEqual(['jokers', 'jokers']);
  });

  it('has 54 unique ids', () => {
    const deck = createDeck();
    expect(new Set(deck.map(c => c.id)).size).toBe(54);
    expect(new Set(deck.map(c => c.id)).has('JOKER-A')).toBe(true);
    expect(new Set(deck.map(c => c.id)).has('JOKER-B')).toBe(true);
  });

  it('contains four suits with thirteen ranks each plus two jokers', () => {
    const deck = createDeck();
    for (const suit of SUITS) {
      const ofSuit = deck.filter(c => c.suit === suit);
      expect(ofSuit).toHaveLength(13);
      expect(new Set(ofSuit.map(c => c.rank))).toEqual(new Set(RANKS.filter(r => r !== 'JOKER')));
    }
  });
});

describe('Deal', () => {
  it.each([[2, 5], [3, 5], [4, 4], [5, 4], [6, 4]] as const)(
    'deals %i players %i cards each',
    (count, expected) => {
      const state = initializeGame(players(count), DEFAULT_RULESET, fixed);
      expect(state.players.map(p => p.hand.length)).toEqual(Array(count).fill(expected));
    },
  );

  it('conserves the full 54-card deck across every player count', () => {
    for (const count of [2, 3, 4, 5, 6]) {
      const state = initializeGame(players(count), DEFAULT_RULESET, fixed);
      const cards = cardsInPlay(state);
      expect(cards).toHaveLength(54);
      expect(new Set(cards.map(c => c.id)).size).toBe(54);
      expect(state.discardPile).toHaveLength(1);
    }
  });

  it('opens with a restricted starter card (3,4,5,6,9,10,Q) by default', () => {
    for (let i = 0; i < 40; i += 1) {
      const state = initializeGame(players(2), DEFAULT_RULESET, Math.random);
      expect(isStarterRank(state.discardPile[0].rank)).toBe(true);
      expect(state.currentSuit).toBe(state.discardPile[0].suit);
      expect(state.turnSeatIndex).toBe(0);
    }
  });

  it('allows any opening discard when restrictedFirstCards is disabled', () => {
    const loose = { ...DEFAULT_RULESET, restrictedFirstCards: false };
    const state = initializeGame(players(2), loose, fixed);
    expect(state.discardPile[0]).toBeDefined();
  });

  it('initializes the new state fields to defaults', () => {
    const state = initializeGame(players(2), DEFAULT_RULESET, fixed);
    expect(state.pendingPickup).toBe(0);
    expect(state.carryOn).toBe(false);
  });
});

describe('Starter / winning ranks', () => {
  it('only 3,4,5,6,9,10,Q may start or finish', () => {
    for (const r of ['3', '4', '5', '6', '9', '10', 'Q']) {
      expect(isStarterRank(r)).toBe(true);
      expect(isWinningRank(r)).toBe(true);
    }
    for (const r of ['A', '2', '7', '8', 'J', 'K', 'JOKER']) {
      expect(isStarterRank(r)).toBe(false);
      expect(isWinningRank(r)).toBe(false);
    }
  });
});

describe('Playability rules', () => {
  const top = card('7', 'hearts');

  it('jokers are always playable and ignore suit', () => {
    expect(isPlayable(joker(), top, 'clubs', DEFAULT_RULESET)).toBe(true);
    expect(isPlayable(joker(), top, 'diamonds', DEFAULT_RULESET)).toBe(true);
  });

  it('allows a matching suit or rank and an eight', () => {
    expect(isPlayable(card('K', 'hearts'), top, 'hearts', DEFAULT_RULESET)).toBe(true);
    expect(isPlayable(card('7', 'clubs'), top, 'hearts', DEFAULT_RULESET)).toBe(true);
    expect(isPlayable(card('8', 'spades'), top, 'hearts', DEFAULT_RULESET)).toBe(true);
  });

  it('rejects a card that matches neither suit nor rank', () => {
    expect(isPlayable(card('K', 'clubs'), top, 'hearts', DEFAULT_RULESET)).toBe(false);
  });

  it('during a pickup only Ace, 2, or Joker are playable', () => {
    expect(isPlayable(card('A', 'spades'), top, 'hearts', DEFAULT_RULESET, { pendingPickup: 5 })).toBe(true);
    expect(isPlayable(card('2', 'spades'), top, 'hearts', DEFAULT_RULESET, { pendingPickup: 5 })).toBe(true);
    expect(isPlayable(joker(), top, 'hearts', DEFAULT_RULESET, { pendingPickup: 5 })).toBe(true);
    // Pickup responses ignore suit and rank entirely.
    expect(isPlayable(card('A', 'spades'), top, 'diamonds', DEFAULT_RULESET, { pendingPickup: 3 })).toBe(true);
    expect(isPlayable(card('2', 'spades'), top, 'diamonds', DEFAULT_RULESET, { pendingPickup: 3 })).toBe(true);
  });

  it('a King does NOT bypass an active pickup and an eight is not a response', () => {
    expect(isPlayable(card('K', 'hearts'), top, 'hearts', DEFAULT_RULESET, { pendingPickup: 5 })).toBe(false);
    expect(isPlayable(card('8', 'spades'), top, 'hearts', DEFAULT_RULESET, { pendingPickup: 5 })).toBe(false);
  });

  it('canRespondToPickup reflects the ruleset', () => {
    expect(canRespondToPickup(card('A', 'hearts'), DEFAULT_RULESET)).toBe(true);
    expect(canRespondToPickup(card('2', 'hearts'), DEFAULT_RULESET)).toBe(true);
    expect(canRespondToPickup(joker(), DEFAULT_RULESET)).toBe(true);
    expect(canRespondToPickup(card('K', 'hearts'), DEFAULT_RULESET)).toBe(false);
    const noAce = { ...DEFAULT_RULESET, aceBlocksPickup: false };
    expect(canRespondToPickup(card('A', 'hearts'), noAce)).toBe(false);
  });
});

describe('Pickup rules', () => {
  it('a Joker adds +5 and leaves the penalty pending when the victim can respond', () => {
    const state = makeState({
      hand: [joker(), card('9', 'diamonds')],
      opponentHands: [[card('A', 'clubs')]],
      topCard: card('5', 'hearts'),
    });
    const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'JOKER-jokers' }, DEFAULT_RULESET);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.state.pendingPickup).toBe(5);
    expect(result.state.turnSeatIndex).toBe(1);
    expect(result.state.currentSuit).toBe('hearts'); // Joker preserves the active suit
    expect(result.state.carryOn).toBe(false);
    expect(result.events.some(e => e.type === 'PICKUP_ADDED')).toBe(true);
  });

  it('auto-picks-up at turn advancement when the victim has no response', () => {
    const state = makeState({
      hand: [joker(), card('5', 'clubs')],
      opponentHands: [[]],
      topCard: card('5', 'hearts'),
      drawPile: [card('3', 'clubs'), card('4', 'diamonds'), card('5', 'spades'), card('6', 'hearts'), card('9', 'clubs')],
    });
    const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'JOKER-jokers' }, DEFAULT_RULESET, fixed);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.state.players[1].hand).toHaveLength(5);
    expect(result.state.pendingPickup).toBe(0);
    expect(result.state.turnSeatIndex).toBe(0);
    expect(result.events.some(e => e.type === 'PICKUP_RESOLVED')).toBe(true);
  });

  it('a 2 adds +2 and stacks on an existing Joker (+7)', () => {
    // Seat 0 keeps an Ace so the stacked penalty stays pending and observable.
    const state = makeState({
      hand: [joker(), card('9', 'diamonds'), card('A', 'clubs')],
      opponentHands: [[card('2', 'clubs')]],
      topCard: card('5', 'hearts'),
    });
    const jokered = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'JOKER-jokers' }, DEFAULT_RULESET);
    expect(jokered.success).toBe(true);
    if (!jokered.success) return;
    expect(jokered.state.pendingPickup).toBe(5);
    expect(jokered.state.turnSeatIndex).toBe(1);
    const added = applyAction(jokered.state, 1, { type: 'PLAY_CARD', cardId: '2-clubs' }, DEFAULT_RULESET);
    expect(added.success).toBe(true);
    if (!added.success) return;
    expect(added.events.some(e => e.type === 'PICKUP_ADDED' && e.payload?.total === 7)).toBe(true);
    expect(added.state.pendingPickup).toBe(7);
    expect(added.state.turnSeatIndex).toBe(0);
  });

  it('an Ace block clears the entire accumulated pickup and grants an extra play', () => {
    const state = makeState({
      hand: [joker(), card('9', 'diamonds')],
      opponentHands: [[card('A', 'clubs')]],
      topCard: card('5', 'hearts'),
    });
    const jokered = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'JOKER-jokers' }, DEFAULT_RULESET);
    if (!jokered.success) throw new Error('joker failed');
    const blocked = applyAction(jokered.state, 1, { type: 'PLAY_CARD', cardId: 'A-clubs' }, DEFAULT_RULESET);
    expect(blocked.success).toBe(true);
    if (!blocked.success) return;
    expect(blocked.state.pendingPickup).toBe(0);
    expect(blocked.state.carryOn).toBe(true);
    expect(blocked.state.turnSeatIndex).toBe(1);
    expect(blocked.events.some(e => e.type === 'PICKUP_BLOCKED')).toBe(true);
  });

  it('RESOLVE_PICKUP draws the accumulated penalty and passes the turn', () => {
    const state = makeState({
      pendingPickup: 5,
      hand: [],
      drawPile: [card('3', 'clubs'), card('4', 'diamonds'), card('5', 'spades'), card('6', 'hearts'), card('9', 'clubs')],
    });
    const result = applyAction(state, 0, { type: 'RESOLVE_PICKUP' }, DEFAULT_RULESET, fixed);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.state.players[0].hand).toHaveLength(5);
    expect(result.state.pendingPickup).toBe(0);
    expect(result.state.turnSeatIndex).toBe(1);
  });

  it('resolves with as many cards as are available instead of crashing', () => {
    const state = makeState({
      pendingPickup: 10,
      hand: [],
      drawPile: [card('3', 'clubs'), card('4', 'diamonds'), card('5', 'spades')],
    });
    const result = applyAction(state, 0, { type: 'RESOLVE_PICKUP' }, DEFAULT_RULESET, fixed);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.state.players[0].hand).toHaveLength(3);
    expect(result.state.pendingPickup).toBe(0);
  });

  it('rejects drawing, ending the turn, and declaring during a pickup', () => {
    const state = makeState({ pendingPickup: 5, hand: [card('9', 'diamonds')] });
    const draw = applyAction(state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
    expect(draw.success).toBe(false);
    if (draw.success) return;
    expect(draw.error.code).toBe('PICKUP_PENDING');
    const end = applyAction(state, 0, { type: 'END_TURN' }, DEFAULT_RULESET);
    expect(end.success).toBe(false);
    if (end.success) return;
    expect(end.error.code).toBe('PICKUP_PENDING');
  });

  it('a King cannot be played to bypass a pickup', () => {
    const state = makeState({ pendingPickup: 5, hand: [card('K', 'hearts')] });
    const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('INVALID_PLAY');
  });
});

describe('Seven and Jack', () => {
  it('a 7 skips the next player (three players)', () => {
    const state = makeState({
      hand: [card('7', 'hearts'), card('5', 'clubs')],
      opponentHands: [[card('9', 'clubs')], [card('9', 'diamonds')]],
      topCard: card('J', 'hearts'),
    });
    const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: '7-hearts' }, DEFAULT_RULESET);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.state.turnSeatIndex).toBe(2);
    expect(result.state.direction).toBe(1);
    expect(result.events.some(e => e.type === 'SKIPPED')).toBe(true);
  });

  it('a Jack reverses the direction by default', () => {
    const state = makeState({
      hand: [card('J', 'hearts'), card('5', 'clubs')],
      opponentHands: [[card('9', 'clubs')], [card('9', 'diamonds')]],
      topCard: card('J', 'clubs'),
    });
    const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'J-hearts' }, DEFAULT_RULESET);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.state.direction).toBe(-1);
    expect(result.state.turnSeatIndex).toBe(2);
    expect(result.events.some(e => e.type === 'REVERSED')).toBe(true);
  });

  it('the swap toggle flips sevenAction and jackAction', () => {
    const swapped = { ...DEFAULT_RULESET, sevenAction: 'reverse' as const, jackAction: 'skip' as const };
    const seven = makeState({
      hand: [card('7', 'hearts'), card('5', 'clubs')],
      opponentHands: [[card('9', 'clubs')], [card('9', 'diamonds')]],
    });
    const sevenResult = applyAction(seven, 0, { type: 'PLAY_CARD', cardId: '7-hearts' }, swapped);
    expect(sevenResult.success).toBe(true);
    if (!sevenResult.success) return;
    expect(sevenResult.state.direction).toBe(-1);

    const jack = makeState({
      hand: [card('J', 'hearts'), card('5', 'clubs')],
      opponentHands: [[card('9', 'clubs')], [card('9', 'diamonds')]],
      topCard: card('K', 'hearts'),
    });
    const jackResult = applyAction(jack, 0, { type: 'PLAY_CARD', cardId: 'J-hearts' }, swapped);
    expect(jackResult.success).toBe(true);
    if (!jackResult.success) return;
    expect(jackResult.state.turnSeatIndex).toBe(2);
    expect(jackResult.state.direction).toBe(1);
  });
});

describe('King — authoritative single-extra-play rule', () => {
  // Kings are made playable via rank matching (top card is a King) so a player
  // holding several Kings can legally play them in sequence.
  const kingTop = (suit: DeclareSuit = 'spades') => card('K', suit);

  it('1. a King gives exactly one additional play opportunity', () => {
    const state = makeState({ hand: [card('K', 'hearts'), card('5', 'clubs')], topCard: kingTop() });
    const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.state.turnSeatIndex).toBe(0);
    expect(result.state.carryOn).toBe(true);
    expect(result.state.hasDrawn).toBe(false);
    expect(result.events.some(e => e.type === 'CARRY_ON')).toBe(true);
  });

  it('2. K followed by a normal card ends the player turn', () => {
    const state = makeState({ hand: [card('K', 'hearts'), card('9', 'hearts'), card('5', 'clubs')], topCard: kingTop() });
    const k = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET);
    if (!k.success) throw new Error('king failed');
    expect(k.state.turnSeatIndex).toBe(0);
    const next = applyAction(k.state, 0, { type: 'PLAY_CARD', cardId: '9-hearts' }, DEFAULT_RULESET);
    expect(next.success).toBe(true);
    if (!next.success) return;
    expect(next.state.turnSeatIndex).toBe(1);
    expect(next.state.carryOn).toBe(false);
  });

  it('3. K followed by another K grants another extra play', () => {
    const state = makeState({
      hand: [card('K', 'hearts'), card('K', 'diamonds')],
      topCard: kingTop(),
    });
    const first = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET);
    if (!first.success) throw new Error('first king failed');
    const second = applyAction(first.state, 0, { type: 'PLAY_CARD', cardId: 'K-diamonds' }, DEFAULT_RULESET);
    expect(second.success).toBe(true);
    if (!second.success) return;
    expect(second.state.turnSeatIndex).toBe(0);
    expect(second.state.carryOn).toBe(true);
  });

  it('4. K chains work: K → K → K → normal then the turn passes', () => {
    // Top K-spades; each subsequent King matches by rank, then 3-clubs matches the last King's suit.
    const state = makeState({
      hand: [card('K', 'hearts'), card('K', 'diamonds'), card('K', 'clubs'), card('3', 'clubs'), card('5', 'spades')],
      topCard: kingTop(),
    });
    let current = state;
    for (const id of ['K-hearts', 'K-diamonds', 'K-clubs']) {
      const result = applyAction(current, 0, { type: 'PLAY_CARD', cardId: id }, DEFAULT_RULESET);
      expect(result.success).toBe(true);
      if (!result.success) return;
      current = result.state;
      expect(current.turnSeatIndex).toBe(0);
      expect(current.carryOn).toBe(true);
    }
    const final = applyAction(current, 0, { type: 'PLAY_CARD', cardId: '3-clubs' }, DEFAULT_RULESET);
    expect(final.success).toBe(true);
    if (!final.success) return;
    expect(final.state.carryOn).toBe(false);
    expect(final.state.turnSeatIndex).toBe(1);
  });

  it('5. a King grants no more than one extra play — no indefinite loop', () => {
    // Play K, then K, then normal: two Kings gave two extra-play grants and the
    // chain terminates when a non-King is played.
    const state = makeState({
      hand: [card('K', 'hearts'), card('K', 'diamonds'), card('3', 'diamonds'), card('5', 'clubs')],
      topCard: kingTop(),
    });
    const k1 = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET);
    if (!k1.success) throw new Error('k1 failed');
    const k2 = applyAction(k1.state, 0, { type: 'PLAY_CARD', cardId: 'K-diamonds' }, DEFAULT_RULESET);
    if (!k2.success) throw new Error('k2 failed');
    expect(k2.state.carryOn).toBe(true);
    const normal = applyAction(k2.state, 0, { type: 'PLAY_CARD', cardId: '3-diamonds' }, DEFAULT_RULESET);
    if (!normal.success) throw new Error('normal failed');
    expect(normal.state.carryOn).toBe(false);
    expect(normal.state.turnSeatIndex).toBe(1);
    // And you cannot simply end the turn after a King without using it.
    const earlyEnd = applyAction(k1.state, 0, { type: 'END_TURN' }, DEFAULT_RULESET);
    expect(earlyEnd.success).toBe(false);
    if (earlyEnd.success) return;
    expect(earlyEnd.error.code).toBe('MUST_DRAW_OR_PLAY');
  });

  it('6. a King does not bypass an active pickup', () => {
    const state = makeState({ hand: [card('K', 'hearts')], pendingPickup: 5 });
    const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('INVALID_PLAY');
  });

  it('7. K followed by 8 still requires a suit declaration', () => {
    const state = makeState({
      hand: [card('K', 'hearts'), card('8', 'diamonds'), card('5', 'clubs')],
      topCard: kingTop(),
    });
    const k = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET);
    if (!k.success) throw new Error('king failed');
    const eight = applyAction(k.state, 0, { type: 'PLAY_CARD', cardId: '8-diamonds' }, DEFAULT_RULESET);
    expect(eight.success).toBe(true);
    if (!eight.success) return;
    expect(eight.state.phase).toBe('DECLARING_SUIT');
    expect(eight.state.pendingEightCardId).toBe('8-diamonds');
    expect(eight.state.turnSeatIndex).toBe(0);
    expect(eight.state.carryOn).toBe(false);
    const declared = applyAction(eight.state, 0, { type: 'DECLARE_SUIT', suit: 'clubs' }, DEFAULT_RULESET);
    expect(declared.success).toBe(true);
    if (!declared.success) return;
    expect(declared.state.turnSeatIndex).toBe(1);
  });

  it('8. K followed by 7 applies the skip', () => {
    const state = makeState({
      hand: [card('K', 'hearts'), card('7', 'hearts')],
      opponentHands: [[card('9', 'clubs')], [card('9', 'diamonds')]],
      topCard: kingTop(),
    });
    const k = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET);
    if (!k.success) throw new Error('king failed');
    const seven = applyAction(k.state, 0, { type: 'PLAY_CARD', cardId: '7-hearts' }, DEFAULT_RULESET);
    expect(seven.success).toBe(true);
    if (!seven.success) return;
    expect(seven.state.turnSeatIndex).toBe(2);
    expect(seven.events.some(e => e.type === 'SKIPPED')).toBe(true);
  });

  it('9. K followed by 2 or Joker applies the pickup rules', () => {
    const state = makeState({
      hand: [card('K', 'hearts'), card('2', 'hearts'), card('5', 'clubs')],
      opponentHands: [[]],
      topCard: card('9', 'hearts'),
      drawPile: [card('3', 'clubs'), card('4', 'diamonds')],
    });
    const k = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET);
    if (!k.success) throw new Error('king failed');
    const two = applyAction(k.state, 0, { type: 'PLAY_CARD', cardId: '2-hearts' }, DEFAULT_RULESET);
    expect(two.success).toBe(true);
    if (!two.success) return;
    expect(two.state.carryOn).toBe(false);
    expect(two.state.players[1].hand).toHaveLength(2);
    expect(two.state.pendingPickup).toBe(0);
  });

  it('10. a King cannot be the winning card', () => {
    const state = makeState({
      hand: [card('K', 'hearts')],
      topCard: card('9', 'hearts'),
      drawPile: [card('3', 'clubs')],
    });
    const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.state.phase).not.toBe('FINISHED');
    expect(result.state.winnerSeatIndex).toBeNull();
    expect(result.events.some(e => e.type === 'AUTO_DREW')).toBe(true);
  });

  it('11. K as the final card does not declare a winner and the player obtains another card', () => {
    const state = makeState({
      hand: [card('K', 'hearts')],
      topCard: card('9', 'hearts'),
      drawPile: [card('3', 'clubs')],
    });
    const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET, fixed);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.state.phase).toBe('PLAYING');
    expect(result.state.winnerSeatIndex).toBeNull();
    expect(result.state.players[0].hand).toEqual([card('3', 'clubs')]);
    // The King's extra play remains: the same player acts again.
    expect(result.state.turnSeatIndex).toBe(0);
    expect(result.state.carryOn).toBe(true);
  });

  it('K + no legal card draws one; if unplayable the turn ends (no unlimited draws)', () => {
    const state = makeState({
      hand: [card('K', 'hearts')],
      topCard: card('9', 'hearts'),
      drawPile: [card('3', 'clubs'), card('6', 'diamonds')],
    });
    const k = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET, fixed);
    if (!k.success) throw new Error('king failed');
    // No legal card (3-clubs does not match hearts), so draw the extra one.
    const drawn = applyAction(k.state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET, fixed);
    expect(drawn.success).toBe(true);
    if (!drawn.success) return;
    expect(drawn.state.players[0].hand).toHaveLength(2);
    const ended = applyAction(drawn.state, 0, { type: 'END_TURN' }, DEFAULT_RULESET);
    expect(ended.success).toBe(true);
    if (!ended.success) return;
    expect(ended.state.turnSeatIndex).toBe(1);
    expect(ended.state.carryOn).toBe(false);
  });
});

describe('Eight flow', () => {
  it('requires a declaration after playing an eight', () => {
    const state = makeState({ hand: [card('8', 'spades'), card('A', 'clubs')] });
    const played = applyAction(state, 0, { type: 'PLAY_CARD', cardId: '8-spades' }, DEFAULT_RULESET);
    expect(played.success).toBe(true);
    if (!played.success) return;
    expect(played.state.phase).toBe('DECLARING_SUIT');
    expect(played.state.currentSuit).toBeNull();
    expect(played.state.pendingEightCardId).toBe('8-spades');
  });

  it('declares a suit and advances the turn', () => {
    const state = makeState({ phase: 'DECLARING_SUIT', pendingEightCardId: '8-spades' });
    const declared = applyAction(state, 0, { type: 'DECLARE_SUIT', suit: 'clubs' }, DEFAULT_RULESET);
    expect(declared.success).toBe(true);
    if (!declared.success) return;
    expect(declared.state.currentSuit).toBe('clubs');
    expect(declared.state.phase).toBe('PLAYING');
    expect(declared.state.turnSeatIndex).toBe(1);
  });

  it('an eight cannot be the winning card: it auto-draws and still declares', () => {
    const state = makeState({
      hand: [card('8', 'spades')],
      topCard: card('9', 'hearts'),
      drawPile: [card('3', 'clubs')],
    });
    const played = applyAction(state, 0, { type: 'PLAY_CARD', cardId: '8-spades' }, DEFAULT_RULESET, fixed);
    expect(played.success).toBe(true);
    if (!played.success) return;
    expect(played.state.phase).toBe('DECLARING_SUIT');
    expect(played.state.winnerSeatIndex).toBeNull();
    expect(played.state.players[0].hand).toEqual([card('3', 'clubs')]);
    expect(played.events.some(e => e.type === 'AUTO_DREW')).toBe(true);
  });
});

describe('Winning', () => {
  it('wins immediately with an allowed finisher (3,4,5,6,9,10,Q)', () => {
    for (const rank of ['3', '4', '5', '6', '9', '10', 'Q'] as const) {
      const played = card(rank, 'hearts');
      const state = makeState({ hand: [played], topCard: card('7', 'hearts') });
      const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: played.id }, DEFAULT_RULESET);
      expect(result.success).toBe(true);
      if (!result.success) continue;
      expect(result.state.phase).toBe('FINISHED');
      expect(result.state.winnerSeatIndex).toBe(0);
      expect(result.state.players[0].hand).toHaveLength(0);
    }
  });

  it('a prohibited finisher never produces a winner (Joker case)', () => {
    const state = makeState({
      hand: [joker()],
      topCard: card('9', 'hearts'),
      drawPile: [card('3', 'clubs')],
      opponentHands: [[]],
    });
    const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'JOKER-jokers' }, DEFAULT_RULESET, fixed);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.state.phase).not.toBe('FINISHED');
    expect(result.state.winnerSeatIndex).toBeNull();
    expect(result.state.players[0].hand).toHaveLength(1);
  });

  it('rejects further actions after the game is finished', () => {
    const finished = makeState({ phase: 'FINISHED', winnerSeatIndex: 0, hand: [card('K', 'clubs')] });
    const result = applyAction(finished, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('GAME_NOT_ACTIVE');
  });

  it('a prohibited finisher draws from the recycled discard when the draw pile is empty', () => {
    // Playing K empties the hand while the draw pile is empty; the auto-draw must
    // recycle every discard except the top played card and continue the game.
    const state = makeState({
      hand: [card('K', 'hearts')],
      topCard: card('9', 'hearts'),
      drawPile: [],
      discardPile: [card('4', 'diamonds'), card('9', 'hearts')],
    });
    const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET, fixed);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.state.phase).toBe('PLAYING');
    expect(result.state.winnerSeatIndex).toBeNull();
    expect(result.state.players[0].hand).toHaveLength(1);
    expect(result.state.discardPile).toEqual([card('K', 'hearts')]);
  });
});

describe('Draw pile reshuffle', () => {
  it('preserves the top discard and reshuffles the remainder', () => {
    const state = makeState({
      drawPile: [],
      discardPile: [card('2', 'hearts'), card('3', 'spades'), card('4', 'diamonds')],
      hand: [card('K', 'clubs')],
    });
    const drawn = applyAction(state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET, fixed);
    expect(drawn.success).toBe(true);
    if (!drawn.success) return;
    expect(drawn.state.discardPile).toEqual([card('4', 'diamonds')]);
    expect(drawn.state.drawPile).toHaveLength(1);
    expect(drawn.state.players[0].hand).toHaveLength(2);
  });

  it('a pickup draw also refills from the discard remainder', () => {
    const state = makeState({
      pendingPickup: 5,
      hand: [],
      drawPile: [],
      discardPile: [card('9', 'hearts'), card('3', 'clubs'), card('4', 'diamonds'), card('5', 'spades'), card('6', 'hearts')],
    });
    const result = applyAction(state, 0, { type: 'RESOLVE_PICKUP' }, DEFAULT_RULESET, fixed);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.state.players[0].hand).toHaveLength(4);
    expect(result.state.discardPile).toEqual([card('6', 'hearts')]);
  });
});

describe('Validation', () => {
  it('rejects a play from a player who does not own the card', () => {
    const state = makeState({ hand: [card('K', 'hearts')], topCard: card('5', 'hearts') });
    const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: '9-spades' }, DEFAULT_RULESET);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('CARD_NOT_OWNED');
  });

  it('rejects a play out of turn', () => {
    const state = makeState({ turnSeatIndex: 1, hand: [card('K', 'hearts')] });
    const result = applyAction(state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('NOT_YOUR_TURN');
  });
});

describe('AI', () => {
  const top = card('7', 'hearts');

  it('prefers a suit match over a rank match over a wild eight', () => {
    const state = makeState({
      hand: [card('8', 'spades'), card('7', 'clubs'), card('K', 'hearts')],
      currentSuit: 'hearts',
      topCard: top,
    });
    expect(chooseAiAction(state, 0, DEFAULT_RULESET)).toEqual({ type: 'PLAY_CARD', cardId: 'K-hearts' });

    const noSuitMatch = makeState({
      hand: [card('8', 'spades'), card('7', 'clubs'), card('K', 'diamonds')],
      currentSuit: 'hearts',
      topCard: top,
    });
    expect(chooseAiAction(noSuitMatch, 0, DEFAULT_RULESET)).toEqual({ type: 'PLAY_CARD', cardId: '7-clubs' });

    const noMatch = makeState({
      hand: [card('8', 'spades'), card('K', 'diamonds')],
      currentSuit: 'hearts',
      topCard: top,
    });
    expect(chooseAiAction(noMatch, 0, DEFAULT_RULESET)).toEqual({ type: 'PLAY_CARD', cardId: '8-spades' });
  });

  it('responds to a pickup with priority Ace > Joker > 2', () => {
    const full = makeState({ pendingPickup: 5, hand: [card('2', 'diamonds'), joker(), card('A', 'spades')] });
    expect(chooseAiAction(full, 0, DEFAULT_RULESET)).toEqual({ type: 'PLAY_CARD', cardId: 'A-spades' });

    const noAce = makeState({ pendingPickup: 5, hand: [card('2', 'diamonds'), joker()] });
    expect(chooseAiAction(noAce, 0, DEFAULT_RULESET)).toEqual({ type: 'PLAY_CARD', cardId: 'JOKER-jokers' });

    const onlyTwo = makeState({ pendingPickup: 5, hand: [card('2', 'diamonds'), card('9', 'clubs')] });
    expect(chooseAiAction(onlyTwo, 0, DEFAULT_RULESET)).toEqual({ type: 'PLAY_CARD', cardId: '2-diamonds' });
  });

  it('resolves the pickup when it has no response cards', () => {
    const state = makeState({ pendingPickup: 5, hand: [card('9', 'clubs')] });
    expect(chooseAiAction(state, 0, DEFAULT_RULESET)).toEqual({ type: 'RESOLVE_PICKUP' });
  });

  it('avoids emptying its hand with a prohibited final card by drawing instead', () => {
    const state = makeState({ hand: [card('K', 'hearts')], currentSuit: 'hearts', topCard: top });
    expect(chooseAiAction(state, 0, DEFAULT_RULESET)).toEqual({ type: 'DRAW_CARD' });
  });

  it('plays an allowed finisher from a single-card hand', () => {
    const state = makeState({ hand: [card('9', 'hearts')], currentSuit: 'hearts', topCard: top });
    expect(chooseAiAction(state, 0, DEFAULT_RULESET)).toEqual({ type: 'PLAY_CARD', cardId: '9-hearts' });
  });

  it('draws when nothing is playable, then ends the turn', () => {
    const state = makeState({
      hand: [card('K', 'clubs')],
      currentSuit: 'hearts',
      topCard: top,
      drawPile: [card('3', 'diamonds')],
    });
    expect(chooseAiAction(state, 0, DEFAULT_RULESET)).toEqual({ type: 'DRAW_CARD' });
    const drawn = applyAction(state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
    expect(drawn.success).toBe(true);
    if (!drawn.success) return;
    expect(chooseAiAction(drawn.state, 0, DEFAULT_RULESET)).toEqual({ type: 'END_TURN' });
  });

  it('declares the suit it holds the most of', () => {
    const hand = [card('A', 'spades'), card('3', 'spades'), card('9', 'spades'), card('5', 'hearts')];
    expect(chooseAiSuit(hand)).toBe('spades');
  });

  it('an AI can declare a suit even when holding a single card', () => {
    expect(chooseAiSuit([card('8', 'clubs')])).toBe('clubs');
  });

  it('completes a full AI game without crashing and terminates', () => {
    const allAi = players(4).map(p => ({ ...p, isAI: true }));
    const state = initializeGame(allAi, DEFAULT_RULESET);
    let current = state;
    let guard = 0;
    while (current.phase === 'PLAYING' && guard < 500) {
      guard += 1;
      const actor = current.players.find(p => p.seatIndex === current.turnSeatIndex)!;
      const action = chooseAiAction(current, actor.seatIndex, DEFAULT_RULESET);
      const result = applyAction(current, actor.seatIndex, action, DEFAULT_RULESET);
      expect(result.success).toBe(true);
      if (!result.success) break;
      current = result.state;
      if (current.phase === 'DECLARING_SUIT') {
        const pending = current.players.find(p => p.seatIndex === current.turnSeatIndex)!;
        const declared = applyAction(current, pending.seatIndex, { type: 'DECLARE_SUIT', suit: chooseAiSuit(pending.hand) }, DEFAULT_RULESET);
        expect(declared.success).toBe(true);
        if (!declared.success) break;
        current = declared.state;
      }
    }
    expect(current.phase).toBe('FINISHED');
    expect(guard).toBeLessThan(500);
  });
});

describe('Versioning / optimistic concurrency contract', () => {
  it('increments the version by one on every successful mutation', () => {
    let state = makeState({ drawPile: [card('3', 'diamonds')] });
    state = (applyAction(state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET) as Exclude<ReturnType<typeof applyAction>, { success: false }>).state;
    expect(state.version).toBe(2);
    const played = applyAction(state, 0, { type: 'END_TURN' }, DEFAULT_RULESET);
    expect(played.success).toBe(true);
    if (!played.success) return;
    expect(played.state.version).toBe(3);
  });

  it('a King chain still advances the version one at a time', () => {
    const state = makeState({ hand: [card('K', 'hearts'), card('9', 'hearts'), card('5', 'clubs')], topCard: card('K', 'spades') });
    const first = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET);
    if (!first.success) throw new Error('king failed');
    expect(first.state.version).toBe(2);
    const second = applyAction(first.state, 0, { type: 'PLAY_CARD', cardId: '9-hearts' }, DEFAULT_RULESET);
    if (!second.success) throw new Error('nine failed');
    expect(second.state.version).toBe(3);
    expect(second.state.turnSeatIndex).toBe(1);
  });
});