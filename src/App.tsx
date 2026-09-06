import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties } from 'react';
import type { Card, GameAction, GameState, Ruleset, Suit } from './engine/types.ts';
import { DEFAULT_RULESET, SUITS } from './engine/types.ts';
import { applyAction, initializeGame } from './engine/reducer.ts';
import { chooseAiAction, chooseAiSuit } from './engine/ai.ts';
import { isPlayable } from './engine/rules.ts';
import { ensureAnonymousSession, supabase, supabaseConfigured } from './lib/supabase.ts';
import {
  createLobby,
  createSoloGame,
  getGame,
  joinGame,
  lobbyAction,
  playAgain,
  sendGameAction,
  type GameSnapshot,
  type PublicGameState,
} from './lib/gameApi.ts';

const SUIT_SYMBOL: Record<Suit, string> = { hearts: '♥', diamonds: '♦', clubs: '♣', spades: '♠' };
const SUIT_NAME: Record<Suit, string> = { hearts: 'Hearts', diamonds: 'Diamonds', clubs: 'Clubs', spades: 'Spades' };

type Screen = 'home' | 'soloSetup' | 'createLobby' | 'join' | 'lobby' | 'game' | 'results';

export function App() {
  const initialGameId = getGameIdFromPath();
  const [screen, setScreen] = useState<Screen>(initialGameId ? 'join' : 'home');
  const [gameId, setGameId] = useState<string | null>(initialGameId);
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('ce_display_name') || 'Player');
  const [snapshot, setSnapshot] = useState<GameSnapshot | null>(null);
  const [localState, setLocalState] = useState<GameState | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'mixed' | 'humans_only'>('mixed');

  useEffect(() => { localStorage.setItem('ce_display_name', displayName.trim() || 'Player'); }, [displayName]);

  const loadGame = async (id: string) => {
    const data = await getGame(id);
    setSnapshot(data);
    if (data.publicState.status === 'lobby') setScreen('lobby');
    else if (data.publicState.status === 'finished') setScreen('results');
    else setScreen('game');
    return data;
  };

  useEffect(() => {
    if (!gameId || !supabaseConfigured) return;
    let cancelled = false;
    (async () => {
      try {
        await ensureAnonymousSession();
        await loadGame(gameId);
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        if (!cancelled && (message.includes('NOT_A_PLAYER') || message.includes('403') || message.includes('You are not a player'))) {
          setScreen('join');
        } else if (!cancelled) {
          setErrorMessage('That game could not be loaded.');
          setScreen('home');
        }
      }
    })();
    return () => { cancelled = true; };
  }, [gameId]);

  useEffect(() => {
    const client = supabase;
    if (!client || !gameId || !supabaseConfigured || (screen !== 'lobby' && screen !== 'game')) return;
    const channel = client.channel(`game:${gameId}`)
      .on('broadcast', { event: 'GAME_UPDATED' }, () => {
        void loadGame(gameId).catch(() => undefined);
      })
      .subscribe();
    return () => { void client.removeChannel(channel); };
  }, [gameId, screen]);

  useEffect(() => {
    if (!gameId || !supabaseConfigured || (screen !== 'lobby' && screen !== 'game')) return;
    const timer = window.setInterval(() => { void loadGame(gameId).catch(() => undefined); }, 1800);
    return () => window.clearInterval(timer);
  }, [gameId, screen]);

  const navigateGame = (id: string) => {
    setGameId(id);
    window.history.pushState({}, '', gamePath(id));
  };

  const handleCreateSolo = async (opponents: number, ruleset: Ruleset) => {
    setBusy(true); setErrorMessage('');
    try {
      if (!supabaseConfigured) {
        const players = [{ id: 'human', displayName: displayName.trim() || 'You', isAI: false, seatIndex: 0, hand: [], connected: true }, ...Array.from({ length: opponents }, (_, i) => ({ id: `ai-${i}`, displayName: `Bot ${i + 1}`, isAI: true, seatIndex: i + 1, hand: [], connected: true }))];
        const state = initializeGame(players, ruleset);
        setLocalState(state); setSnapshot(localSnapshot(state, ruleset)); setGameId('local'); setScreen('game');
      } else {
        await ensureAnonymousSession();
        const created = await createSoloGame(displayName.trim() || 'Player', opponents, ruleset);
        navigateGame(created.gameId);
        await loadGame(created.gameId);
      }
    } catch (error) { setErrorMessage(error instanceof Error ? error.message : 'Could not start game.'); }
    finally { setBusy(false); }
  };

  const handleCreateLobby = async (maxSeats: number) => {
    if (!supabaseConfigured) { setErrorMessage('Configure Supabase to create online friend games.'); return; }
    setBusy(true); setErrorMessage('');
    try {
      await ensureAnonymousSession();
      const created = await createLobby(mode, maxSeats, displayName.trim() || 'Player');
      navigateGame(created.gameId);
      await loadGame(created.gameId);
    } catch (error) { setErrorMessage(error instanceof Error ? error.message : 'Could not create lobby.'); }
    finally { setBusy(false); }
  };

  const handleJoin = async () => {
    if (!gameId) return;
    setBusy(true); setErrorMessage('');
    try {
      await ensureAnonymousSession();
      await joinGame(gameId, displayName.trim() || 'Player');
      await loadGame(gameId);
    } catch (error) { setErrorMessage(error instanceof Error ? error.message : 'Could not join that game.'); }
    finally { setBusy(false); }
  };

  const home = () => { setGameId(null); setSnapshot(null); setLocalState(null); window.history.pushState({}, '', '/'); setScreen('home'); };

  return <main className="app-shell">
    <div className="grain" />
    {screen === 'home' && <Home displayName={displayName} setDisplayName={setDisplayName} setScreen={setScreen} />}
    {screen === 'soloSetup' && <SoloSetup onStart={handleCreateSolo} busy={busy} back={() => setScreen('home')} />}
    {screen === 'createLobby' && <CreateLobby mode={mode} setMode={setMode} onCreate={handleCreateLobby} busy={busy} back={() => setScreen('home')} />}
    {screen === 'join' && gameId && <JoinGame gameId={gameId} displayName={displayName} setDisplayName={setDisplayName} onJoin={handleJoin} busy={busy} back={home} />}
    {screen === 'lobby' && snapshot && gameId && <Lobby snapshot={snapshot.publicState} gameId={gameId} refresh={() => loadGame(gameId).then(() => undefined)} onAction={async actionName => { setBusy(true); try { await lobbyAction(gameId, actionName); await loadGame(gameId); } catch (e) { setErrorMessage(e instanceof Error ? e.message : 'Lobby action failed.'); } finally { setBusy(false); } }} busy={busy} />}
    {screen === 'game' && snapshot && gameId && <GameView snapshot={snapshot} gameId={gameId} localState={localState} onLocalState={state => { setLocalState(state); setSnapshot(localSnapshot(state, snapshot.publicState.ruleset)); }} onSnapshot={setSnapshot} onFinish={() => setScreen('results')} setErrorMessage={setErrorMessage} />}
    {screen === 'results' && snapshot && gameId && <Results snapshot={snapshot.publicState} gameId={gameId} onRematch={async () => { if (snapshot.publicState.isHost && gameId !== 'local') { try { await playAgain(gameId); await loadGame(gameId); } catch (e) { setErrorMessage(e instanceof Error ? e.message : 'Could not reset the match.'); } } else if (gameId === 'local') { setScreen('home'); setSnapshot(null); setLocalState(null); } }} onHome={home} />}
    {errorMessage && <div className="toast error" role="alert"><span>{friendlyError(errorMessage)}</span><button onClick={() => setErrorMessage('')}>×</button></div>}
  </main>;
}

