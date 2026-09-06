import { cardsPerPlayer, canDraw, isPlayable } from './rules.ts';
import { createDeck, shuffle } from './deck.ts';
import { advanceTurn } from './turn.ts';
import type { ActionResult, Card, GameAction, GameEvent, GameState, Player, Ruleset, Suit } from './types.ts';

function cloneState(state: GameState): GameState {
  return structuredClone(state);
}

function error(code: string, message: string): ActionResult {
  return { success: false, error: { code, message } };
}

function refillDrawPile(state: GameState, random: () => number): void {
  if (state.drawPile.length > 0 || state.discardPile.length <= 1) return;
  const top = state.discardPile[state.discardPile.length - 1];
  const refill = state.discardPile.slice(0, -1);
  state.discardPile = [top];
  state.drawPile = shuffle(refill, random);
}

function drawOne(state: GameState, random: () => number): Card | null {
  refillDrawPile(state, random);
  return state.drawPile.pop() ?? null;
}

export function initializeGame(
  players: Player[],
  ruleset: Ruleset,
  random: () => number = Math.random,
): GameState {
  const deck = shuffle(createDeck(), random);
  const perPlayer = cardsPerPlayer(players.length, ruleset);
  const hands = players.map((player) => ({ ...player, hand: [] as Card[] }));

  for (let round = 0; round < perPlayer; round += 1) {
    for (const player of hands) {
      const card = deck.pop();
      if (!card) throw new Error('Deck exhausted during deal');
      player.hand.push(card);
    }
  }

  let startingDiscard: Card | undefined;
  do {
    startingDiscard = deck.pop();
    if (!startingDiscard) throw new Error('Deck exhausted while choosing starting discard');
  } while (startingDiscard.rank === '8');

  return {
    phase: 'PLAYING',
    players: hands,
    drawPile: deck,
    discardPile: [startingDiscard],
    currentSuit: startingDiscard.suit,
    turnSeatIndex: hands[0].seatIndex,
    direction: 1,
    hasDrawn: false,
    pendingEightCardId: null,
    winnerSeatIndex: null,
    version: 1,
  };
}

export function applyAction(
  original: GameState,
  actorSeatIndex: number,
  action: GameAction,
  ruleset: Ruleset,
  random: () => number = Math.random,
): ActionResult {
  const state = cloneState(original);
  if (state.phase !== 'PLAYING' && state.phase !== 'DECLARING_SUIT') {
    return error('GAME_NOT_ACTIVE', 'This game is not accepting moves.');
  }
  if (state.turnSeatIndex !== actorSeatIndex) {
    return error('NOT_YOUR_TURN', 'It is not your turn.');
  }

  const actor = state.players.find((player) => player.seatIndex === actorSeatIndex);
  if (!actor) return error('NOT_A_PLAYER', 'Player is not in this game.');

  const topCard = state.discardPile[state.discardPile.length - 1];
  if (!topCard) return error('NO_DISCARD', 'The discard pile is empty.');
  const events: GameEvent[] = [];

  if (action.type === 'DECLARE_SUIT') {
    if (state.phase !== 'DECLARING_SUIT' || !state.pendingEightCardId) {
      return error('INVALID_SUIT', 'There is no Eight waiting for a suit declaration.');
    }
    state.currentSuit = action.suit;
    state.pendingEightCardId = null;
    state.phase = 'PLAYING';
    events.push({ type: 'SUIT_DECLARED', seatIndex: actorSeatIndex, payload: { suit: action.suit } });
    advanceTurn(state);
    state.version += 1;
    events.push({ type: 'TURN_CHANGED', seatIndex: state.turnSeatIndex });
    return { success: true, state, events };
  }

  if (state.phase !== 'PLAYING') return error('SUIT_REQUIRED', 'Choose a suit before continuing.');

  if (action.type === 'DRAW_CARD') {
    if (!canDraw(state.hasDrawn)) return error('ALREADY_DREW', 'You may only draw once per turn.');
    const card = drawOne(state, random);
    if (!card) return error('NO_CARDS_AVAILABLE', 'There are no cards left to draw.');
    actor.hand.push(card);
    state.hasDrawn = true;
    state.version += 1;
    events.push({ type: 'CARD_DRAWN', seatIndex: actorSeatIndex, payload: { cardId: card.id, card } });
    return { success: true, state, events };
  }

  if (action.type === 'END_TURN') {
    if (!state.hasDrawn) return error('MUST_DRAW_OR_PLAY', 'Play a card or draw before ending your turn.');
    advanceTurn(state);
    state.version += 1;
    events.push({ type: 'TURN_CHANGED', seatIndex: state.turnSeatIndex });
    return { success: true, state, events };
  }

  const cardIndex = actor.hand.findIndex((card) => card.id === action.cardId);
  if (cardIndex < 0) return error('CARD_NOT_OWNED', 'You do not have that card.');
  const card = actor.hand[cardIndex];
  if (!isPlayable(card, topCard, state.currentSuit, ruleset)) {
    return error('INVALID_PLAY', 'That card does not match the current suit or rank.');
  }

  actor.hand.splice(cardIndex, 1);
  state.discardPile.push(card);
  state.hasDrawn = false;
  state.version += 1;
  events.push({ type: 'CARD_PLAYED', seatIndex: actorSeatIndex, payload: { cardId: card.id, card } });

  if (actor.hand.length === 0) {
    state.phase = 'FINISHED';
    state.winnerSeatIndex = actorSeatIndex;
    events.push({ type: 'PLAYER_WON', seatIndex: actorSeatIndex });
    return { success: true, state, events };
  }

  if (ruleset.eightsWild && card.rank === '8') {
    state.phase = 'DECLARING_SUIT';
    state.pendingEightCardId = card.id;
    state.currentSuit = null;
    return { success: true, state, events };
  }

  state.currentSuit = card.suit;
  advanceTurn(state);
  events.push({ type: 'TURN_CHANGED', seatIndex: state.turnSeatIndex });
  return { success: true, state, events };
}
