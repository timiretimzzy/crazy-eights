import assert from 'node:assert/strict';
import { createDeck } from '../src/engine/deck.ts';
import { initializeGame, applyAction } from '../src/engine/reducer.ts';
import { DEFAULT_RULESET } from '../src/engine/types.ts';
import { canRespondToPickup, isPlayable, isStarterRank, isWinningRank } from '../src/engine/rules.ts';
import { chooseAiAction, chooseAiSuit } from '../src/engine/ai.ts';

const players = (n) => Array.from({ length: n }, (_, i) => ({
  id: `p${i}`, displayName: `P${i + 1}`, isAI: i > 0, seatIndex: i, hand: [], connected: true,
}));

const card = (rank, suit) => ({ id: `${rank}-${suit}`, rank, suit });
const joker = () => card('JOKER', 'jokers');
const fixedRandom = () => 0.42;

const makeState = (overrides = {}) => {
  const { hand = [], opponentHands = [[]], ...rest } = overrides;
  const seats = Math.max(2, 1 + opponentHands.length);
  const row = Array.from({ length: seats }, (_, i) => ({
    id: `p${i}`, displayName: `P${i + 1}`, isAI: i > 0, seatIndex: i,
    hand: i === 0 ? hand : (opponentHands[i - 1] ?? []), connected: true,
  }));
  const top = rest.topCard ?? card('7', 'hearts');
  return {
    phase: rest.phase ?? 'PLAYING', players: row,
    drawPile: rest.drawPile ?? [], discardPile: rest.discardPile ?? [top],
    currentSuit: rest.currentSuit ?? top.suit, turnSeatIndex: rest.turnSeatIndex ?? 0,
    direction: rest.direction ?? 1, hasDrawn: rest.hasDrawn ?? false,
    carryOn: rest.carryOn ?? false, pendingPickup: rest.pendingPickup ?? 0,
    pendingEightCardId: rest.pendingEightCardId ?? null, winnerSeatIndex: rest.winnerSeatIndex ?? null,
    version: rest.version ?? 1,
  };
};

// --- Deck ---
const deck = createDeck();
assert.equal(deck.length, 54, 'deck has 54 cards');
assert.equal(new Set(deck.map(c => c.id)).size, 54, 'deck has no duplicate ids');
assert.equal(deck.filter(c => c.rank === 'JOKER').length, 2, 'deck has two jokers');

// --- Deal: restricted opening card + 54-card conservation ---
for (const count of [2, 3, 4, 5, 6]) {
  const state = initializeGame(players(count), DEFAULT_RULESET, fixedRandom);
  assert.equal(isStarterRank(state.discardPile[0].rank), true, `restricted opener for ${count} players`);
  const allCards = [...state.players.flatMap(p => p.hand), ...state.drawPile, ...state.discardPile];
  assert.equal(allCards.length, 54, `deck conserved for ${count} players`);
  assert.equal(state.pendingPickup, 0, 'initial pickup is zero');
  assert.equal(state.carryOn, false, 'initial carry-on is false');
}

// --- Playability ---
const top = card('7', 'hearts');
assert.equal(isPlayable(card('K', 'hearts'), top, 'hearts', DEFAULT_RULESET), true, 'suit match playable');
assert.equal(isPlayable(joker(), top, 'clubs', DEFAULT_RULESET), true, 'joker always playable');
assert.equal(isPlayable(card('K', 'hearts'), top, 'hearts', DEFAULT_RULESET, { pendingPickup: 5 }), false, 'king does not bypass pickup');
assert.equal(isPlayable(card('2', 'spades'), top, 'diamonds', DEFAULT_RULESET, { pendingPickup: 5 }), true, 'pickup response ignores suit');
assert.equal(canRespondToPickup(card('A', 'spades'), DEFAULT_RULESET), true, 'ace is a response');
assert.equal(canRespondToPickup(card('8', 'spades'), DEFAULT_RULESET), false, 'eight is not a response');
assert.equal(isWinningRank('Q'), true, 'Q is a winning rank');
assert.equal(isWinningRank('K'), false, 'K is not a winning rank');

// --- Joker pickup + auto-resolve when the victim cannot respond ---
let state = makeState({
  hand: [joker(), card('5', 'clubs')], opponentHands: [[]], topCard: card('5', 'hearts'),
  drawPile: [card('3', 'clubs'), card('4', 'diamonds'), card('5', 'spades'), card('6', 'hearts'), card('9', 'clubs')],
});
let result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'JOKER-jokers' }, DEFAULT_RULESET, fixedRandom);
assert.equal(result.success, true, 'joker play succeeds');
assert.equal(result.state.pendingPickup, 0, 'unanswered pickup auto-resolved');
assert.equal(result.state.players[1].hand.length, 5, 'victim automatically picked up five cards');
assert.equal(result.state.turnSeatIndex, 0, 'turn advanced past the victim');