function Home({ displayName, setDisplayName, setScreen }: { displayName: string; setDisplayName: (v: string) => void; setScreen: (s: Screen) => void }) {
  return <section className="home screen-enter">
    <div className="brand-lockup"><span className="eyebrow">ARCADE / CARD GAME</span><h1>Crazy<br /><span>Eights</span></h1><p>Fast cards. One winner.</p></div>
    <label className="name-field"><span>YOUR NAME</span><input maxLength={18} value={displayName} onChange={(e: ChangeEvent<HTMLInputElement>) => setDisplayName(e.target.value)} /></label>
    <div className="home-actions"><button className="primary huge" onClick={() => setScreen('soloSetup')}>Play vs AI <span>→</span></button><button className="secondary huge" onClick={() => setScreen('createLobby')}>Play friends <span>+</span></button></div>
    <div className="home-note"><span className="live-dot" /> 2–6 players · no sign-up form</div>
  </section>;
}

function JoinGame({ gameId, displayName, setDisplayName, onJoin, busy, back }: { gameId: string; displayName: string; setDisplayName: (v: string) => void; onJoin: () => Promise<void>; busy: boolean; back: () => void }) {
  return <section className="setup-panel screen-enter"><button className="back" onClick={back}>← Home</button><span className="eyebrow">INVITE RECEIVED</span><h2>You’ve been<br /><span>challenged.</span></h2><p className="helper">Game <code>{gameId.slice(0, 8)}</code> is ready. Choose the name other players will see.</p><label className="name-field"><span>YOUR NAME</span><input maxLength={18} value={displayName} onChange={(e: ChangeEvent<HTMLInputElement>) => setDisplayName(e.target.value)} /></label><button className="primary huge" disabled={busy} onClick={() => void onJoin()}>{busy ? 'Joining…' : 'Join game'} <span>→</span></button></section>;
}

