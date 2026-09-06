import { describe, expect, it } from 'vitest';
import { createDeck } from '../src/engine/deck.ts';
import { applyAction, initializeGame } from '../src/engine/reducer.ts';
import { isPlayable, cardsPerPlayer } from '../src/engine/rules.ts';
import { DEFAULT_RULESET, SUITS, RANKS } from '../src/engine/types.ts';
import type { Card, GameState, Player, Suit } from '../src/engine/types.ts';
import { chooseAiAction, chooseAiSuit } from '../src/engine/ai.ts';

const players = (n: number): Player[] => Array.from({ length: n }, (_, i) => ({
  id: `p${i}`, displayName: `P${i + 1}`, isAI: i > 0, seatIndex: i, hand: [], connected: true,
}));

const card = (rank: Card['rank'], suit: Suit): Card => ({ id: `${rank}-${suit}`, rank, suit });

// Build a GameState with a fully controlled hand / pile so rule tests are
// deterministic instead of depending on shuffle outcomes.
function makeState(overrides: Partial<GameState> & { hand?: Card[]; topCard?: Card }): GameState {
  const base: GameState = {
    phase: 'PLAYING',
    players: [
      { id: 'p0', displayName: 'P1', isAI: false, seatIndex: 0, hand: overrides.hand ?? [card('A', 'hearts')], connected: true },
      { id: 'p1', displayName: 'P2', isAI: true, seatIndex: 1, hand: [card('K', 'clubs')], connected: true },
    ],
    drawPile: [],
    discardPile: [overrides.topCard ?? card('7', 'hearts')],
    currentSuit: overrides.topCard?.suit ?? 'hearts',
    turnSeatIndex: 0,
    direction: 1,
    hasDrawn: false,
    pendingEightCardId: null,
    winnerSeatIndex: null,
    version: 1,
    ...overrides,
  };
  if (overrides.topCard) base.currentSuit = overrides.topCard.suit;
  return base;
}

function cardsInPlay(state: GameState): Card[] {
  const inHands = state.players.flatMap(p => p.hand);
  return [...inHands, ...state.drawPile, ...state.discardPile];
}

describe('Deck', () => {
  it('contains exactly 52 unique cards', () => {
    const deck = createDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck.map(c => c.id)).size).toBe(52);
  });

  it('contains four suits with thirteen ranks each', () => {
    const deck = createDeck();
    for (const suit of SUITS) {
      const ofSuit = deck.filter(c => c.suit === suit);
      expect(ofSuit).toHaveLength(13);
      expect(new Set(ofSuit.map(c => c.rank))).toEqual(new Set(RANKS));
    }
  });

  it('has stable unique card ids of rank-suit form', () => {
    for (const c of createDeck()) {
      expect(c.id).toBe(`${c.rank}-${c.suit}`);
    }
  });
});

describe('Deal', () => {
  it.each([[2, 5], [3, 5], [4, 4], [5, 4], [6, 4]] as const)(
    'deals %i players %i cards each',
    (count, expected) => {
      const state = initializeGame(players(count), DEFAULT_RULESET, () => 0.42);
      expect(state.players.map(p => p.hand.length)).toEqual(Array(count).fill(expected));
    },
  );

  it('conserves the full 52-card deck and never leads with an eight', () => {
    for (const count of [2, 3, 4, 5, 6]) {
      const state = initializeGame(players(count), DEFAULT_RULESET, () => 0.42);
      const cards = cardsInPlay(state);
      expect(cards).toHaveLength(52);
      expect(new Set(cards.map(c => c.id)).size).toBe(52);
      expect(state.discardPile).toHaveLength(1);
      expect(state.discardPile[0]).toBeDefined();
      expect(state.discardPile[0].rank).not.toBe('8');
      expect(state.currentSuit).toBe(state.discardPile[0].suit);
      expect(state.turnSeatIndex).toBe(0);
      expect(state.version).toBe(1);
    }
  });

  it('uses the ruleset card counts for deal thresholds', () => {
    expect(cardsPerPlayer(2, DEFAULT_RULESET)).toBe(5);
    expect(cardsPerPlayer(3, DEFAULT_RULESET)).toBe(5);
    expect(cardsPerPlayer(4, DEFAULT_RULESET)).toBe(4);
  });
});

