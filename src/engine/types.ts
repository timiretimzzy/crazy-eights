export const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'] as const;
export type StandardSuit = (typeof SUITS)[number];

export const JOKER_SUIT = 'jokers';
export type JokerSuit = typeof JOKER_SUIT;

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'JOKER'] as const;
export type Rank = (typeof RANKS)[number];

export type Suit = StandardSuit | JokerSuit;
export type DeclareSuit = StandardSuit;

export type Card = {
  id: string;
  suit: Suit;
  rank: Rank;
};

export type Ruleset = {
  jokerEnabled: boolean;
  jokerPickup: number;
  aceBlocksPickup: boolean;
  twoPickup: number;
  sevenAction: 'skip' | 'reverse';
  jackAction: 'skip' | 'reverse';
  eightsWild: boolean;
  kingCarryOn: boolean;
  mixedPickupStacking: boolean;
  restrictedFirstCards: boolean;
  restrictedWinningCards: boolean;
  dealRules: {
    smallGameMaxPlayers: number;
    smallGameCards: number;
    largeGameCards: number;
  };
};

export const DEFAULT_RULESET: Ruleset = {
  jokerEnabled: true,
  jokerPickup: 5,
  aceBlocksPickup: true,
  twoPickup: 2,
  sevenAction: 'skip',
  jackAction: 'reverse',
  eightsWild: true,
  kingCarryOn: true,
  mixedPickupStacking: true,
  restrictedFirstCards: true,
  restrictedWinningCards: true,
  dealRules: {
    smallGameMaxPlayers: 3,
    smallGameCards: 5,
    largeGameCards: 4,
  },
};

export type Player = {
  id: string;
  displayName: string;
  isAI: boolean;
  seatIndex: number;
  hand: Card[];
  connected: boolean;
};

export type GamePhase = 'LOBBY' | 'INITIALIZING' | 'PLAYING' | 'DECLARING_SUIT' | 'FINISHED';

export type GameState = {
  phase: GamePhase;
  players: Player[];
  drawPile: Card[];
  discardPile: Card[];
  currentSuit: DeclareSuit | null;
  turnSeatIndex: number;
  direction: 1 | -1;
  hasDrawn: boolean;
  /** True while the current player holds one unconsumed extra play opportunity
   * granted by the immediately preceding King (or an Ace pickup block). It is
   * consumed by the very next play; a King re-grants it. It is NOT a persistent
   * "keep playing" state — advanceTurn clears it. */
  carryOn: boolean;
  pendingPickup: number;
  pendingEightCardId: string | null;
  winnerSeatIndex: number | null;
  version: number;
};

export type GameAction =
  | { type: 'PLAY_CARD'; cardId: string }
  | { type: 'DECLARE_SUIT'; suit: DeclareSuit }
  | { type: 'DRAW_CARD' }
  | { type: 'END_TURN' }
  | { type: 'RESOLVE_PICKUP' };

export type GameEvent = {
  type:
    | 'CARD_PLAYED'
    | 'CARD_DRAWN'
    | 'SUIT_DECLARED'
    | 'TURN_CHANGED'
    | 'PLAYER_WON'
    | 'GAME_STARTED'
    | 'SKIPPED'
    | 'REVERSED'
    | 'PICKUP_ADDED'
    | 'PICKUP_BLOCKED'
    | 'PICKUP_RESOLVED'
    | 'CARRY_ON'
    | 'AUTO_DREW'
    | 'GAME_STALLED';
  seatIndex?: number;
  payload?: Record<string, unknown>;
};

export type ActionResult =
  | { success: true; state: GameState; events: GameEvent[] }
  | { success: false; error: { code: string; message: string } };