function SoloSetup({ onStart, busy, back }: { onStart: (n: number, ruleset: Ruleset) => Promise<void>; busy: boolean; back: () => void }) {
  const [opponents, setOpponents] = useState(3);
  return <section className="setup-panel screen-enter"><button className="back" onClick={back}>← Back</button><span className="eyebrow">SOLO</span><h2>Pick your<br /><span>opponents.</span></h2><div className="stepper"><button onClick={() => setOpponents(n => Math.max(1, n - 1))}>−</button><div><strong>{opponents}</strong><span>AI opponents</span></div><button onClick={() => setOpponents(n => Math.min(5, n + 1))}>+</button></div><div className="mini-table">{Array.from({ length: opponents + 1 }, (_, i) => <div key={i} className={`seat ${i === 0 ? 'me' : ''}`}>{i === 0 ? 'YOU' : `BOT ${i}`}</div>)}</div><button className="primary huge" disabled={busy} onClick={() => void onStart(opponents, DEFAULT_RULESET)}>{busy ? 'Starting…' : 'Start game'} <span>→</span></button></section>;
}

function CreateLobby({ mode, setMode, onCreate, busy, back }: { mode: 'mixed' | 'humans_only'; setMode: (v: 'mixed' | 'humans_only') => void; onCreate: (n: number) => Promise<void>; busy: boolean; back: () => void }) {
  const [seats, setSeats] = useState(4);
  return <section className="setup-panel screen-enter"><button className="back" onClick={back}>← Back</button><span className="eyebrow">FRIENDS</span><h2>Build your<br /><span>table.</span></h2><div className="segmented"><button className={mode === 'mixed' ? 'active' : ''} onClick={() => setMode('mixed')}>Mixed</button><button className={mode === 'humans_only' ? 'active' : ''} onClick={() => setMode('humans_only')}>Humans only</button></div><label className="range-field"><span>MAX SEATS</span><div className="range-row"><input type="range" min="2" max="6" value={seats} onChange={(e: ChangeEvent<HTMLInputElement>) => setSeats(Number(e.target.value))} /><strong>{seats}</strong></div></label><p className="helper">Mixed games fill empty seats with AI when you start. Humans-only games simply shrink to the players who joined.</p><button className="primary huge" disabled={busy} onClick={() => void onCreate(seats)}>{busy ? 'Creating…' : 'Create invite lobby'} <span>→</span></button></section>;
}