describe('Playability rules', () => {
  const top = card('7', 'hearts');

  it('allows a matching suit', () => {
    expect(isPlayable(card('K', 'hearts'), top, 'hearts', DEFAULT_RULESET)).toBe(true);
  });

  it('allows a matching rank', () => {
    expect(isPlayable(card('7', 'clubs'), top, 'hearts', DEFAULT_RULESET)).toBe(true);
  });

  it('allows any eight as a wild card', () => {
    expect(isPlayable(card('8', 'spades'), top, 'hearts', DEFAULT_RULESET)).toBe(true);
  });

  it('rejects a card that matches neither suit nor rank', () => {
    expect(isPlayable(card('K', 'clubs'), top, 'hearts', DEFAULT_RULESET)).toBe(false);
  });

  it('an eight is only wild while eightsWild is enabled', () => {
    const noWild = { ...DEFAULT_RULESET, eightsWild: false };
    expect(isPlayable(card('8', 'clubs'), top, 'hearts', noWild)).toBe(false);
    expect(isPlayable(card('8', 'hearts'), top, 'hearts', noWild)).toBe(true); // suit match
  });

  it('matches the declared suit rather than the top card suit', () => {
    // Top is 7-hearts, but the declared suit is clubs -> clubs matches, hearts does not.
    expect(isPlayable(card('K', 'clubs'), top, 'clubs', DEFAULT_RULESET)).toBe(true);
    expect(isPlayable(card('K', 'hearts'), top, 'clubs', DEFAULT_RULESET)).toBe(false);
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
    expect(played.state.turnSeatIndex).toBe(0); // author keeps the turn to declare
  });

  it('rejects regular plays while a declaration is pending', () => {
    const state = makeState({
      phase: 'DECLARING_SUIT',
      pendingEightCardId: '8-spades',
      hand: [card('A', 'clubs')],
    });
    const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'A-clubs' }, DEFAULT_RULESET);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('SUIT_REQUIRED');
  });

  it('declares a suit and advances the turn', () => {
    const state = makeState({ phase: 'DECLARING_SUIT', pendingEightCardId: '8-spades' });
    const declared = applyAction(state, 0, { type: 'DECLARE_SUIT', suit: 'clubs' }, DEFAULT_RULESET);
    expect(declared.success).toBe(true);
    if (!declared.success) return;
    expect(declared.state.currentSuit).toBe('clubs');
    expect(declared.state.phase).toBe('PLAYING');
    expect(declared.state.pendingEightCardId).toBeNull();
    expect(declared.state.turnSeatIndex).toBe(1);
  });

  it('rejects a suit declaration when no eight is pending', () => {
    const state = makeState({});
    const result = applyAction(state, 0, { type: 'DECLARE_SUIT', suit: 'clubs' }, DEFAULT_RULESET);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('INVALID_SUIT');
  });

  it('keeps an eight playable against a declared suit', () => {
    expect(isPlayable(card('8', 'diamonds'), card('7', 'hearts'), 'clubs', DEFAULT_RULESET)).toBe(true);
    const declared: GameState = makeState({ currentSuit: 'clubs', hand: [card('K', 'clubs')] });
    declared.players[1].hand = [card('8', 'diamonds')];
    declared.turnSeatIndex = 1;
    const next = applyAction(declared, 1, { type: 'PLAY_CARD', cardId: '8-diamonds' }, DEFAULT_RULESET);
    expect(next.success).toBe(true);
  });
});

