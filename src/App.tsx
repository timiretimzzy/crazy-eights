import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ChangeEvent, CSSProperties, ReactNode } from 'react';
import type { Card, DeclareSuit, GameAction, GameState, Ruleset, Suit } from './engine/types.ts';
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

const SUIT_NAME: Record<Suit, string> = { hearts: 'Hearts', diamonds: 'Diamonds', clubs: 'Clubs', spades: 'Spades', jokers: 'Jokers' };

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

  const handleCreateLobby = async (maxSeats: number, ruleset: Ruleset) => {
    if (!supabaseConfigured) { setErrorMessage('Configure Supabase to create online friend games.'); return; }
    setBusy(true); setErrorMessage('');
    try {
      await ensureAnonymousSession();
      const created = await createLobby(mode, maxSeats, displayName.trim() || 'Player', ruleset);
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
    <div className="env" aria-hidden="true" />
    {screen === 'home' && <Home displayName={displayName} setDisplayName={setDisplayName} setScreen={setScreen} />}
    {screen === 'soloSetup' && <SoloSetup onStart={handleCreateSolo} busy={busy} back={() => setScreen('home')} />}
    {screen === 'createLobby' && <CreateLobby mode={mode} setMode={setMode} onCreate={handleCreateLobby} busy={busy} back={() => setScreen('home')} />}
    {screen === 'join' && gameId && <JoinGame gameId={gameId} displayName={displayName} setDisplayName={setDisplayName} onJoin={handleJoin} busy={busy} back={home} />}
    {screen === 'lobby' && snapshot && gameId && <Lobby snapshot={snapshot.publicState} gameId={gameId} onAction={async actionName => { setBusy(true); try { await lobbyAction(gameId, actionName); await loadGame(gameId); } catch (e) { setErrorMessage(e instanceof Error ? e.message : 'Lobby action failed.'); } finally { setBusy(false); } }} busy={busy} />}
    {screen === 'game' && snapshot && gameId && <GameView snapshot={snapshot} gameId={gameId} localState={localState} onLocalState={state => { setLocalState(state); setSnapshot(localSnapshot(state, snapshot.publicState.ruleset)); }} onSnapshot={setSnapshot} onFinish={() => setScreen('results')} setErrorMessage={setErrorMessage} />}
    {screen === 'results' && snapshot && gameId && <Results snapshot={snapshot.publicState} gameId={gameId} onRematch={async () => { if (snapshot.publicState.isHost && gameId !== 'local') { try { await playAgain(gameId); await loadGame(gameId); } catch (e) { setErrorMessage(e instanceof Error ? e.message : 'Could not reset the match.'); } } else if (gameId === 'local') { setScreen('home'); setSnapshot(null); setLocalState(null); } }} onHome={home} />}
    {errorMessage && <div className="toast" role="alert"><span>{friendlyError(errorMessage)}</span><button aria-label="Dismiss" onClick={() => setErrorMessage('')}>×</button></div>}
  </main>;
}

function Home({ displayName, setDisplayName, setScreen }: { displayName: string; setDisplayName: (v: string) => void; setScreen: (s: Screen) => void }) {
  const [rulesOpen, setRulesOpen] = useState(false);
  return <section className="screen home screen-enter">
    <div className="home-table-orb" aria-hidden="true"><div className="orb-rail" /><div className="orb-felt" /><span className="orb-card back" /><span className="orb-card front">8<span className="orb-suit">♠</span></span></div>
    <div className="brand-lockup"><span className="crest">CRAZY <i>EIGHTS</i></span><p className="tagline">Private high-stakes card room</p></div>
    <label className="name-field"><span>YOUR NAME</span><input maxLength={18} value={displayName} onChange={(e: ChangeEvent<HTMLInputElement>) => setDisplayName(e.target.value)} /><em>Shown to players at the table</em></label>
    <div className="home-actions">
      <button className="primary huge" onClick={() => setScreen('soloSetup')}><span><b>Play vs AI</b><small>Sit down and deal</small></span><span className="btn-arrow">→</span></button>
      <button className="secondary huge" onClick={() => setScreen('createLobby')}><span><b>Private Table</b><small>Invite friends to your room</small></span><span className="btn-arrow">+</span></button>
    </div>
    <button className="howto-link" onClick={() => setRulesOpen(true)}>How to play</button>
    {rulesOpen && <RulesModal onClose={() => setRulesOpen(false)} />}
  </section>;
}

function RulesModal({ onClose }: { onClose: () => void }) {
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="How to play"><div className="suit-modal rules-modal"><span className="eyebrow">THE TABLE RULES</span><h3>Crazy Eights</h3><ol className="rule-list"><li>Match the suit or rank of the top discard, or draw a card.</li><li>Play an <b>8</b> any time to change the active suit — then name a new suit.</li><li><b>Jokers</b> are wild and force the next player to <b>pick up 5</b>.</li><li>A <b>2</b> adds 2 to a pickup; an <b>Ace</b> blocks the whole pile and grants an extra play; a <b>King</b> lets you play exactly once more.</li><li>A <b>7</b> skips the next player; a <b>Jack</b> reverses the table (swap-able in house rules).</li><li>Only <b>3–6, 9, 10, Q</b> may start or finish a hand by default.</li><li>Clear your hand first to take the table.</li></ol><button className="primary" onClick={onClose}>Back to the room</button></div></div>;
}

function JoinGame({ gameId, displayName, setDisplayName, onJoin, busy, back }: { gameId: string; displayName: string; setDisplayName: (v: string) => void; onJoin: () => Promise<void>; busy: boolean; back: () => void }) {
  return <section className="screen setup-panel screen-enter">
    <button className="back" onClick={back}>← Home</button>
    <span className="eyebrow">INVITATION</span><h2 className="display">A seat<br /><span>is waiting.</span></h2>
    <p className="helper">Table {tableCode(gameId)} has a seat open for you. Choose the name the room will see.</p>
    <label className="name-field"><span>YOUR NAME</span><input maxLength={18} value={displayName} onChange={(e: ChangeEvent<HTMLInputElement>) => setDisplayName(e.target.value)} /></label>
    <button className="primary huge" disabled={busy} onClick={() => void onJoin()}>{busy ? 'Taking your seat…' : 'Join the table'} <span className="btn-arrow">→</span></button>
  </section>;
}

function HouseRules({ ruleset, onChange }: { ruleset: Ruleset; onChange: (r: Ruleset) => void }) {
  const flag = (key: 'jokerEnabled' | 'aceBlocksPickup' | 'kingCarryOn', label: string) => (
    <label className="rule-toggle"><input type="checkbox" checked={ruleset[key]} onChange={e => onChange({ ...ruleset, [key]: e.target.checked })} /><span>{label}</span></label>
  );
  const restricted = ruleset.restrictedFirstCards && ruleset.restrictedWinningCards;
  return <div className="rules-panel"><details className="rules-accordion"><summary>House rules</summary><div className="rules-grid">
    {flag('jokerEnabled', 'Jokers in the deck (+5 pickup)')}
    {flag('aceBlocksPickup', 'Aces block pickups')}
    {flag('kingCarryOn', 'Kings let you play again')}
    <label className="rule-toggle"><input type="checkbox" checked={ruleset.sevenAction === 'skip'} onChange={e => onChange({ ...ruleset, sevenAction: e.target.checked ? 'skip' : 'reverse', jackAction: e.target.checked ? 'reverse' : 'skip' })} /><span>7 skips · Jack reverses</span></label>
    <label className="rule-toggle"><input type="checkbox" checked={restricted} onChange={e => onChange({ ...ruleset, restrictedFirstCards: e.target.checked, restrictedWinningCards: e.target.checked })} /><span>Restricted start &amp; win cards (3–6, 9, 10, Q)</span></label>
  </div><p className="helper small">Defaults: Jokers +5, Ace block, King extra play, restricted starts &amp; wins.</p></details></div>;
}

function SoloSetup({ onStart, busy, back }: { onStart: (n: number, ruleset: Ruleset) => Promise<void>; busy: boolean; back: () => void }) {
  const [opponents, setOpponents] = useState(3);
  const [ruleset, setRuleset] = useState<Ruleset>(DEFAULT_RULESET);
  return <section className="screen setup-panel screen-enter">
    <button className="back" onClick={back}>← Back</button>
    <span className="eyebrow">PRIVATE GAME</span><h2 className="display">Pick your<br /><span>opponents.</span></h2>
    <div className="stepper"><button aria-label="Fewer opponents" onClick={() => setOpponents(n => Math.max(1, n - 1))}>−</button><div><strong>{opponents}</strong><span>dealer bots</span></div><button aria-label="More opponents" onClick={() => setOpponents(n => Math.min(5, n + 1))}>+</button></div>
    <div className="mini-table">
      {Array.from({ length: opponents + 1 }, (_, i) => <span key={i} className={`seat-chip ${i === 0 ? 'me' : ''}`}>{i === 0 ? 'YOU' : <><i className="bot" />BOT {i}</>}</span>).reverse()}
    </div>
    <HouseRules ruleset={ruleset} onChange={setRuleset} />
    <button className="primary huge" disabled={busy} onClick={() => void onStart(opponents, ruleset)}>{busy ? 'Dealing…' : 'Deal the cards'} <span className="btn-arrow">→</span></button>
  </section>;
}

function CreateLobby({ mode, setMode, onCreate, busy, back }: { mode: 'mixed' | 'humans_only'; setMode: (v: 'mixed' | 'humans_only') => void; onCreate: (n: number, ruleset: Ruleset) => Promise<void>; busy: boolean; back: () => void }) {
  const [seats, setSeats] = useState(4);
  const [ruleset, setRuleset] = useState<Ruleset>(DEFAULT_RULESET);
  return <section className="screen setup-panel screen-enter">
    <button className="back" onClick={back}>← Back</button>
    <span className="eyebrow">PRIVATE ROOM</span><h2 className="display">Build your<br /><span>table.</span></h2>
    <div className="segmented"><button className={mode === 'mixed' ? 'active' : ''} onClick={() => setMode('mixed')}>Mixed</button><button className={mode === 'humans_only' ? 'active' : ''} onClick={() => setMode('humans_only')}>Humans only</button></div>
    <label className="range-field"><span>GUESTS</span><div className="range-row"><input type="range" min="2" max="6" value={seats} onChange={(e: ChangeEvent<HTMLInputElement>) => setSeats(Number(e.target.value))} /><strong>{seats}</strong></div></label>
    <p className="helper">{mode === 'mixed' ? 'The dealer fills empty seats with bots when the game starts.' : 'The table shrinks to exactly the guests who show up.'}</p>
    <HouseRules ruleset={ruleset} onChange={setRuleset} />
    <button className="primary huge" disabled={busy} onClick={() => void onCreate(seats, ruleset)}>{busy ? 'Opening…' : 'Open the table'} <span className="btn-arrow">→</span></button>
  </section>;
}

function Lobby({ snapshot, gameId, onAction, busy }: { snapshot: PublicGameState; gameId: string; onAction: (a: 'start_game' | 'add_ai' | 'remove_ai') => Promise<void>; busy: boolean }) {
  const [copied, setCopied] = useState(false);
  const shareUrl = `${window.location.origin}${gamePath(gameId)}`;
  const seats = Array.from({ length: snapshot.maxSeats }, (_, i) => snapshot.players.find(p => p.seatIndex === i));
  const copy = async () => { try { await navigator.clipboard.writeText(shareUrl); setCopied(true); window.setTimeout(() => setCopied(false), 1400); } catch { /* ignored */ } };
  const share = () => { const text = `Join me at the Crazy Eights table — Table ${tableCode(gameId)}`; window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(shareUrl)}`, '_blank', 'noopener,noreferrer'); };
  return <section className="screen lobby screen-enter">
    <div className="lobby-head"><div><span className="eyebrow">PRIVATE TABLE</span><h2>Table<br /><span className="table-code">{tableCode(gameId)}</span></h2></div><div className="lobby-count"><b>{snapshot.players.length}<i>/</i>{snapshot.maxSeats}</b><small>at the table</small></div></div>
    <div className="seat-list">
      {seats.map((player, i) => <div key={i} className={`lobby-seat ${player ? 'filled' : 'open'}`}><span className="seat-num">{i + 1}</span><span className="seat-avatar">{player ? (player.isAI ? <i className="bot" /> : initials(player.displayName)) : <i className="open-seat" />}</span><span className="seat-name">{player ? player.displayName : 'Open seat'}</span>{player?.isAI && <span className="bot-tag">BOT</span>}<span className="seat-status">{player ? (player.seatIndex === 0 ? 'HOST' : 'READY') : 'OPEN'}</span></div>)}
    </div>
    <div className="invite-card"><div><small>INVITE LINK</small><code>{shareUrl}</code></div><button className="secondary" disabled={busy} onClick={() => void copy()}>{copied ? 'Copied' : 'Copy'}</button><button className="icon-btn" aria-label="Share on X" onClick={share}>X</button></div>
    <div className="lobby-actions">{snapshot.mode === 'mixed' && <button className="secondary" disabled={busy || snapshot.players.length >= snapshot.maxSeats} onClick={() => void onAction('add_ai')}>+ Add bot</button>}<button className="primary" disabled={busy || snapshot.players.length < 2} onClick={() => void onAction('start_game')}><span><b>Deal the cards</b><small>{snapshot.players.length < 2 ? 'waiting for guests…' : `${snapshot.players.length} players ready`}</small></span><span className="btn-arrow">→</span></button></div>
    <p className="helper center">Seats lock once the dealer calls the game.</p>
  </section>;
}

function GameView({ snapshot, gameId, localState, onLocalState, onSnapshot, onFinish, setErrorMessage }: { snapshot: GameSnapshot; gameId: string; localState: GameState | null; onLocalState: (s: GameState) => void; onSnapshot: (s: GameSnapshot) => void; onFinish: () => void; setErrorMessage: (s: string) => void }) {
  const [loading, setLoading] = useState(false);
  const [suitOpen, setSuitOpen] = useState(snapshot.phase === 'DECLARING_SUIT');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [dealing, setDealing] = useState(false);
  const [dealCards, setDealCards] = useState<DealCard[]>([]);
  const [flights, setFlights] = useState<Flight[]>([]);
  const shellRef = useRef<HTMLElement | null>(null);
  const deckRef = useRef<HTMLButtonElement | null>(null);
  const discardRef = useRef<HTMLDivElement | null>(null);
  const handRef = useRef<HTMLDivElement | null>(null);
  const seatRefs = useRef<Record<number, HTMLDivElement | null>>({});
  const lastVersion = useRef(snapshot.publicState.version);
  const prevSnap = useRef<GameSnapshot | null>(null);
  const dealtFor = useRef<string | null>(null);
  const prevStatus = useRef<string | null>(snapshot.publicState.status);
  const localMode = gameId === 'local';
  const myTurn = snapshot.publicState.turnSeatIndex === snapshot.publicState.mySeatIndex;
  const topDiscard = snapshot.publicState.topDiscard as Card | null;
  const pickupActive = snapshot.publicState.pendingPickup > 0;
  const pickupN = snapshot.publicState.pendingPickup;

  useEffect(() => { if (snapshot.publicState.status === 'finished') onFinish(); }, [snapshot.publicState.status, onFinish]);
  useEffect(() => { if (snapshot.phase === 'DECLARING_SUIT') setSuitOpen(true); }, [snapshot.phase]);
  useEffect(() => { if (!myTurn) setSelectedId(null); }, [myTurn]);

  const rectOf = (el: Element | null | undefined) => { if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

  const pushFlight = (f: Flight) => {
    setFlights(list => [...list, f]);
    window.setTimeout(() => setFlights(list => list.filter(x => x.key !== f.key)), f.duration + 100);
  };

  useLayoutEffect(() => {
    const st = snapshot.publicState.status;
    if (st === 'active' && prevStatus.current !== 'active' && dealtFor.current !== snapshot.publicState.gameId) {
      dealtFor.current = snapshot.publicState.gameId;
      const shell = shellRef.current;
      const targets: DealCard[] = [];
      let seq = 0;
      const push = (seatIndex: number, count: number, kind: DealCard['kind']) => {
        const rect = kind === 'hand'
          ? rectOf(handRef.current)
          : (kind === 'discard' ? rectOf(discardRef.current) : rectOf(seatRefs.current[seatIndex]));
        const center = rect ? { x: rect.x, y: rect.y } : { x: window.innerWidth / 2, y: window.innerHeight * 0.45 };
        for (let k = 0; k < count; k += 1) {
          targets.push({ key: `deal-${seq}`, kind, x0: center.x, y0: center.y, delay: 260 + seq * 55 });
          seq += 1;
        }
      };
      if (shell) {
        snapshot.publicState.players.forEach(p => { if (p.seatIndex === snapshot.publicState.mySeatIndex) { if (snapshot.myHand.length) push(p.seatIndex, snapshot.myHand.length, 'hand'); } else if (p.cardCount) push(p.seatIndex, p.cardCount, 'seat'); });
        if (topDiscard) push(-1, 1, 'discard');
      }
      setDealCards(targets);
      const total = Math.max(1400, targets.length > 0 ? targets[targets.length - 1].delay + 450 : 1400) + 220;
      setDealing(true);
      window.setTimeout(() => { setDealing(false); setDealCards([]); }, total);
    }
    prevStatus.current = st;
  }, [snapshot.publicState.status, snapshot.publicState.gameId, snapshot.myHand.length, snapshot.publicState.players, topDiscard]);

  useEffect(() => {
    const cur = snapshot.publicState;
    const prev = prevSnap.current;
    if (prev) {
      const key = `${cur.gameId}:${cur.version}`;
      if (key !== `${prev.publicState.gameId}:${prev.publicState.version}`) {
        if (snapshot.myHand.length > prev.myHand.length && cur.turnSeatIndex === cur.mySeatIndex) {
          const drawn = snapshot.myHand[snapshot.myHand.length - 1];
          const a = rectOf(deckRef.current) ?? { x: window.innerWidth / 2, y: 0 };
          const b = rectOf(handRef.current) ?? { x: window.innerWidth / 2, y: window.innerHeight };
          if (drawn) pushFlight({ key: `draw-${cur.version}`, faceUp: true, card: drawn, from: a, to: b, duration: 460 });
        } else if (prev.publicState.topDiscard && cur.topDiscard && cur.topDiscard.id !== prev.publicState.topDiscard.id && prev.publicState.turnSeatIndex !== cur.mySeatIndex) {
          const from = (prev.publicState.turnSeatIndex ?? null) !== null
            ? rectOf(seatRefs.current[prev.publicState.turnSeatIndex as number])
            : rectOf(deckRef.current);
          const a = from ?? { x: window.innerWidth / 2, y: 0 };
          const b = rectOf(discardRef.current) ?? { x: window.innerWidth / 2, y: window.innerHeight * 0.45 };
          pushFlight({ key: `play-${cur.version}`, faceUp: false, card: null, from: a, to: b, duration: 520 });
        } else if (cur.drawCount < prev.publicState.drawCount && cur.turnSeatIndex === prev.publicState.turnSeatIndex && cur.turnSeatIndex !== cur.mySeatIndex) {
          const to = rectOf(seatRefs.current[cur.turnSeatIndex as number]) ?? { x: window.innerWidth / 2, y: 0 };
          const a = rectOf(deckRef.current) ?? { x: window.innerWidth / 2, y: 0 };
          pushFlight({ key: `ai-draw-${cur.version}`, faceUp: false, card: null, from: a, to, duration: 480 });
        }
      }
    }
    prevSnap.current = snapshot;
  }, [snapshot]);

  const act = async (gameAction: GameAction) => {
    setLoading(true); setErrorMessage(''); setSelectedId(null);
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

  const playCard = (card: Card, el?: HTMLElement) => {
    if (!myTurn || loading || dealing) return;
    const playable = topDiscard ? isPlayable(card, topDiscard, snapshot.publicState.currentSuit, snapshot.publicState.ruleset) : false;
    if (!playable) return;
    if (!selectedId || selectedId !== card.id) {
      setSelectedId(card.id);
      return;
    }
    const a = rectOf(el) ?? rectOf(handRef.current) ?? { x: window.innerWidth / 2, y: window.innerHeight };
    const b = rectOf(discardRef.current) ?? { x: window.innerWidth / 2, y: 0 };
    pushFlight({ key: `me-${snapshot.publicState.version}`, faceUp: true, card, from: a, to: b, duration: 420 });
    void act({ type: 'PLAY_CARD', cardId: card.id });
  };

  const spots: { left: number; top: number }[] = snapshot.publicState.players.map(p => seatAnchor(p.seatIndex, snapshot.publicState.players.length, snapshot.publicState.mySeatIndex));
  const activeSeat = snapshot.publicState.turnSeatIndex != null ? snapshot.publicState.players.findIndex(p => p.seatIndex === snapshot.publicState.turnSeatIndex) : -1;
  const activeIsMe = activeSeat >= 0 && snapshot.publicState.players[activeSeat]?.seatIndex === snapshot.publicState.mySeatIndex;

  return <section ref={shellRef} className={`game-shell ${dealing ? 'dealing' : ''} ${myTurn ? 'my-turn' : ''}`}>
    <div className="table-zone" aria-hidden="true"><div className="table-felt" /><div className="table-rim" /><div className="felt-light" /><div className="felt-vignette" /></div>
    <div className="players-ring">
      {snapshot.publicState.players.map((player, i) => {
        const spot = spots[i];
        const isActive = i === activeSeat;
        const isMe = player.seatIndex === snapshot.publicState.mySeatIndex;
        return <div key={player.seatIndex} ref={el => { seatRefs.current[player.seatIndex] = el ?? null; }} className={`player-seat ${isActive ? 'active' : ''} ${isMe ? 'is-me' : ''}`} style={{ left: `${spot.left}%`, top: `${spot.top}%` }}>
          <div className="avatar">{player.isAI ? <i className="bot" /> : initials(player.displayName)}</div>
          <div className="player-name" aria-label={player.displayName}>{isMe ? 'YOU' : player.displayName}</div>
          <div className="player-cards">{Array.from({ length: Math.min(player.cardCount, 5) }, (_, i) => <span key={i} />)}<b>{player.cardCount}</b></div>
          {isActive && !isMe && <div className="active-pill">{player.isAI ? 'THINKING' : 'TURN'}</div>}
        </div>;
      })}
    </div>
    <div className="spotlight-layer" aria-hidden="true">{activeSeat >= 0 && <div className={`seat-spot ${activeIsMe ? 'me' : ''}`} style={{ left: `${spots[activeSeat].left}%`, top: `${spots[activeSeat].top}%` }} />}</div>
    <div className="center-table">
      <button ref={deckRef} className="deck-stack" disabled={!myTurn || loading || dealing || snapshot.publicState.hasDrawn || pickupActive} onClick={() => { void act({ type: 'DRAW_CARD' }); }} aria-label="Draw a card">
        <span className="card-back"><svg viewBox="0 0 60 88" className="back-art"><rect x="5.5" y="5.5" width="49" height="77" rx="7" className="back-frame" /><rect x="10" y="10" width="40" height="68" rx="5" className="back-inner" /><path d="M30 26 L42 44 L30 62 L18 44 Z" className="back-emblem" /><path d="M30 49 L37 60 L30 71 L23 60 Z" className="back-emblem-s" /></svg></span>
        <small>{snapshot.publicState.hasDrawn ? 'DRAWN' : (pickupActive ? '' : 'DRAW')}</small><em>{snapshot.publicState.drawCount}</em>
      </button>
      <div className="table-hud-sep" />
      <div ref={discardRef} className="discard-slot">{topDiscard ? <CardFace key={topDiscard.id} card={topDiscard} /> : <div className="empty-pile" />}</div>
      {snapshot.publicState.currentSuit && <div className="active-suit"><span>ACTIVE</span><strong><SuitIcon suit={snapshot.publicState.currentSuit} /> {SUIT_NAME[snapshot.publicState.currentSuit]}</strong></div>}
    </div>
    <div className="hud-top"><div><span className="eyebrow">TABLE {tableCode(snapshot.publicState.gameId)}</span><div className={`turn-copy ${myTurn ? 'active' : ''}`}>{myTurn ? 'YOUR TURN' : turnCopy(snapshot)}</div></div>{myTurn && <div className="your-turn-badge">YOUR TURN</div>}</div>
    {pickupActive && <div className="pickup-banner"><span className="eyebrow">THE TABLE DEMANDS</span><strong>PICK UP <b>{pickupN}</b></strong><button className="primary" disabled={loading || !myTurn} onClick={() => void act({ type: 'RESOLVE_PICKUP' })}>Pick up {pickupN}</button><small>Ace, 2, or Joker answers the call…</small></div>}
    {!pickupActive && myTurn && snapshot.publicState.carryOn && <div className="carry-banner"><span className="eyebrow">KING’S ORDERS</span><strong>CARRY ON</strong><small>You may play again.</small></div>}
    <div className="hand-area">
      <div className="hand-label"><span>Your hand</span><span>{snapshot.myHand.length} cards</span></div>
      <div ref={handRef} className="hand">
{snapshot.myHand.map((card, i) => {
          const playable = topDiscard ? isPlayable(card, topDiscard, snapshot.publicState.currentSuit, snapshot.publicState.ruleset, { pendingPickup: snapshot.publicState.pendingPickup }) : false;
          const sel = selectedId === card.id;
          return <button key={card.id} className={`hand-card ${myTurn && playable ? 'playable-hint' : 'not-playable'} ${pickupActive && playable ? 'pickup-responder' : ''} ${sel ? 'is-selected' : ''}`} style={{ '--i': i, '--n': snapshot.myHand.length } as CSSProperties} disabled={!myTurn || loading || dealing} aria-pressed={sel} aria-label={`${card.rank} of ${card.suit}`} onClick={e => playCard(card, e.currentTarget)}><CardFace card={card} /></button>;
        })}
      </div>
      <div className="hand-actions">
        {selectedId && myTurn && <button className="primary play-btn" disabled={loading} onClick={() => { const c = snapshot.myHand.find(x => x.id === selectedId); if (c) playCard(c); }}><span className="btn-arrow">▶</span>Play card</button>}
        {myTurn && !pickupActive && !selectedId && snapshot.publicState.hasDrawn && <button className="secondary end-turn" disabled={loading || dealing} onClick={() => void act({ type: 'END_TURN' })}>Keep card · End turn</button>}
      </div>
      {myTurn && <div className="turn-help">{pickupActive ? `The table demands ${pickupN}. Match with an Ace, a 2, or a Joker, or pick them up.` : selectedId ? 'Your card is raised. Tap it again or press Play.' : snapshot.publicState.hasDrawn ? 'Play the drawn card, or keep it and end your turn.' : snapshot.publicState.carryOn ? 'Carry on: play again after that King.' : 'Tap a matching card to raise it, or draw from the deck.'}</div>}
      {localMode && myTurn && !pickupActive && !selectedId && !snapshot.publicState.hasDrawn && !snapshot.myHand.some(c => topDiscard != null && isPlayable(c, topDiscard, snapshot.publicState.currentSuit, snapshot.publicState.ruleset, { pendingPickup: snapshot.publicState.pendingPickup })) && <button className="secondary end-turn" disabled={loading || dealing} onClick={() => void act({ type: 'DRAW_CARD' })}>Draw a card</button>}
    </div>
    {dealing && dealCards.length > 0 && <div className="deal-fx" aria-hidden="true">{dealCards.map(d => <span key={d.key} className="deal-card" style={{ '--dx': `${d.x0 - window.innerWidth / 2}px`, '--dy': `${d.y0 - window.innerHeight * 0.42}px`, '--delay': `${d.delay}ms` } as CSSProperties}><span className="card-back small"><svg viewBox="0 0 60 88" className="back-art"><rect x="5.5" y="5.5" width="49" height="77" rx="7" className="back-frame" /><rect x="10" y="10" width="40" height="68" rx="5" className="back-inner" /><path d="M30 26 L42 44 L30 62 L18 44 Z" className="back-emblem" /><path d="M30 49 L37 60 L30 71 L23 60 Z" className="back-emblem-s" /></svg></span></span>)}</div>}
    {flights.length > 0 && <div className="fly-fx" aria-hidden="true">{flights.map(f => <span key={f.key} className={`fly-card ${f.faceUp ? 'face-up' : 'back'}`} style={{ '--fx': `${f.from.x}px`, '--fy': `${f.from.y}px`, '--tx': `${f.to.x}px`, '--ty': `${f.to.y}px`, '--dur': `${f.duration}ms` } as CSSProperties}>{f.faceUp && f.card ? <CardFace card={f.card} /> : <span className="card-back small"><svg viewBox="0 0 60 88" className="back-art"><rect x="5.5" y="5.5" width="49" height="77" rx="7" className="back-frame" /><rect x="10" y="10" width="40" height="68" rx="5" className="back-inner" /><path d="M30 26 L42 44 L30 62 L18 44 Z" className="back-emblem" /><path d="M30 49 L37 60 L30 71 L23 60 Z" className="back-emblem-s" /></svg></span>}</span>)}</div>}
    {suitOpen && <SuitModal onPick={async suit => { setSuitOpen(false); await act({ type: 'DECLARE_SUIT', suit }); }} />}
    {loading && <div className="processing">Updating table…</div>}
  </section>;
}

function turnCopy(s: GameSnapshot) {
  const p = s.publicState.players.find(x => x.seatIndex === s.publicState.turnSeatIndex);
  if (!p) return 'Waiting…';
  if (p.seatIndex === s.publicState.mySeatIndex) return 'Your turn';
  return p.isAI ? `${p.displayName} is thinking…` : `${p.displayName.toUpperCase()}'S TURN`;
}

function seatAnchor(seatIndex: number, total: number, me: number): { left: number; top: number } {
  if (seatIndex === me) return { left: 50, top: 88 };
  const others = Array.from({ length: total }, (_, i) => i).filter(i => i !== me);
  const pos = others.indexOf(seatIndex);
  const edge = Math.min(176, Math.max(58, window.innerWidth * 0.115));
  const l = Math.round((edge / window.innerWidth) * 1000) / 10;
  const r = 100 - l;
  const tables: Record<number, Array<{ left: number; top: number }>> = {
    2: [{ left: 50, top: 14 }],
    3: [{ left: l, top: 22 }, { left: r, top: 22 }],
    4: [{ left: 50, top: 12 }, { left: l, top: 44 }, { left: r, top: 44 }],
    5: [{ left: l, top: 15 }, { left: r, top: 15 }, { left: l, top: 50 }, { left: r, top: 50 }],
    6: [{ left: 50, top: 10 }, { left: l, top: 29 }, { left: r, top: 29 }, { left: l, top: 58 }, { left: r, top: 58 }],
  };
  const list = tables[total > 6 ? 6 : total] ?? [{ left: 50, top: 30 }];
  return list[Math.max(0, Math.min(pos, list.length - 1))] ?? { left: 50, top: 30 };
}

type DealCard = { key: string; kind: 'hand' | 'seat' | 'discard'; x0: number; y0: number; delay: number };
type Flight = { key: string; faceUp: boolean; card: Card | null; from: { x: number; y: number }; to: { x: number; y: number }; duration: number };

function CardFace({ card, mini }: { card: Card; mini?: boolean }) {
  if (card.suit === 'jokers') {
    return <div className={`card-face joker ${mini ? 'mini' : ''}`}><b className="corner tl"><SuitIcon suit="jokers" /></b><span className="joker-glyph">✦</span><b className="corner br"><SuitIcon suit="jokers" /></b></div>;
  }
  const red = card.suit === 'hearts' || card.suit === 'diamonds';
  return <div className={`card-face ${red ? 'red' : ''} ${mini ? 'mini' : ''}`}>
    <b className="corner tl"><span className="rank">{card.rank}</span><SuitIcon suit={card.suit} /></b>
    <SuitIcon suit={card.suit} className="center-suit" />
    <b className="corner br"><span className="rank">{card.rank}</span><SuitIcon suit={card.suit} /></b>
  </div>;
}

function SuitIcon({ suit, className }: { suit: Suit; className?: string }) {
  return <svg viewBox="0 0 24 24" className={`suit-icon ${className ?? ''}`} aria-hidden="true">{SUIT_PATHS[suit]}</svg>;
}

const SUIT_PATHS: Record<Suit, ReactNode> = {
  hearts: <path d="M12 20.6C7.6 17 3.4 13.7 2.4 9.9 1.6 6.9 3.6 4 6.6 4c1.9 0 3.4 1 4.6 2.7C12.4 5 13.9 4 15.8 4c3 0 5 2.9 4.2 5.9-.9 3.8-5.1 7.1-9.5 10.6a.9.9 0 0 1-1.5.1z" />,
  diamonds: <path d="M12 2.3c1.9 2.9 4.1 4.8 6.9 9.7-2.8 4.9-5 6.8-6.9 9.7-1.9-2.9-4.1-4.8-6.9-9.7 2.8-4.9 5-6.8 6.9-9.7z" />,
  clubs: <path d="M9.1 16.4c0-1.5.6-2.9 1.7-4.1a3.3 3.3 0 1 1 4.5-.1 5.4 5.4 0 0 1 .8 4.2l-1.5-.5c-.3 1-.7 1.9-1.4 2.6 1.2.4 2.4 1.2 3.3 2.4H8.5c.9-1.2 2.1-2 3.3-2.4a5.6 5.6 0 0 1-1.4-2.6l-1.3.5z" />,
  spades: <path d="M12 3c3.8 3 6.9 5.8 7.9 8.7a3.7 3.7 0 0 1-2.1 4.6c.1-1.6-.7-3-1.7-3.6V23h-8.2v-10.2c-1 .5-1.8 2-1.7 3.6a3.7 3.7 0 0 1-2.1-4.6C6 8.8 9.2 6 12 3z" />,
  jokers: <path d="M12 4c1.6 2.4 4.4 3.6 6.8 2.4-.2 2.7 1.1 5.3 3.2 6.6-2.1 1.3-3.4 3.9-3.2 6.6-2.4-1.2-5.2 0-6.8 2.4-1.6-2.4-4.4-3.6-6.8-2.4.2-2.7-1.1-5.3-3.2-6.6 2.1-1.3 3.4-3.9 3.2-6.6 2.4 1.2 5.2 0 6.8-2.4z" />,
};

function SuitModal({ onPick }: { onPick: (s: DeclareSuit) => Promise<void> }) {
  return <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Choose a suit"><div className="suit-modal"><span className="eyebrow">WILD EIGHT</span><h3>Choose a suit</h3><div className="suit-grid">{SUITS.map(s => <button key={s} className={s === 'hearts' || s === 'diamonds' ? 'red-suit' : ''} onClick={() => void onPick(s)}><SuitIcon suit={s} /><small>{SUIT_NAME[s]}</small></button>)}</div></div></div>;
}

function Results({ snapshot, gameId, onRematch, onHome }: { snapshot: PublicGameState; gameId: string; onRematch: () => Promise<void>; onHome: () => void }) {
  const winner = snapshot.players.find(p => p.seatIndex === snapshot.winnerSeatIndex);
  const youWon = winner?.seatIndex === snapshot.mySeatIndex;
  const share = () => { const text = `I took the table at Crazy Eights. Think you can beat me?`; const url = window.location.origin; window.open(`https://twitter.com/intent/tweet?text=${encodeURIComponent(text)}&url=${encodeURIComponent(url)}`, '_blank', 'noopener,noreferrer'); };
  return <section className="screen results screen-enter">
    <div className="result-halo" aria-hidden="true" />
    <div className="winner-mark"><span>8</span><i /></div>
    <span className="eyebrow">THE TABLE CROWNS</span>
    <h2 className="display">{youWon ? 'You' : (winner?.displayName ?? 'Someone')}<br /><span>Takes the table.</span></h2>
    <p>{youWon ? 'The chips are yours. Not bad at all.' : `${winner?.displayName ?? 'Someone'} cleared the hand first.`}</p>
    <div className="results-actions">
      <button className="primary huge" disabled={!snapshot.isHost && gameId !== 'local'} onClick={() => void onRematch()}><span><b>Play again</b><small>{gameId === 'local' || snapshot.isHost ? 'Deal a new hand' : 'Waiting on the host…'}</small></span><span className="btn-arrow">→</span></button>
      <button className="secondary huge" onClick={share}><span><b>Share result</b><small>Send it to the room</small></span><span className="btn-arrow">↗</span></button>
      <button className="secondary huge" onClick={onHome}><span><b>Back to lobby</b><small>Leave the table</small></span><span className="btn-arrow">←</span></button>
    </div>
  </section>;
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

function localSnapshot(state: GameState, ruleset: Ruleset): GameSnapshot { const me = state.players.find(p => !p.isAI)!; return { publicState: { gameId: 'local', mode: 'solo_ai', status: state.phase === 'FINISHED' ? 'finished' : 'active', maxSeats: state.players.length, players: state.players.map(p => ({ seatIndex: p.seatIndex, displayName: p.displayName, isAI: p.isAI, connected: p.connected, cardCount: p.hand.length, replacedByAI: false })), turnSeatIndex: state.turnSeatIndex, topDiscard: state.discardPile[state.discardPile.length - 1] ?? null, currentSuit: state.currentSuit, drawCount: state.drawPile.length, direction: state.direction, hasDrawn: state.hasDrawn, pendingPickup: state.pendingPickup, carryOn: state.carryOn, winnerSeatIndex: state.winnerSeatIndex, version: state.version, ruleset, mySeatIndex: me.seatIndex, isHost: true }, myHand: me.hand, phase: state.phase }; }
function initials(name: string) { return name.split(/\s+/).slice(0, 2).map(s => s[0]).join('').toUpperCase(); }
function delay(ms: number) { return new Promise<void>(resolve => window.setTimeout(resolve, ms)); }
function getGameIdFromPath() { const parts = window.location.pathname.split('/').filter(Boolean); const i = parts.indexOf('game'); return i >= 0 ? parts[i + 1] ?? null : null; }
function gamePath(id: string) { return `/game/${id}`; }
function tableCode(id: string) { return id.toUpperCase().slice(0, 4); }
function friendlyError(message: string) { const map: Record<string, string> = { INVALID_PLAY: 'That card does not match the current suit or rank.', NOT_YOUR_TURN: 'It is not your turn.', ALREADY_DREW: 'You already drew a card this turn.', STALE_GAME_STATE: 'The table changed. Refreshing…', LOBBY_FULL: 'That lobby is full.', NOT_HOST: 'Only the host can do that.', INSUFFICIENT_PLAYERS: 'At least two players are required.' }; return map[message] ?? message; }