// --- Ace block clears the pile and grants one extra play ---
state = makeState({
  hand: [joker(), card('9', 'diamonds')], opponentHands: [[card('A', 'clubs')]], topCard: card('5', 'hearts'),
});
result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'JOKER-jokers' }, DEFAULT_RULESET, fixedRandom);
assert.equal(result.state.players[1].hand.length, 1, 'victim keeps its response card');
result = applyAction(result.state, 1, { type: 'PLAY_CARD', cardId: 'A-clubs' }, DEFAULT_RULESET, fixedRandom);
assert.equal(result.success, true, 'ace block succeeds');
assert.equal(result.state.pendingPickup, 0, 'ace clears the pickup');
assert.equal(result.state.carryOn, true, 'blocker completes their turn with one extra play');
assert.equal(result.state.turnSeatIndex, 1, 'blocker keeps the turn');

// --- 2 stacks onto a Joker (mixed stacking +7) ---
state = makeState({
  hand: [joker(), card('9', 'diamonds'), card('A', 'clubs')], opponentHands: [[card('2', 'clubs')]], topCard: card('5', 'hearts'),
});
result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'JOKER-jokers' }, DEFAULT_RULESET, fixedRandom);
assert.equal(result.state.pendingPickup, 5, 'first pickup +5');
result = applyAction(result.state, 1, { type: 'PLAY_CARD', cardId: '2-clubs' }, DEFAULT_RULESET, fixedRandom);
assert.equal(result.success, true, 'two response succeeds');
assert.ok(result.events.some(e => e.type === 'PICKUP_ADDED' && e.payload?.total === 7), 'mixed stacking totals 7');
assert.equal(result.state.pendingPickup, 7, 'stacked pickup stays pending');

// --- King gives exactly one extra play, consumed by the next non-King ---
state = makeState({ hand: [card('K', 'hearts'), card('9', 'hearts'), card('5', 'clubs')], topCard: card('K', 'spades') });
result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET, fixedRandom);
assert.equal(result.state.turnSeatIndex, 0, 'king keeps the same player');
assert.equal(result.state.carryOn, true, 'exactly one extra play granted');
result = applyAction(result.state, 0, { type: 'PLAY_CARD', cardId: '9-hearts' }, DEFAULT_RULESET, fixedRandom);
assert.equal(result.state.turnSeatIndex, 1, 'non-king play ends the turn');
assert.equal(result.state.carryOn, false, 'extra play consumed');

// --- K → K → K → normal chain terminates ---
state = makeState({
  hand: [card('K', 'hearts'), card('K', 'diamonds'), card('K', 'clubs'), card('3', 'clubs'), card('5', 'spades')],
  topCard: card('K', 'spades'),
});
for (const id of ['K-hearts', 'K-diamonds', 'K-clubs']) {
  result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: id }, DEFAULT_RULESET, fixedRandom);
  assert.equal(result.success, true, `${id} plays`);
  assert.equal(result.state.carryOn, true, 'chain keeps granting one extra play');
  state = result.state;
}
result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: '3-clubs' }, DEFAULT_RULESET, fixedRandom);
assert.equal(result.state.carryOn, false, 'normal card consumes the chain');
assert.equal(result.state.turnSeatIndex, 1, 'turn passes after the chain');

// --- K as final card never wins; auto-draws one ---
state = makeState({ hand: [card('K', 'hearts')], topCard: card('9', 'hearts'), drawPile: [card('3', 'clubs')] });
result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET, fixedRandom);
assert.equal(result.success, true, 'final king plays');
assert.equal(result.state.phase, 'PLAYING', 'no win declared');
assert.equal(result.state.winnerSeatIndex, null, 'no winner');
assert.equal(result.state.players[0].hand.length, 1, 'player obtained another card');
assert.equal(result.state.carryOn, true, 'king still grants its extra play');

// --- 7 skips the next player in a three-player game ---
state = makeState({
  hand: [card('7', 'hearts'), card('5', 'clubs')], opponentHands: [[card('9', 'clubs')], [card('9', 'diamonds')]],
  topCard: card('J', 'hearts'),
});
result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: '7-hearts' }, DEFAULT_RULESET, fixedRandom);
assert.equal(result.state.turnSeatIndex, 2, 'seven skips seat 1');

