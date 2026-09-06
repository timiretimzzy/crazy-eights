import assert from 'node:assert/strict';
import { createDeck } from '../src/engine/deck.ts';
import { initializeGame, applyAction } from '../src/engine/reducer.ts';
import { DEFAULT_RULESET } from '../src/engine/types.ts';
import { isPlayable } from '../src/engine/rules.ts';
import { chooseAiAction, chooseAiSuit } from '../src/engine/ai.ts';

const players = (n) => Array.from({ length: n }, (_, i) => ({
  id: `p${i}`, displayName: `P${i + 1}`, isAI: i > 0, seatIndex: i, hand: [], connected: true,
}));

const card = (rank, suit) => ({ id: `${rank}-${suit}`, rank, suit });
const fixedRandom = () => 0.42;

// --- Deck ---
const deck = createDeck();
assert.equal(deck.length, 52, 'deck has 52 cards');
assert.equal(new Set(deck.map(c => c.id)).size, 52, 'deck has no duplicates');
assert.equal(new Set(deck.map(c => c.suit)).size, 4, 'deck has four suits');
assert.equal(new Set(deck.map(c => c.rank)).size, 13, 'deck has thirteen ranks');

// --- Deal ---
for (const count of [2, 3, 4, 5, 6]) {
  const state = initializeGame(players(count), DEFAULT_RULESET, fixedRandom);
  const expected = count <= 3 ? 5 : 4;
  assert.deepEqual(state.players.map(p => p.hand.length), Array(count).fill(expected), `deal size for ${count} players`);
  assert.equal(state.discardPile.length, 1, `discard starts with one card for ${count} players`);
  assert.notEqual(state.discardPile[0].rank, '8', 'starting discard is never an eight');
}

// --- Playability ---
const top = card('7', 'hearts');
assert.equal(isPlayable(card('K', 'hearts'), top, 'hearts', DEFAULT_RULESET), true, 'suit match playable');
assert.equal(isPlayable(card('7', 'clubs'), top, 'hearts', DEFAULT_RULESET), true, 'rank match playable');
assert.equal(isPlayable(card('8', 'spades'), top, 'hearts', DEFAULT_RULESET), true, 'eight always playable');
assert.equal(isPlayable(card('K', 'clubs'), top, 'hearts', DEFAULT_RULESET), false, 'no-match card rejected');

// --- Invalid play rejected ---
let state = initializeGame(players(2), DEFAULT_RULESET, Math.random);
const actor = state.players[0];
const invalid = actor.hand.find(c => !isPlayable(c, state.discardPile[0], state.currentSuit, DEFAULT_RULESET));
if (invalid) {
  const result = applyAction(state, actor.seatIndex, { type: 'PLAY_CARD', cardId: invalid.id }, DEFAULT_RULESET);
  assert.equal(result.success, false, 'invalid play rejected');
}

// --- Eight flow ---
const eight = card('8', 'spades');
state.players[0].hand = [eight, card('A', 'clubs')];
const playEight = applyAction(state, 0, { type: 'PLAY_CARD', cardId: eight.id }, DEFAULT_RULESET);
assert.equal(playEight.success, true, 'eight can be played');
assert.equal(playEight.state.phase, 'DECLARING_SUIT', 'eight triggers declaring-suit phase');
assert.equal(playEight.state.turnSeatIndex, 0, 'declarer keeps the turn');
const suit = applyAction(playEight.state, 0, { type: 'DECLARE_SUIT', suit: 'clubs' }, DEFAULT_RULESET);
assert.equal(suit.success, true, 'suit declaration succeeds');
assert.equal(suit.state.currentSuit, 'clubs', 'declared suit is stored');
assert.equal(suit.state.turnSeatIndex, 1, 'turn advances after declaration');

// --- Draw / keep / end turn ---
const keepState = initializeGame(players(2), DEFAULT_RULESET, fixedRandom);
keepState.players[0].hand = [card('K', 'clubs')];
keepState.drawPile = [card('3', 'diamonds')];
keepState.discardPile = [card('7', 'hearts')];
keepState.currentSuit = 'hearts';
const drawn = applyAction(keepState, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
assert.equal(drawn.success, true, 'draw succeeds');
assert.equal(drawn.state.players[0].hand.length, 2, 'hand grows by one');
assert.equal(drawn.state.hasDrawn, true, 'hasDrawn flag set');
const secondDraw = applyAction(drawn.state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
assert.equal(secondDraw.success, false, 'second draw rejected');
const ended = applyAction(drawn.state, 0, { type: 'END_TURN' }, DEFAULT_RULESET);
assert.equal(ended.success, true, 'drawn card can be kept and turn ended');
assert.equal(ended.state.players[0].hand.length, 2, 'kept card stays in hand');
assert.equal(ended.state.turnSeatIndex, 1, 'turn passed');

// --- Reshuffle: top discard preserved, remainder recycled ---
const reshuffleState = initializeGame(players(2), DEFAULT_RULESET, fixedRandom);
reshuffleState.players[0].hand = [card('K', 'clubs')];
reshuffleState.drawPile = [];
reshuffleState.discardPile = [card('2', 'hearts'), card('3', 'spades'), card('4', 'diamonds')];
reshuffleState.currentSuit = 'diamonds';
const reshuffled = applyAction(reshuffleState, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET, fixedRandom);
assert.equal(reshuffled.success, true, 'reshuffle draw succeeds');
assert.deepEqual(reshuffled.state.discardPile, [card('4', 'diamonds')], 'top discard preserved');
assert.equal(reshuffled.state.drawPile.length, 1, 'remainder reshuffled into draw pile');
assert.equal(reshuffled.state.players[0].hand.length, 2, 'card drawn from recycled pile');

// --- Win ---
const winState = initializeGame(players(2), DEFAULT_RULESET, fixedRandom);
winState.players[0].hand = [card('K', 'hearts')];
winState.discardPile = [card('5', 'hearts')];
winState.currentSuit = 'hearts';
const win = applyAction(winState, 0, { type: 'PLAY_CARD', cardId: 'K-hearts' }, DEFAULT_RULESET);
assert.equal(win.success, true, 'last card playable');
assert.equal(win.state.phase, 'FINISHED', 'game finished');
assert.equal(win.state.winnerSeatIndex, 0, 'winner recorded');
const afterWin = applyAction(win.state, 0, { type: 'DRAW_CARD' }, DEFAULT_RULESET);
assert.equal(afterWin.success, false, 'actions rejected after finish');

// --- AI behavior ---
const aiState = initializeGame(players(2), DEFAULT_RULESET, fixedRandom);
aiState.players[0].hand = [card('8', 'spades'), card('7', 'clubs'), card('K', 'hearts')];
aiState.discardPile = [card('7', 'hearts')];
aiState.currentSuit = 'hearts';
assert.deepEqual(chooseAiAction(aiState, 0, DEFAULT_RULESET), { type: 'PLAY_CARD', cardId: 'K-hearts' }, 'AI prefers suit match');
assert.equal(chooseAiSuit([card('A', 'spades'), card('3', 'spades'), card('5', 'hearts')]), 'spades', 'AI declares majority suit');

console.log('Engine tests passed.');