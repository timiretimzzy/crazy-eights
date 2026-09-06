export const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'] as const;
export type Suit = (typeof SUITS)[number];

export const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'] as const;
export type Rank = (typeof RANKS)[number];

export type Card = {
  id: string;
  suit: Suit;
  rank: Rank;
};

export type Ruleset = {
  eightsWild: boolean;
  dealRules: {
    smallGameMaxPlayers: number;
    smallGameCards: number;
    largeGameCards: number;
  };
  houseRules: {
    twosDrawTwo: boolean;
    queensSkip: boolean;
    jacksReverse: boolean;
    aces: 'draw_4' | 'skip' | 'off';
  };
};

export const DEFAULT_RULESET: Ruleset = {
  eightsWild: true,
  dealRules: {
    smallGameMaxPlayers: 3,
    smallGameCards: 5,
    largeGameCards: 4,
  },
  houseRules: {
    twosDrawTwo: false,
    queensSkip: false,
    jacksReverse: false,
    aces: 'off',
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
  currentSuit: Suit | null;
  turnSeatIndex: number;
  direction: 1 | -1;
  hasDrawn: boolean;
  pendingEightCardId: string | null;
  winnerSeatIndex: number | null;
  version: number;
};

export type GameAction =
  | { type: 'PLAY_CARD'; cardId: string }
  | { type: 'DECLARE_SUIT'; suit: Suit }
  | { type: 'DRAW_CARD' }
  | { type: 'END_TURN' };

export type GameEvent = {
  type:
    | 'CARD_PLAYED'
    | 'CARD_DRAWN'
    | 'SUIT_DECLARED'
    | 'TURN_CHANGED'
    | 'PLAYER_WON'
    | 'GAME_STARTED';
  seatIndex?: number;
  payload?: Record<string, unknown>;
};

export type ActionResult =
  | { success: true; state: GameState; events: GameEvent[] }
  | { success: false; error: { code: string; message: string } };