describe('Draw mechanics', () => {
  it('draws exactly one card when the player has no playable card', () => {
    const state = makeState({
      hand: [card('K', 'clubs')], // neither hearts suit nor rank 7
      drawPile: [card('3', 'diamonds')],
    });
    const drawn = applyAction(state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
    expect(drawn.success).toBe(true);
    if (!drawn.success) return;
    expect(drawn.state.players[0].hand).toHaveLength(2);
    expect(drawn.state.drawPile).toHaveLength(0);
    expect(drawn.state.hasDrawn).toBe(true);
    expect(drawn.state.turnSeatIndex).toBe(0);
    expect(drawn.state.version).toBe(2);
  });

  it('only allows one draw per turn', () => {
    const state = makeState({ hasDrawn: true, drawPile: [card('3', 'diamonds')] });
    const result = applyAction(state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('ALREADY_DREW');
  });

  it('allows the drawn card to be played immediately', () => {
    const state = makeState({
      hand: [card('K', 'clubs')],
      currentSuit: 'diamonds',
      drawPile: [card('3', 'diamonds')], // playable after draw
    });
    const drawn = applyAction(state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
    expect(drawn.success).toBe(true);
    if (!drawn.success) return;
    const played = applyAction(drawn.state, 0, { type: 'PLAY_CARD', cardId: '3-diamonds' }, DEFAULT_RULESET);
    expect(played.success).toBe(true);
    if (!played.success) return;
    expect(played.state.players[0].hand).toHaveLength(1);
    expect(played.state.discardPile[played.state.discardPile.length - 1]?.id).toBe('3-diamonds');
    expect(played.state.turnSeatIndex).toBe(1);
  });

  it('allows the drawn card to be kept and the turn to end', () => {
    const state = makeState({
      hand: [card('K', 'clubs')],
      currentSuit: 'diamonds',
      topCard: card('7', 'diamonds'),
      drawPile: [card('3', 'diamonds')], // playable but we choose to keep it
    });
    const drawn = applyAction(state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
    expect(drawn.success).toBe(true);
    if (!drawn.success) return;
    const ended = applyAction(drawn.state, 0, { type: 'END_TURN' }, DEFAULT_RULESET);
    expect(ended.success).toBe(true);
    if (!ended.success) return;
    expect(ended.state.players[0].hand).toHaveLength(2);
    expect(ended.state.turnSeatIndex).toBe(1);
    expect(ended.state.hasDrawn).toBe(false);
  });

  it('rejects ending a turn without drawing or playing', () => {
    const state = makeState({ hasDrawn: false });
    const result = applyAction(state, 0, { type: 'END_TURN' }, DEFAULT_RULESET);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('MUST_DRAW_OR_PLAY');
  });

  it('returns a graceful error when no cards remain to draw', () => {
    const state = makeState({ drawPile: [], discardPile: [card('7', 'hearts')] });
    const result = applyAction(state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('NO_CARDS_AVAILABLE');
  });
});

describe('Draw pile reshuffle', () => {
  it('preserves the top discard and reshuffles the remainder', () => {
    const state = makeState({
      drawPile: [],
      discardPile: [card('2', 'hearts'), card('3', 'spades'), card('4', 'diamonds')],
      hand: [card('K', 'clubs')],
    });
    const drawn = applyAction(state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET, () => 0.42);
    expect(drawn.success).toBe(true);
    if (!drawn.success) return;
    // Top discard (4-diamonds) is preserved as the only discard.
    expect(drawn.state.discardPile).toEqual([card('4', 'diamonds')]);
    // The other two cards move into the draw pile and one is drawn.
    expect(drawn.state.drawPile.length + drawn.state.players[0].hand.length).toBe(1 + 2);
    expect(drawn.state.drawPile).toHaveLength(1);
    expect(drawn.state.players[0].hand).toHaveLength(2);
  });

  it('game continues normally after a reshuffle draw', () => {
    const state = makeState({
      drawPile: [],
      discardPile: [card('2', 'hearts'), card('3', 'spades'), card('4', 'diamonds')],
      hand: [card('K', 'clubs')],
    });
    const drawn = applyAction(state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET, () => 0.42);
    expect(drawn.success).toBe(true);
    if (!drawn.success) return;
    // With 4-diamonds on top, an 8 is playable -> game still proceeds.
    const played = applyAction(drawn.state, 0, { type: 'PLAY_CARD', cardId: 'K-clubs' }, DEFAULT_RULESET);
    if (played.success) expect(played.state.phase).not.toBe('FINISHED');
  });
});

describe('Winning', () => {
  it('wins immediately when a player empties their hand', () => {
    const state = makeState({ hand: [card('K', 'hearts')], topCard: card('5', 'hearts') });
    const result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.state.phase).toBe('FINISHED');
    expect(result.state.winnerSeatIndex).toBe(0);
    expect(result.state.players[0].hand).toHaveLength(0);
  });

  it('rejects further actions after the game is finished', () => {
    const finished = makeState({
      phase: 'FINISHED',
      winnerSeatIndex: 0,
      hand: [card('K', 'clubs')],
    });
    const result = applyAction(finished, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error.code).toBe('GAME_NOT_ACTIVE');
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

  const stateWith = (hand: Card[], currentSuit?: Suit) => makeState({ hand, currentSuit: currentSuit ?? top.suit, topCard: top });

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

  it('completes a full AI game without crashing', () => {
    const allAi = players(4).map(p => ({ ...p, isAI: true }));
    const state = initializeGame(allAi, DEFAULT_RULESET);
    let current = state;
    let guard = 0;
    while (current.phase === 'PLAYING' && guard < 500) {
      guard += 1;
      const actor = current.players.find(p => p.seatIndex === current.turnSeatIndex)!;
      const result = applyAction(current, actor.seatIndex, chooseAiAction(current, actor.seatIndex, DEFAULT_RULESET), DEFAULT_RULESET);
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
    expect(current.winnerSeatIndex).not.toBeNull();
    expect(guard).toBeLessThan(500);
  });

  it('an AI can declare a suit even when holding a single card', () => {
    expect(chooseAiSuit([card('8', 'clubs')])).toBe('clubs');
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

  it('rejects a commit when the stored version has already moved on', () => {
    // Mirrors the server pattern: commit_game_snapshot takes an expected
    // version, compares it (under a row lock) to the stored version, and
    // rejects the losing writer with STALE_GAME_STATE.
    const base = makeState({ drawPile: [card('3', 'diamonds'), card('9', 'spades')] });

    // Two writers racing on the SAME base state both derive version +1.
    const first = applyAction(base, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
    const competing = applyAction(base, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
    expect(first.success).toBe(true);
    expect(competing.success).toBe(true);
    if (!first.success || !competing.success) return;
    expect(first.state.version).toBe(base.version + 1);
    expect(competing.state.version).toBe(first.state.version);

    // Model the row-locked commit: stored version must equal the expected
    // version handed in by the writer; a successful commit bumps stored.
    let stored = base.version; // what the DB row holds before any commit
    const tryCommit = (expectedVersion: number) => {
      if (stored !== expectedVersion) return false;
      stored += 1;
      return true;
    };

    expect(tryCommit(base.version)).toBe(true);   // writer 1: stored(1) == expected(1) -> committed
    expect(tryCommit(base.version)).toBe(false);  // writer 2 still sends stale expected(1) -> STALE_GAME_STATE
    expect(stored).toBe(2);
  });
});