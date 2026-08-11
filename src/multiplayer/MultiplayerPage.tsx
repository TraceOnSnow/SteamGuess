import { useEffect, useMemo, useRef, useState } from 'react';
import { io, type Socket } from 'socket.io-client';
import { loadGames } from '../data/games';
import type { Game } from '../types/game';
import { SearchBox } from '../components/SearchBox/SearchBox';
import { getPlayerId } from '../api/client';
import type { Ack, GuessResult, MultiplayerField, MultiplayerSettings, RoomSnapshot, RoundEnd } from './types';
import './MultiplayerPage.css';

const SESSION_KEY = 'steamguess-multiplayer-session-v1';
const ALL_FIELDS: { key: MultiplayerField; label: string }[] = [{ key: 'price', label: '价格' }, { key: 'popularity', label: '峰值在线' }, { key: 'reviews', label: '评测数' }, { key: 'rating', label: '好评率' }, { key: 'releaseDate', label: '发行日期' }, { key: 'companies', label: '厂商' }, { key: 'tags', label: '用户标签' }];
const DEFAULT_SETTINGS: MultiplayerSettings = { difficulty: 'normal', bestOf: 1, maxPlayers: 4, roundTimeSeconds: 120, visibleFields: ALL_FIELDS.map(field => field.key) };
const commandId = () => `command_${crypto.randomUUID()}`;

type Identity = { roomCode: string; playerId: string; resumeToken: string };
type JoinResponse = { room: RoomSnapshot; playerId: string; resumeToken: string };

function emit<T>(socket: Socket, event: string, payload: object): Promise<Ack<T>> {
  return new Promise(resolve => socket.timeout(8000).emit(event, payload, (error: Error | null, response: Ack<T>) => {
    resolve(error ? { ok: false, error: { code: 'TIMEOUT', message: '服务器没有及时响应。' } } : response);
  }));
}

