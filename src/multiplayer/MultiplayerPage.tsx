import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { io, type Socket } from 'socket.io-client';
import { MAX_GUESSES, RATED_LEVELS } from '../../shared/game-rules.js';
import { getPlayerId } from '../api/client';
import { GuessCard } from '../components/GuessCard';
import { KnownClues } from '../components/KnownClues';
import { ResultBanner } from '../components/ResultBanner';
import { ScreenshotHint } from '../components/ScreenshotHint';
import { SearchBox } from '../components/SearchBox';
import { TopBar } from '../components/TopBar';
import { loadGames } from '../data/games';
import { currencyFor } from '../lib/format';
import { summarize } from '../play/knowledge';
import type { HintState } from '../play/progress';
import type { Game } from '../types/game';
import type { Ack, GuessResult, MultiplayerSettings, RoomSnapshot, RoundEnd } from './types';
import './multiplayer.css';

const SESSION_KEY = 'steamguess-multiplayer-session-v1';
const NAME_KEY = 'steamguess-display-name';
const commandId = () => `command_${crypto.randomUUID()}`;

type Identity = { roomCode: string; playerId: string; resumeToken: string };
type JoinResponse = { room: RoomSnapshot; playerId: string; resumeToken: string };

function emit<T>(socket: Socket, event: string, payload: object): Promise<Ack<T>> {
  return new Promise(resolve => socket.timeout(8000).emit(event, payload, (error: Error | null, response: Ack<T>) => {
    resolve(error ? { ok: false, error: { code: 'TIMEOUT', message: '' } } : response);
  }));
}

/** The hint state is private to each player and survives a reload within the round. */
function RoundScreenshot({ roundId, urls, ended }: { roundId: string; urls: string[]; ended: boolean }) {
  const key = `steamguess-mp-hint:${roundId}`;
  const [state, setState] = useState<HintState>(() => {
    try { const saved = sessionStorage.getItem(key); return saved === 'blurred' || saved === 'clear' ? saved : 'hidden'; } catch { return 'hidden'; }
  });
  return <ScreenshotHint urls={urls} state={state} ended={ended} onChange={next => {
    setState(next);
    try { sessionStorage.setItem(key, next); } catch { /* Optional progress. */ }
  }} />;
}

function SettingsFields({ value, onChange }: { value: MultiplayerSettings; onChange: (next: MultiplayerSettings) => void }) {
  const { t } = useTranslation();
  return <div className="mp-fields">
    <label>{t('mp.difficulty')}
      <select value={value.difficulty} onChange={event => onChange({ ...value, difficulty: event.target.value as MultiplayerSettings['difficulty'] })}>
        {RATED_LEVELS.map(level => <option key={level} value={level}>{t(`level.${level}`)}</option>)}
      </select>
    </label>
    <label>{t('mp.format')}
      <select value={value.bestOf} onChange={event => onChange({ ...value, bestOf: Number(event.target.value) as 1 | 3 | 5 })}>
        <option value="1">{t('mp.single')}</option>
        <option value="3">{t('mp.bestOf', { count: 3, wins: 2 })}</option>
        <option value="5">{t('mp.bestOf', { count: 5, wins: 3 })}</option>
      </select>
    </label>
    <label>{t('mp.seats')}
      <select value={value.maxPlayers} onChange={event => onChange({ ...value, maxPlayers: Number(event.target.value) })}>
        {[2, 3, 4, 5, 6, 7, 8].map(count => <option key={count} value={count}>{t('mp.seatCount', { count })}</option>)}
      </select>
    </label>
  </div>;
}