function Lobby({ snapshot, gameId, refresh, onAction, busy }: { snapshot: PublicGameState; gameId: string; refresh: () => Promise<void>; onAction: (a: 'start_game' | 'add_ai' | 'remove_ai') => Promise<void>; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  const shareUrl = `${window.location.origin}${gamePath(gameId)}`;
  const seats = Array.from({ length: snapshot.maxSeats }, (_, i) => snapshot.players.find(p => p.seatIndex === i));
  const copy = async () => { try { await navigator.clipboard.writeText(shareUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1200); } catch { /* ignored */ } };
  return <section className="lobby screen-enter"><div className="lobby-head"><div><span className="eyebrow">GAME LOBBY</span><h2>{snapshot.players.length} <small>/ {snapshot.maxSeats}</small></h2></div><button className="icon-btn" onClick={() => void refresh()}>↻</button></div><div className="invite-card"><div><small>INVITE LINK</small><code>{shareUrl}</code></div><button className="secondary" onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button></div><div className="seat-list">{seats.map((player, i) => <div className={`lobby-seat ${player ? 'filled' : ''}`} key={i}><div className="seat-index">{i + 1}</div><div className="seat-name">{player ? player.displayName : 'Empty seat'}{player?.isAI && <span className="bot-tag">AI</span>}</div><div className="seat-status">{player ? 'ready' : 'waiting'}</div></div>)}</div><div className="lobby-actions">{snapshot.mode === 'mixed' && <button className="secondary" disabled={busy || snapshot.players.length >= snapshot.maxSeats} onClick={() => void onAction('add_ai')}>+ Add AI</button>}<button className="primary" disabled={busy || snapshot.players.length < 2} onClick={() => void onAction('start_game')}>Start game →</button></div><p className="helper center">Seats lock when the host starts.</p></section>;
}

function GameView({ snapshot, gameId, localState, onLocalState, onSnapshot, onFinish, setErrorMessage }: { snapshot: GameSnapshot; gameId: string; localState: GameState | null; onLocalState: (s: GameState) => void; onSnapshot: (s: GameSnapshot) => void; onFinish: () => void; setErrorMessage: (s: string) => void }) {
  const [loading, setLoading] = useState(false);
  const [suitOpen, setSuitOpen] = useState(snapshot.phase === 'DECLARING_SUIT');
  const lastVersion = useRef(snapshot.publicState.version);
  const localMode = gameId === 'local';
  const myTurn = snapshot.publicState.turnSeatIndex === snapshot.publicState.mySeatIndex;
  const topDiscard = snapshot.publicState.topDiscard as Card | null;

  useEffect(() => { if (snapshot.publicState.status === 'finished') onFinish(); }, [snapshot.publicState.status, onFinish]);
  useEffect(() => { if (snapshot.phase === 'DECLARING_SUIT') setSuitOpen(true); }, [snapshot.phase]);

  const act = async (gameAction: GameAction) => {
    setLoading(true); setErrorMessage('');
    try {
      if (localMode && localState) {
        const result = applyAction(localState, localState.turnSeatIndex, gameAction, snapshot.publicState.ruleset);
        if (!result.success) throw new Error(result.error.message);
        const next = result.state;
        onLocalState(next); onSnapshot(localSnapshot(next, snapshot.publicState.ruleset));
        if (next.phase === 'FINISHED') return;
        if (gameAction.type === 'PLAY_CARD' && next.phase === 'DECLARING_SUIT') return;
        const active = next.players.find(p => p.seatIndex === next.turnSeatIndex);
        if (active?.isAI) await runLocalAiTurns(next, snapshot.publicState.ruleset, onLocalState, onSnapshot);
      } else {
        const data = await sendGameAction(gameId, gameAction); onSnapshot(data); lastVersion.current = data.publicState.version;
        if (data.phase === 'DECLARING_SUIT') setSuitOpen(true);
      }
    } catch (error) { setErrorMessage(error instanceof Error ? error.message : 'Move failed.'); setSuitOpen(false); }
    finally { setLoading(false); }
  };

  const playCard = (card: Card) => { if (!myTurn || loading) return; void act({ type: 'PLAY_CARD', cardId: card.id }); };

  return <section className="game-shell"><div className="game-topbar"><div><span className="eyebrow">CRAZY EIGHTS</span><div className={myTurn ? 'turn-copy active' : 'turn-copy'}>{myTurn ? 'YOUR TURN' : `Seat ${Number(snapshot.publicState.turnSeatIndex ?? 0) + 1}'s turn`}</div></div><div className="draw-count"><span>DRAW</span><strong>{snapshot.publicState.drawCount}</strong></div></div><div className="players-ring">{snapshot.publicState.players.map(player => <PlayerSeat key={player.seatIndex} player={player} active={player.seatIndex === snapshot.publicState.turnSeatIndex} isMe={player.seatIndex === snapshot.publicState.mySeatIndex} />)}</div><div className="center-table"><button className="deck-stack" disabled={!myTurn || loading || snapshot.publicState.hasDrawn} onClick={() => void act({ type: 'DRAW_CARD' })}><span className="card-back">8</span><small>{snapshot.publicState.hasDrawn ? 'DRAWN' : 'DRAW'}</small></button><div className="discard-slot">{topDiscard ? <CardFace card={topDiscard} /> : <div className="empty-pile" />}</div>{snapshot.publicState.currentSuit && <div className="active-suit"><span>ACTIVE</span><strong>{SUIT_SYMBOL[snapshot.publicState.currentSuit]} {SUIT_NAME[snapshot.publicState.currentSuit]}</strong></div>}</div><div className="hand-area"><div className="hand-label"><span>Your hand</span><span>{snapshot.myHand.length} cards</span></div><div className="hand">{snapshot.myHand.map((card, i) => { const playable = topDiscard ? isPlayable(card, topDiscard, snapshot.publicState.currentSuit, snapshot.publicState.ruleset) : false; return <button key={card.id} className={`hand-card ${myTurn && playable ? 'playable-hint' : ''} ${myTurn && !playable ? 'not-playable' : ''}`} style={{ '--i': i, '--n': snapshot.myHand.length } as CSSProperties} disabled={!myTurn || loading} onClick={() => playCard(card)}><CardFace card={card} /></button>; })}</div>{myTurn && snapshot.publicState.hasDrawn && <button className="secondary end-turn" disabled={loading} onClick={() => void act({ type: 'END_TURN' })}>Keep card · End turn</button>} {myTurn && <div className="turn-help">{snapshot.publicState.hasDrawn ? 'Play the drawn card or keep it and end your turn.' : 'Tap a matching card · or draw one card.'}</div>}</div>{suitOpen && <SuitModal onPick={async suit => { setSuitOpen(false); await act({ type: 'DECLARE_SUIT', suit }); }} />}{loading && <div className="processing">Updating table…</div>}</section>;
}

function PlayerSeat({ player, active, isMe }: { player: PublicGameState['players'][number]; active: boolean; isMe: boolean }) {
  return <div className={`player-seat ${active ? 'active' : ''} ${isMe ? 'is-me' : ''}`}><div className="avatar">{player.isAI ? 'AI' : initials(player.displayName)}</div><div className="player-name">{isMe ? 'YOU' : player.displayName}</div><div className="player-cards">{Array.from({ length: Math.min(player.cardCount, 6) }, (_, i) => <span key={i} />)}<b>{player.cardCount}</b></div>{active && <div className="active-pill">TURN</div>}</div>;
}

function CardFace({ card }: { card: Card }) { const red = card.suit === 'hearts' || card.suit === 'diamonds'; return <div className={`card-face ${red ? 'red' : ''}`}><span className="corner">{card.rank}<i>{SUIT_SYMBOL[card.suit]}</i></span><span className="pip">{SUIT_SYMBOL[card.suit]}</span><span className="corner bottom">{card.rank}<i>{SUIT_SYMBOL[card.suit]}</i></span></div>; }
function SuitModal({ onPick }: { onPick: (s: Suit) => Promise<void> }) { return <div className="modal-backdrop"><div className="suit-modal"><span className="eyebrow">WILD CARD</span><h3>Choose a suit</h3><div className="suit-grid">{SUITS.map(s => <button key={s} className={s === 'hearts' || s === 'diamonds' ? 'red-suit' : ''} onClick={() => void onPick(s)}><span>{SUIT_SYMBOL[s]}</span><small>{SUIT_NAME[s]}</small></button>)}</div></div></div>; }

function Results({ snapshot, gameId, onRematch, onHome }: { snapshot: PublicGameState; gameId: string; onRematch: () => Promise<void>; onHome: () => void }) {
  const winner = snapshot.players.find(p => p.seatIndex === snapshot.winnerSeatIndex);
  const youWon = winner?.seatIndex === snapshot.mySeatIndex;
  const share = () => { const text = `I just played Crazy Eights. Think you can beat me?`; const url = window.location.origin; window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer'); };
  return <section className="results screen-enter"><div className="winner-mark">8</div><span className="eyebrow">GAME OVER</span><h2>{youWon ? 'You' : (winner?.displayName ?? 'Someone')}<br /><span>wins.</span></h2><p>{youWon ? 'You cleared the table.' : `${winner?.displayName ?? 'Someone'} got there first.`}</p><div className="results-actions"><button className="primary huge" disabled={!snapshot.isHost && gameId !== 'local'} onClick={() => void onRematch()}>{gameId === 'local' ? 'Play again →' : snapshot.isHost ? 'Play again →' : 'Waiting for host…'}</button><button className="secondary huge" onClick={share}>Share result ↗</button><button className="secondary huge" onClick={onHome}>Home</button></div></section>;
}

async function runLocalAiTurns(state: GameState, ruleset: Ruleset, onLocalState: (s: GameState) => void, onSnapshot: (s: GameSnapshot) => void) {
  let current = structuredClone(state);
  for (let turn = 0; turn < 40 && current.phase !== 'FINISHED'; turn += 1) {
    const ai = current.players.find(p => p.seatIndex === current.turnSeatIndex);
    if (!ai?.isAI) break;
    await delay(650 + Math.round(Math.random() * 500));
    if (current.hasDrawn) {
      const top = current.discardPile[current.discardPile.length - 1];
      const drawn = ai.hand[ai.hand.length - 1];
      const playable = drawn && top && isPlayable(drawn, top, current.currentSuit, ruleset);
      if (playable) {
        const played = applyAction(current, ai.seatIndex, { type: 'PLAY_CARD', cardId: drawn.id }, ruleset);
        if (!played.success) break;
        current = played.state; onLocalState(current); onSnapshot(localSnapshot(current, ruleset));
        if (current.phase === 'DECLARING_SUIT') {
          const freshAi = current.players.find(p => p.seatIndex === ai.seatIndex)!;
          await delay(350);
          const declared = applyAction(current, ai.seatIndex, { type: 'DECLARE_SUIT', suit: chooseAiSuit(freshAi.hand) }, ruleset);
          if (!declared.success) break;
          current = declared.state; onLocalState(current); onSnapshot(localSnapshot(current, ruleset));
        }
      } else {
        const ended = applyAction(current, ai.seatIndex, { type: 'END_TURN' }, ruleset);
        if (!ended.success) break;
        current = ended.state; onLocalState(current); onSnapshot(localSnapshot(current, ruleset));
      }
      continue;
    }
    const result = applyAction(current, ai.seatIndex, chooseAiAction(current, ai.seatIndex, ruleset), ruleset);
    if (!result.success) break;
    current = result.state; onLocalState(current); onSnapshot(localSnapshot(current, ruleset));
    if (current.phase === 'DECLARING_SUIT') {
      const freshAi = current.players.find(p => p.seatIndex === ai.seatIndex)!;
      await delay(350);
      const declared = applyAction(current, ai.seatIndex, { type: 'DECLARE_SUIT', suit: chooseAiSuit(freshAi.hand) }, ruleset);
      if (!declared.success) break;
      current = declared.state; onLocalState(current); onSnapshot(localSnapshot(current, ruleset));
    }
  }
}

function localSnapshot(state: GameState, ruleset: Ruleset): GameSnapshot { const me = state.players.find(p => !p.isAI)!; return { publicState: { gameId: 'local', mode: 'solo_ai', status: state.phase === 'FINISHED' ? 'finished' : 'active', maxSeats: state.players.length, players: state.players.map(p => ({ seatIndex: p.seatIndex, displayName: p.displayName, isAI: p.isAI, connected: p.connected, cardCount: p.hand.length, replacedByAI: false })), turnSeatIndex: state.turnSeatIndex, topDiscard: state.discardPile[state.discardPile.length - 1] ?? null, currentSuit: state.currentSuit, drawCount: state.drawPile.length, direction: state.direction, hasDrawn: state.hasDrawn, winnerSeatIndex: state.winnerSeatIndex, version: state.version, ruleset, mySeatIndex: me.seatIndex, isHost: true }, myHand: me.hand, phase: state.phase }; }
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase(); }
function delay(ms: number) { return new Promise<void>(resolve => window.setTimeout(resolve, ms)); }
function getGameIdFromPath() { const parts = window.location.pathname.split('/').filter(Boolean); const i = parts.indexOf('game'); return i >= 0 ? parts[i + 1] ?? null : null; }
function gamePath(id: string) { return `/game/${id}`; }
function friendlyError(message: string) { const map: Record<string, string> = { INVALID_PLAY: 'That card does not match the current suit or rank.', NOT_YOUR_TURN: 'It is not your turn.', ALREADY_DREW: 'You already drew a card this turn.', STALE_GAME_STATE: 'The table changed. Refreshing…', LOBBY_FULL: 'That lobby is full.', NOT_HOST: 'Only the host can do that.', INSUFFICIENT_PLAYERS: 'At least two players are required.' }; return map[message] ?? message; }