export default function MultiplayerPage() {
  const socketRef = useRef<Socket | null>(null);
  const [games, setGames] = useState<Game[]>([]);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [identity, setIdentity] = useState<Identity | null>(() => {
    const saved = sessionStorage.getItem(SESSION_KEY);
    if (!saved) return null;
    try { return JSON.parse(saved) as Identity; } catch { return null; }
  });
  const resumeIdentityRef = useRef(identity);
  const stablePlayerId = useMemo(() => getPlayerId(), []);
  const [displayName, setDisplayName] = useState(() => localStorage.getItem('steamguess-display-name') || '玩家');
  const [roomCode, setRoomCode] = useState('');
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  const [connected, setConnected] = useState(false);
  const [resuming, setResuming] = useState(() => Boolean(identity));
  const [error, setError] = useState('');
  const [results, setResults] = useState<GuessResult[]>([]);
  const [roundEnd, setRoundEnd] = useState<RoundEnd | null>(null);
  const [clock, setClock] = useState(() => Date.now());
  const [copiedRoomCode, setCopiedRoomCode] = useState(false);

  useEffect(() => { void loadGames().then(setGames).catch(() => setError('题库加载失败。')); }, []);
  useEffect(() => {
    const socket = io({ path: '/socket.io', transports: ['websocket', 'polling'] });
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
          if (response.ok) {
            setRoom(response.data.room);
            setResuming(false);
            setError('');
            return;
          }
          if (response.error.code === 'RESUME_TOKEN_INVALID') {
            resumeIdentityRef.current = null;
            setIdentity(null);
            setRoom(null);
            setResuming(false);
            sessionStorage.removeItem(SESSION_KEY);
            setError('房间已失效，请重新创建或加入。');
            return;
          }
          setError('正在恢复房间连接……');
          scheduleResume(2_000);
        });
      }, delay);
    };

    socket.on('connect', () => {
      setConnected(true);
      if (resumeIdentityRef.current) scheduleResume();
      else setResuming(false);
    });
    socket.on('disconnect', () => {
      setConnected(false);
      if (resumeIdentityRef.current) setResuming(true);
      resumeAttempt += 1;
      window.clearTimeout(resumeTimer);
    });
    socket.on('room:snapshot', (next: RoomSnapshot) => setRoom(previous => !previous || next.revision >= previous.revision ? next : previous));
    socket.on('round:guess-result', (result: GuessResult) => setResults(previous => previous.some(item => item.guessAppId === result.guessAppId && item.roundId === result.roundId) ? previous : [...previous, result]));
    socket.on('round:ended', (result: RoundEnd) => setRoundEnd(result));
    return () => {
      resumeAttempt += 1;
      window.clearTimeout(resumeTimer);
      socket.disconnect();
      socketRef.current = null;
    };
  }, []);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 250);
    return () => clearInterval(timer);
  }, []);

  const me = room?.players.find(player => player.id === identity?.playerId);
  // Keep the just-finished round visible until the server announces the next active round.
  // `activeRound` is cleared before `round:ended` is emitted, so filtering only by
  // `room.activeRound.id` made every guess disappear at the end of a round.
  const displayedRoundId = room?.activeRound?.id ?? roundEnd?.roundId ?? null;
  const currentResults = useMemo(
    () => results.filter(result => result.roundId === displayedRoundId),
    [displayedRoundId, results],
  );
  const currentRoundEnd = room?.status === 'countdown' ? null : roundEnd?.roundId === room?.activeRound?.id || (roundEnd && room?.status !== 'playing') ? roundEnd : null;
  const secondsLeft = room?.activeRound ? Math.max(0, Math.ceil((room.activeRound.endsAt - clock) / 1000)) : 0;
  const excluded = useMemo(() => new Set(currentResults.map(result => result.guessAppId)), [currentResults]);
  const canInteract = connected && !resuming;

  async function enter(event: 'room:create' | 'room:join') {
    const socket = socketRef.current; if (!socket) return;
    setError(''); localStorage.setItem('steamguess-display-name', displayName);
    const payload = event === 'room:create' ? { playerId: stablePlayerId, displayName, settings, commandId: commandId() } : { playerId: stablePlayerId, displayName, roomCode: roomCode.trim().toUpperCase(), commandId: commandId() };
    const response = await emit<JoinResponse>(socket, event, payload);
    if (!response.ok) return setError(response.error.message);
    const next = { roomCode: response.data.room.code, playerId: response.data.playerId, resumeToken: response.data.resumeToken };
    resumeIdentityRef.current = next;
    setResuming(false);
    setIdentity(next); setRoom(response.data.room); sessionStorage.setItem(SESSION_KEY, JSON.stringify(next));
  }
  async function send<T>(event: string, payload: object) {
    const socket = socketRef.current; if (!socket) return;
    const response = await emit<T>(socket, event, { ...payload, commandId: commandId() });
    if (!response.ok) setError(response.error.message); else setError(''); return response;
  }
  const ready = () => room && send('lobby:set-ready', { roomId: room.id, ready: !me?.ready });
  const start = () => room && send('match:start', { roomId: room.id });
  const guess = (game: Game) => room?.activeRound && send('round:guess', { roomId: room.id, roundId: room.activeRound.id, guessAppId: game.appId });
  const surrender = () => room?.activeRound && send('round:surrender', { roomId: room.id, roundId: room.activeRound.id });
  function toggleField(field: MultiplayerField) {
    if (!room) return;
    const selected = room.settings.visibleFields.includes(field);
    if (selected && room.settings.visibleFields.length === 1) return;
    const visibleFields = selected ? room.settings.visibleFields.filter(value => value !== field) : [...room.settings.visibleFields, field];
    void updateSettings({ ...room.settings, visibleFields });
  }
  async function updateSettings(next: MultiplayerSettings) {
    if (!room) return; setSettings(next);
    await send('lobby:update-settings', { roomId: room.id, settings: next, expectedVersion: room.revision });
  }
  async function copyRoomCode() {
    if (!room) return;
    try {
      await navigator.clipboard.writeText(room.code);
      setCopiedRoomCode(true);
      window.setTimeout(() => setCopiedRoomCode(false), 1800);
    } catch {
      setError('复制失败，请手动复制房间码。');
    }
  }
  async function leave() {
    if (room) await send('room:leave', { roomId: room.id });
    resumeIdentityRef.current = null;
    setIdentity(null);
    sessionStorage.removeItem(SESSION_KEY);
    window.location.assign('/');
  }
  const rematch = () => room && send('match:rematch', { roomId: room.id, accept: !me?.rematch });

  if (!room) return (
    <main className="mp-shell mp-entry">
      <a href="/" className="mp-back">← 单人模式</a>
      <section className="mp-card">
        <p className="eyebrow">SteamGuess Multiplayer</p><h1>多人同题竞速</h1><p className="mp-muted">创建 2–8 人私人房间，一起猜同一款游戏。</p>
        <label>昵称<input value={displayName} maxLength={32} onChange={event => setDisplayName(event.target.value)} /></label>
        <div className="mp-settings-row"><label>难度<select value={settings.difficulty} onChange={event => setSettings({ ...settings, difficulty: event.target.value as MultiplayerSettings['difficulty'] })}><option value="easy">简单</option><option value="normal">普通</option><option value="hard">困难</option><option value="hell">地狱</option></select></label><label>赛制<select value={settings.bestOf} onChange={event => setSettings({ ...settings, bestOf: Number(event.target.value) as 1 | 3 | 5 })}><option value="1">BO1</option><option value="3">BO3</option><option value="5">BO5</option></select></label><label>人数<select value={settings.maxPlayers} onChange={event => setSettings({ ...settings, maxPlayers: Number(event.target.value) })}>{[2, 3, 4, 5, 6, 7, 8].map(value => <option key={value} value={value}>{value} 人</option>)}</select></label></div>
        <button className="btn btn-primary" disabled={!connected || !displayName.trim()} onClick={() => void enter('room:create')}>创建房间</button>
        <div className="mp-divider"><span>或者加入</span></div>
        <div className="mp-join"><input aria-label="房间码" placeholder="房间码" value={roomCode} maxLength={8} onChange={event => setRoomCode(event.target.value.toUpperCase())} /><button className="btn btn-quiet" disabled={!connected || !roomCode.trim()} onClick={() => void enter('room:join')}>加入</button></div>
        {!connected && <p className="mp-error">正在连接服务器……</p>}{error && <p className="mp-error">{error}</p>}
      </section>
    </main>
  );

  return (
    <main className="mp-shell">
      <header className="mp-top"><div><a className="mp-home-link" href="/">← 返回主页</a><strong>{room.status === 'lobby' ? '等待开始' : `第 ${room.match?.roundNumber ?? 1} 回合`}</strong></div><button className="btn btn-quiet" onClick={() => void leave()}>离开房间</button></header>
      <section className="mp-room-code" aria-label="房间代码">
        <div><span>房间代码</span><strong>{room.code}</strong></div>
        <button className="btn btn-primary" type="button" onClick={() => void copyRoomCode()}>{copiedRoomCode ? '已复制' : '复制代码'}</button>
      </section>
      {(!connected || resuming) && <p className="mp-connection-status" role="status">连接中断，正在自动恢复房间……</p>}
      <section className="mp-scoreboard">
        {room.players.map(player => <div key={player.id} className={player.id === identity?.playerId ? 'is-me' : ''}><span className={`mp-dot ${player.connected ? 'online' : ''}`} /> <strong>{player.displayName}</strong><span>{room.match?.scores[player.id] ?? 0} 分 · {player.guessCount}/10</span></div>)}
      </section>
      {room.status === 'countdown' ? <section className="mp-card mp-countdown">
        <span className="mp-muted">准备开始第 {room.match?.roundNumber === 0 ? 1 : room.match?.roundNumber ?? 1} 回合</span>
        <strong>{Math.max(0, Math.ceil(((room.countdownEndsAt ?? clock) - clock) / 1000))}</strong>
        <span className="mp-muted">房间规则已锁定，服务端正在同步题目。</span>
      </section> : room.status === 'lobby' ? <section className="mp-card mp-lobby">
        <h2>房间设置</h2>
        {room.hostPlayerId === identity?.playerId ? <div className="mp-settings-row"><label>难度<select value={room.settings.difficulty} onChange={event => void updateSettings({ ...room.settings, difficulty: event.target.value as MultiplayerSettings['difficulty'] })}><option value="easy">简单</option><option value="normal">普通</option><option value="hard">困难</option><option value="hell">地狱</option></select></label><label>赛制<select value={room.settings.bestOf} onChange={event => void updateSettings({ ...room.settings, bestOf: Number(event.target.value) as 1 | 3 | 5 })}><option value="1">BO1</option><option value="3">BO3</option><option value="5">BO5</option></select></label><label>人数<select value={room.settings.maxPlayers} onChange={event => void updateSettings({ ...room.settings, maxPlayers: Number(event.target.value) })}>{[2, 3, 4, 5, 6, 7, 8].map(value => <option key={value} value={value}>{value} 人</option>)}</select></label></div> : <p>{room.settings.difficulty} · BO{room.settings.bestOf} · 最多 {room.settings.maxPlayers} 人</p>}
        {room.hostPlayerId === identity?.playerId && <fieldset className="mp-fields-setting"><legend>本局展示字段</legend>{ALL_FIELDS.map(field => <label key={field.key}><input type="checkbox" checked={room.settings.visibleFields.includes(field.key)} onChange={() => toggleField(field.key)} />{field.label}</label>)}</fieldset>}
        <p className="mp-muted">已加入 {room.players.length}/{room.settings.maxPlayers} 人 · 把上面的房间代码发给朋友</p>
        <div className="mp-actions"><button className={`btn ${me?.ready ? 'btn-quiet' : 'btn-primary'}`} disabled={!canInteract} onClick={() => void ready()}>{me?.ready ? '取消准备' : '准备'}</button>{room.hostPlayerId === identity?.playerId && <button className="btn btn-primary" disabled={!canInteract || room.players.length < 2 || room.players.some(player => !player.ready)} onClick={() => void start()}>开始比赛</button>}</div>
      </section> : <>
        <section className="mp-playbar"><div><span>剩余时间</span><strong>{secondsLeft}s</strong></div>{room.status === 'playing' && <><SearchBox games={games} excludedAppIds={excluded} onSelectGame={game => void guess(game)} isDisabled={!canInteract || !me?.connected || me?.finished} /><button className="btn btn-quiet" disabled={!canInteract} onClick={() => void surrender()}>投降</button></>}</section>
        {currentRoundEnd && <section className="mp-answer"><span>{currentRoundEnd.winnerPlayerId ? `${room.players.find(player => player.id === currentRoundEnd.winnerPlayerId)?.displayName} 赢得本回合` : '本回合平局'}</span><strong>{currentRoundEnd.answer.localizedNames?.zh || currentRoundEnd.answer.name}</strong></section>}
        {room.status === 'finished' && <section className="mp-card"><h2>{room.match?.winnerPlayerId === identity?.playerId ? '你赢得了比赛' : '比赛结束'}</h2><button className="btn btn-primary" disabled={!canInteract} onClick={() => void rematch()}>{me?.rematch ? '等待其他玩家确认…' : '再来一局'}</button></section>}
        <section className="mp-results">{currentResults.length === 0 ? <p className="mp-muted">搜索并提交你的第一款游戏。</p> : [...currentResults].reverse().map(result => { const game = games.find(item => item.appId === result.guessAppId); return <article key={`${result.roundId}-${result.guessAppId}`} className={result.feedback.isCorrect ? 'correct' : ''}><header><strong>{game?.localizedNames?.zh || game?.name || result.guessAppId}</strong><span>{result.feedback.isCorrect ? '正确' : `剩余 ${result.guessesLeft} 次`}</span></header><div className="mp-fields">{result.feedback.fields.map(field => <span key={field.fieldName} className={`match-${field.status}`}>{field.fieldName}: {String(field.userValue ?? '—')} {field.direction === 'higher' ? '↑' : field.direction === 'lower' ? '↓' : ''}</span>)}</div><div className="mp-tags">{result.feedback.matchingCompanies.map(value => <span key={`c-${value}`}>{value}</span>)}{result.feedback.matchingTags.map(value => <span key={`t-${value}`}>{value}</span>)}</div></article> })}</section>
      </>}
      {error && <p className="mp-error">{error}</p>}
    </main>
  );
}