export default function MultiplayerPage() {
  const { t, i18n } = useTranslation();
  const socketRef = useRef<Socket | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(() => {
    try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null') as Identity | null; } catch { return null; }
  });
  const resumeIdentityRef = useRef(identity);
  const stablePlayerId = useMemo(() => getPlayerId(), []);
  const [displayName, setDisplayName] = useState(() => { try { return localStorage.getItem(NAME_KEY) || ''; } catch { return ''; } });
  const [roomCode, setRoomCode] = useState(() => new URLSearchParams(window.location.search).get('room')?.toUpperCase() ?? '');
  // The room compares prices in the host's currency, fixed when the room is created.
  const [settings, setSettings] = useState<MultiplayerSettings>(() => ({ difficulty: 'normal', bestOf: 1, maxPlayers: 4, roundTimeSeconds: 120, currency: currencyFor(i18n.language) }));
  const [connected, setConnected] = useState(false);
  const [resuming, setResuming] = useState(() => Boolean(identity));
  const [error, setError] = useState('');
  const [eventResults, setEventResults] = useState<GuessResult[]>([]);
  const [roundEnd, setRoundEnd] = useState<RoundEnd | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [copied, setCopied] = useState(false);
  const [confirmLeave, setConfirmLeave] = useState(false);

  const fail = (code: string) => setError(t(`mp.errors.${code}`, { defaultValue: t('mp.genericError') }));

  useEffect(() => { void loadGames().then(setGames).catch(() => setError(t('play.loadFailed'))); }, [t]);
  useEffect(() => {
    const socket = io({ path: '/socket.io', transports: ['websocket'] });
    let resumeTimer: number | undefined;
    let resumeAttempt = 0;
    socketRef.current = socket;

    const scheduleResume = (delay = 0) => {
      window.clearTimeout(resumeTimer);
      resumeTimer = window.setTimeout(() => {
        const resumeIdentity = resumeIdentityRef.current;
        if (!resumeIdentity || !socket.connected) return;
        const attempt = ++resumeAttempt;
        setResuming(true);
        void emit<{ room: RoomSnapshot }>(socket, 'room:resume', resumeIdentity).then(response => {
          if (attempt !== resumeAttempt || resumeIdentityRef.current?.resumeToken !== resumeIdentity.resumeToken) return;
          if (response.ok) { setRoom(response.data.room); setResuming(false); setError(''); return; }
          if (response.error.code === 'RESUME_TOKEN_INVALID') {
            resumeIdentityRef.current = null;
            setIdentity(null); setRoom(null); setResuming(false);
            sessionStorage.removeItem(SESSION_KEY);
            setError(t('mp.expired'));
            return;
          }
          scheduleResume(2_000);
        });
      }, delay);
    };

    socket.on('connect', () => { setConnected(true); if (resumeIdentityRef.current) scheduleResume(); else setResuming(false); });
    socket.on('disconnect', () => {
      setConnected(false);
      if (resumeIdentityRef.current) setResuming(true);
      resumeAttempt += 1;
      window.clearTimeout(resumeTimer);
    });
    socket.on('room:snapshot', (next: RoomSnapshot) => setRoom(previous => !previous || next.revision >= previous.revision ? next : previous));
    socket.on('round:guess-result', (result: GuessResult) => setEventResults(previous => previous.some(item => item.guessAppId === result.guessAppId && item.roundId === result.roundId) ? previous : [...previous.slice(-40), result]));
    socket.on('round:ended', (result: RoundEnd) => setRoundEnd(result));
    return () => { resumeAttempt += 1; window.clearTimeout(resumeTimer); socket.disconnect(); socketRef.current = null; };
    // The socket lives for the whole page; translations are read lazily.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const byId = useMemo(() => new Map(games.map(game => [game.appId, game])), [games]);
  const me = room?.players.find(player => player.id === identity?.playerId);
  const isHost = Boolean(room && room.hostPlayerId === identity?.playerId);
  // Keep the finished round on screen until the server starts the next one.
  const ended = room?.status === 'round_over' || room?.status === 'finished' ? room.lastRound ?? roundEnd : null;
  const roundId = room?.activeRound?.id ?? ended?.roundId ?? null;
  const records = useMemo(() => {
    const merged = new Map<number, GuessResult>();
    for (const result of [...(room?.activeRound?.results ?? ended?.results ?? []), ...eventResults.filter(result => result.roundId === roundId)]) {
      if (result.roundId === roundId) merged.set(result.guessAppId, result);
    }
    return [...merged.values()].flatMap(result => {
      const game = byId.get(result.guessAppId);
      return game ? [{ game, result: result.feedback }] : [];
    });
  }, [room, ended, eventResults, roundId, byId]);
  const currency = room?.settings.currency ?? settings.currency;
  const knowledge = useMemo(() => summarize(records, currency), [records, currency]);
  const excluded = useMemo(() => new Set(records.map(record => record.game.appId)), [records]);
  const secondsLeft = room?.activeRound ? Math.max(0, Math.ceil((room.activeRound.endsAt - clock) / 1000)) : 0;
  const canAct = connected && !resuming;
  const nameOf = (id: string | null | undefined) => room?.players.find(player => player.id === id)?.displayName ?? '';

  async function enter(event: 'room:create' | 'room:join') {
    const socket = socketRef.current; if (!socket) return;
    const name = displayName.trim() || t('mp.defaultName');
    setError('');
    try { localStorage.setItem(NAME_KEY, name); } catch { /* Optional preference. */ }
    const payload = event === 'room:create'
      ? { playerId: stablePlayerId, displayName: name, settings: { ...settings, currency: currencyFor(i18n.language) }, commandId: commandId() }
      : { playerId: stablePlayerId, displayName: name, roomCode: roomCode.trim().toUpperCase(), commandId: commandId() };
    const response = await emit<JoinResponse>(socket, event, payload);
    if (!response.ok) return fail(response.error.code);
    const next = { roomCode: response.data.room.code, playerId: response.data.playerId, resumeToken: response.data.resumeToken };
    resumeIdentityRef.current = next;
    setResuming(false); setIdentity(next); setRoom(response.data.room);
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
  }
  async function send(event: string, payload: object) {
    const socket = socketRef.current; if (!socket) return;
    const response = await emit(socket, event, { ...payload, commandId: commandId() });
    if (response.ok) setError(''); else fail(response.error.code);
  }
  const updateSettings = (next: MultiplayerSettings) => room && send('lobby:update-settings', { roomId: room.id, settings: next, expectedVersion: room.revision });
  async function copyCode() {
    if (!room) return;
    try { await navigator.clipboard.writeText(room.code); setCopied(true); window.setTimeout(() => setCopied(false), 1800); } catch { /* The code is visible on screen. */ }
  }
  async function leave() {
    if (room && connected) await send('room:leave', { roomId: room.id });
    resumeIdentityRef.current = null;
    setIdentity(null);
    sessionStorage.removeItem(SESSION_KEY);
    window.location.assign('/');
  }

  if (!room) return <div className="page">
    <TopBar><a className="topbar-link" href="/">{t('nav.home')}</a></TopBar>
    <main className="mp mp-entry">
      <header><h1>{t('mp.title')}</h1><p>{t('mp.lead')}</p></header>
      {resuming ? <div className="state"><div className="spinner" /><p>{t('mp.reconnecting')}</p></div> : <>
        <label className="mp-name">{t('mp.name')}
          <input value={displayName} maxLength={32} placeholder={t('mp.defaultName')} onChange={event => setDisplayName(event.target.value)} />
        </label>
        <div className="mp-doors">
          <section className="panel">
            <h2>{t('mp.create')}</h2>
            <SettingsFields value={settings} onChange={setSettings} />
            <button className="btn" disabled={!connected} onClick={() => void enter('room:create')}>{t('mp.create')}</button>
          </section>
          <section className="panel">
            <h2>{t('mp.orJoin')}</h2>
            <form className="mp-join" onSubmit={event => { event.preventDefault(); void enter('room:join'); }}>
              <input className="num" aria-label={t('mp.code')} placeholder={t('mp.code')} value={roomCode} maxLength={8} autoCapitalize="characters" autoComplete="off"
                onChange={event => setRoomCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} />
              <button className="btn" disabled={!connected || roomCode.trim().length < 4}>{t('mp.join')}</button>
            </form>
          </section>
        </div>
        {!connected && <p className="mp-status" role="status">{t('mp.connecting')}</p>}
        {error && <p className="notice" role="alert">{error}</p>}
      </>}
    </main>
  </div>;

  const allReady = room.players.length >= 2 && room.players.every(player => player.ready);
  const countdown = Math.max(0, Math.ceil(((room.countdownEndsAt ?? clock) - clock) / 1000));
  const inRound = room.status === 'playing' || room.status === 'round_over' || room.status === 'finished';

  return <div className="page">
    <TopBar>
      {confirmLeave
        ? <span className="mp-leave"><span>{t('mp.leaveConfirm')}</span><button className="btn btn-small" onClick={() => void leave()}>{t('mp.leave')}</button><button className="btn btn-ghost btn-small" onClick={() => setConfirmLeave(false)}>{t('mp.stay')}</button></span>
        : <button className="topbar-link" onClick={() => room.status === 'lobby' ? void leave() : setConfirmLeave(true)}>{t('mp.leave')}</button>}
    </TopBar>
    <main className="mp">
      <div className="mp-head">
        <div>
          <span className="label">{t('mp.roomCode')}</span>
          <div className="mp-code"><strong className="num">{room.code}</strong><button className="btn btn-ghost btn-small" onClick={() => void copyCode()}>{copied ? t('mp.copied') : t('mp.copy')}</button></div>
        </div>
        <p className="mp-summary">{t(`level.${room.settings.difficulty}`)} · {room.settings.bestOf === 1 ? t('mp.single') : t('mp.bestOf', { count: room.settings.bestOf, wins: Math.ceil(room.settings.bestOf / 2) })} · {t('mp.currency', { currency: t(`mp.${room.settings.currency}`) })}</p>
      </div>
      {!canAct && <p className="mp-status" role="status">{t('mp.reconnecting')}</p>}

      <ul className="mp-players" aria-label={t('mp.players')}>
        {room.players.map(player => <li key={player.id} className={player.id === identity?.playerId ? 'is-me' : ''}>
          <span className={`mp-dot ${player.connected ? 'is-online' : ''}`} title={player.connected ? '' : t('mp.offline')} />
          <strong>{player.displayName}</strong>
          <span className="mp-badges">
            {player.id === room.hostPlayerId && <em>{t('mp.host')}</em>}
            {player.id === identity?.playerId && <em>{t('mp.you')}</em>}
          </span>
          <span className="mp-player-state num">{room.status === 'lobby'
            ? (player.ready ? t('mp.ready') : t('mp.notReady'))
            : `${t('mp.score', { count: room.match?.scores[player.id] ?? 0 })} · ${t('mp.guesses', { count: player.guessCount, total: MAX_GUESSES })}`}</span>
        </li>)}
        {room.status === 'lobby' && Array.from({ length: Math.max(0, room.settings.maxPlayers - room.players.length) }, (_, index) => <li key={`empty-${index}`} className="is-empty">—</li>)}
      </ul>

      {room.status === 'lobby' && <section className="panel">
        {isHost && <><h2>{t('mp.settings')}</h2><SettingsFields value={room.settings} onChange={next => void updateSettings(next)} /></>}
        <div className="mp-actions">
          <button className={`btn ${me?.ready ? 'btn-ghost' : ''}`} disabled={!canAct} onClick={() => void send('lobby:set-ready', { roomId: room.id, ready: !me?.ready })}>{me?.ready ? t('mp.cancelReady') : t('mp.setReady')}</button>
          {isHost && <button className="btn" disabled={!canAct || !allReady} onClick={() => void send('match:start', { roomId: room.id })}>{t('mp.start')}</button>}
          <span className="mp-note">{isHost ? (!allReady ? t('mp.needPlayers') : '') : t('mp.waitingHost')}</span>
        </div>
      </section>}

      {room.status === 'countdown' && <section className="mp-countdown" role="status">
        <span className="label">{t('mp.round', { count: (room.match?.roundNumber ?? 0) + 1 })} · {t('mp.startsIn')}</span>
        <strong className="num">{countdown}</strong>
      </section>}

      {inRound && <>
        {room.status === 'playing' && <section className="mp-play">
          <div className={`mp-timer ${secondsLeft <= 15 ? 'is-low' : ''}`}>
            <span className="label">{t('mp.round', { count: room.match?.roundNumber ?? 1 })} · {t('mp.timeLeft')}</span>
            <strong className="num">{Math.floor(secondsLeft / 60)}:{String(secondsLeft % 60).padStart(2, '0')}</strong>
          </div>
          {me?.finished ? <p className="mp-note">{t('mp.finishedWaiting')}</p> : <>
            <SearchBox games={games} excludedAppIds={excluded} disabled={!canAct}
              onSelectGame={game => room.activeRound && void send('round:guess', { roomId: room.id, roundId: room.activeRound.id, guessAppId: game.appId })} />
            <div className="guess-entry-actions"><button className="link-button" disabled={!canAct} onClick={() => room.activeRound && void send('round:surrender', { roomId: room.id, roundId: room.activeRound.id })}>{t('mp.surrender')}</button></div>
          </>}
        </section>}

        {ended && <ResultBanner game={ended.answer} tone={ended.winnerPlayerId === identity?.playerId ? 'win' : 'neutral'}
          kicker={ended.winnerPlayerId ? t('mp.roundWon', { name: nameOf(ended.winnerPlayerId) }) : t('mp.roundDraw')}>
          {room.status === 'finished' ? <div className="result-buttons">
            <strong className="mp-verdict">{room.match?.winnerPlayerId === identity?.playerId ? t('mp.matchWon') : t('mp.matchOver', { name: nameOf(room.match?.winnerPlayerId) })}</strong>
            <button className="btn" disabled={!canAct} onClick={() => void send('match:rematch', { roomId: room.id, accept: !me?.rematch })}>{me?.rematch ? t('mp.rematchWaiting') : t('mp.rematch')}</button>
          </div> : <p className="result-note">{t('mp.nextSoon')}</p>}
        </ResultBanner>}

        {roundId && <RoundScreenshot key={roundId} roundId={roundId} ended={Boolean(ended)}
          urls={ended?.answer.hints?.screenshotUrls ?? room.activeRound?.screenshotUrls ?? []} />}
        {!ended && <KnownClues knowledge={knowledge} currency={currency} />}
        <section className="board" aria-live="polite">
          {[...records].reverse().map((record, index) =>
            <GuessCard key={record.game.appId} game={record.game} result={record.result} currency={currency} number={records.length - index} />)}
          {!records.length && room.status === 'playing' && <p className="board-empty">{t('play.empty')}</p>}
        </section>
      </>}
      {error && <p className="notice" role="alert">{error}</p>}
    </main>
  </div>;
}