// --- Jack reverses direction ---
state = makeState({
  hand: [card('J', 'hearts'), card('5', 'clubs')], opponentHands: [[card('9', 'clubs')], [card('9', 'diamonds')]],
  topCard: card('J', 'clubs'),
});
result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: 'J-hearts' }, DEFAULT_RULESET, fixedRandom);
assert.equal(result.state.direction, -1, 'jack reverses direction');

// --- 8 requires a suit declaration and cannot win alone ---
state = makeState({ hand: [card('8', 'spades')], topCard: card('9', 'hearts'), drawPile: [card('3', 'clubs')] });
result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: '8-spades' }, DEFAULT_RULESET, fixedRandom);
assert.equal(result.success, true, 'eight plays');
assert.equal(result.state.phase, 'DECLARING_SUIT', 'eight asks for a suit');
assert.equal(result.state.winnerSeatIndex, null, 'eight alone does not win');
assert.equal(result.state.players[0].hand.length, 1, 'eight auto-drew another card');

// --- Reshuffle preserves the top discard ---
state = makeState({
  drawPile: [], discardPile: [card('2', 'hearts'), card('3', 'spades'), card('4', 'diamonds')],
  hand: [card('K', 'clubs')],
});
result = applyAction(state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET, fixedRandom);
assert.equal(result.success, true, 'draw after reshuffle succeeds');
assert.deepEqual(result.state.discardPile, [card('4', 'diamonds')], 'top discard preserved');

// --- Allowed finisher wins ---
state = makeState({ hand: [card('9', 'hearts')], topCard: card('5', 'hearts') });
result = applyAction(state, 0, { type: 'PLAY_CARD', cardId: '9-hearts' }, DEFAULT_RULESET, fixedRandom);
assert.equal(result.state.phase, 'FINISHED', 'allowed finisher wins');
assert.equal(result.state.winnerSeatIndex, 0, 'winner recorded');

// --- AI pickup priority: Ace > Joker > 2 ---
state = makeState({ pendingPickup: 5, hand: [card('2', 'diamonds'), joker(), card('A', 'spades')] });
assert.deepEqual(chooseAiAction(state, 0, DEFAULT_RULESET), { type: 'PLAY_CARD', cardId: 'A-spades' }, 'AI blocks with an ace');
state = makeState({ pendingPickup: 5, hand: [card('2', 'diamonds'), joker()] });
assert.deepEqual(chooseAiAction(state, 0, DEFAULT_RULESET), { type: 'PLAY_CARD', cardId: 'JOKER-jokers' }, 'AI prefers joker over two');
state = makeState({ pendingPickup: 5, hand: [card('9', 'clubs'), card('2', 'diamonds')] });
assert.deepEqual(chooseAiAction(state, 0, DEFAULT_RULESET), { type: 'PLAY_CARD', cardId: '2-diamonds' }, 'AI plays a two');
state = makeState({ pendingPickup: 5, hand: [card('9', 'clubs')] });
assert.deepEqual(chooseAiAction(state, 0, DEFAULT_RULESET), { type: 'RESOLVE_PICKUP' }, 'AI picks up when it cannot respond');

// --- AI avoids ending on a prohibited card ---
state = makeState({ hand: [card('K', 'hearts')], currentSuit: 'hearts', topCard: top });
assert.deepEqual(chooseAiAction(state, 0, DEFAULT_RULESET), { type: 'DRAW_CARD' }, 'AI draws instead of stroking a lone king');

// --- Full AI game terminates ---
state = initializeGame(players(4).map(p => ({ ...p, isAI: true })), DEFAULT_RULESET, Math.random);
let guard = 0;
while (state.phase === 'PLAYING' && guard < 500) {
  guard += 1;
  const actor = state.players.find(p => p.seatIndex === state.turnSeatIndex);
  const res = applyAction(state, actor.seatIndex, chooseAiAction(state, actor.seatIndex, DEFAULT_RULESET), DEFAULT_RULESET, Math.random);
  assert.equal(res.success, true, 'AI action succeeds');
  state = res.state;
  if (state.phase === 'DECLARING_SUIT') {
    const pending = state.players.find(p => p.seatIndex === state.turnSeatIndex);
    const declared = applyAction(state, pending.seatIndex, { type: 'DECLARE_SUIT', suit: chooseAiSuit(pending.hand) }, DEFAULT_RULESET, Math.random);
    assert.equal(declared.success, true, 'suit declaration succeeds');
    state = declared.state;
  }
}
assert.equal(state.phase, 'FINISHED', 'AI game completes');
assert.ok(guard < 500, 'AI game terminates within the guard');

console.log('Engine tests passed.');