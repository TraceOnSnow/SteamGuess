import { useEffect, useMemo, useRef, useState } from 'react';
import type { Game } from '../types/game';
import { loadGames, getRandomGame } from '../data/games';
import { ComparisonEngine } from '../engine/ComparisonEngine';
import { SearchBox } from '../components/SearchBox/SearchBox';
import { GameTable } from '../components/GameTable/GameTable';
import { completeSession, createGameSession, getPlayerId } from '../api/client';
import { DISPLAY_FIELDS, loadDisplayFields, saveDisplayFields, type DisplayField } from '../settings/displayFields';
import { Clues } from '../play/Clues';
import { CHALLENGES, dailyGame, dateKey, eligibleAnswers, normalizeChallenge, type Challenge } from '../play/rules';
import { readSavedRound, readStats, recordResult, roundKey, saveRound, type Phase } from '../play/progress';
import '../App.css';
import '../play/Play.css';

const engine = new ComparisonEngine();
const FIELD_LABELS: Record<DisplayField, string> = { price: '国区常态价格', activity: '玩家与评测数量', rating: '好评率', releaseDate: '发行时间', companies: '开发商 / 发行商', tags: '游戏标签', owned: '已拥有' };

export default function SinglePlayerPage() {
  const [day] = useState(() => new URLSearchParams(window.location.search).get('daily') === '1' ? dateKey() : undefined);
  const [difficulty, setDifficulty] = useState<Challenge>(() => {
    try { return normalizeChallenge(localStorage.getItem('steamguess-classics-challenge')); } catch { return 'normal'; }
  });
  const key = roundKey(day, difficulty);
  const [loadedKey, setLoadedKey] = useState('');
  const [games, setGames] = useState<Game[]>([]);
  const [answer, setAnswer] = useState<Game | null>(null);
  const [guesses, setGuesses] = useState<number[]>([]);
  const [phase, setPhase] = useState<Phase>('playing');
  const [session, setSession] = useState(createGameSession);
  const [screenshotOpen, setScreenshotOpen] = useState(false);
  const [screenshotClear, setScreenshotClear] = useState(false);
  const [screenshotUsed, setScreenshotUsed] = useState(false);
  const [visibleFields, setVisibleFields] = useState(loadDisplayFields);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [stats, setStats] = useState(readStats);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [shareStatus, setShareStatus] = useState('');
  const [shareFallback, setShareFallback] = useState('');
  const completed = useRef('');
  const ended = phase !== 'playing';
  const profile = CHALLENGES[difficulty];
  const pool = useMemo(() => eligibleAnswers(games, difficulty), [games, difficulty]);
  const guessedIds = useMemo(() => new Set(guesses), [guesses]);
  const records = useMemo(() => answer ? guesses.flatMap(id => {
    const game = games.find(game => game.appId === id);
    return game ? [{ game, result: engine.compare(game, answer) }] : [];
  }) : [], [answer, games, guesses]);

  useEffect(() => {
    const controller = new AbortController();
    loadGames(controller.signal).then(catalog => {
      const candidates = eligibleAnswers(catalog, difficulty);
      if (!candidates.length) throw new Error('题库暂时不可用。');
      const saved = readSavedRound(key);
      const savedAnswer = saved && candidates.find(game => game.appId === saved.answerAppId);
      setGames(catalog);
      setShareStatus(''); setShareFallback('');
      if (saved && saved.difficulty === difficulty && savedAnswer && saved.guesses.length <= CHALLENGES[difficulty].attempts
        && saved.guesses.every(id => catalog.some(game => game.appId === id))) {
        setAnswer(savedAnswer); setGuesses(saved.guesses); setPhase(saved.phase); setSession(saved.session);
        setScreenshotOpen(saved.screenshotOpen); setScreenshotClear(saved.screenshotClear); setScreenshotUsed(saved.screenshotUsed);
      } else {
        setAnswer(day ? dailyGame(candidates, day) : getRandomGame(candidates));
        setGuesses([]); setPhase('playing'); setSession(createGameSession());
        setScreenshotOpen(false); setScreenshotClear(false); setScreenshotUsed(false);
      }
      setLoadedKey(key);
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : '题库加载失败，请重试。');
    });
    return () => controller.abort();
  }, [attempt, day, key, difficulty]);

  useEffect(() => {
    if (answer && loadedKey === key) saveRound(key, { answerAppId: answer.appId, guesses, phase, difficulty, session, screenshotOpen, screenshotClear, screenshotUsed });
  }, [answer, guesses, phase, difficulty, session, screenshotOpen, screenshotClear, screenshotUsed, key, loadedKey]);

  useEffect(() => {
    if (!answer || loadedKey !== key || !ended || completed.current === session.id) return;
    completed.current = session.id;
    setStats(recordResult(session.id, phase, guesses.length));
    void completeSession({ sessionId: session.id, playerId: getPlayerId(), mode: 'difficulty', difficulty,
      answerAppId: answer.appId, outcome: phase as 'won' | 'lost' | 'surrendered', guesses: guesses.length,
      hintsUsed: Number(screenshotUsed), startingHintMode: 'none',
      startedAt: session.startedAt }).catch(() => { /* Local progress remains available if the API is offline. */ });
  }, [answer, ended, phase, guesses.length, difficulty, session, screenshotUsed, loadedKey, key]);

  function newRound() {
    if (!pool.length) return;
    setAnswer(getRandomGame(pool, answer?.appId));
    setGuesses([]); setPhase('playing'); setScreenshotOpen(false); setScreenshotClear(false); setScreenshotUsed(false);
    setSession(createGameSession()); setShareStatus(''); setShareFallback('');
  }
  function changeChallenge(next: Challenge) {
    if (guesses.length && !ended) return;
    setDifficulty(next);
    try { localStorage.setItem('steamguess-classics-challenge', next); } catch { /* Optional preference. */ }
  }
  function selectGame(game: Game) {
    if (!answer || ended || guessedIds.has(game.appId)) return;
    const next = [...guesses, game.appId]; setGuesses(next);
    if (game.appId === answer.appId) setPhase('won');
    else if (next.length >= profile.attempts) setPhase('lost');
  }
  async function share() {
    const squares = guesses.map(id => id === answer?.appId ? '🟩' : '⬜').join('');
    const text = `SteamGuess · ${day || '自由练习'} · ${profile.label}\n${squares || '未猜测'}\n${phase === 'won' ? `${guesses.length}/${profile.attempts} 次猜中` : '未猜中'}${screenshotUsed ? ` · ${screenshotClear ? '清晰' : '模糊'}截图提示` : ''}`;
    try { await navigator.clipboard.writeText(text); setShareStatus('已复制'); }
    catch { setShareFallback(text); setShareStatus('复制下方文字'); }
  }

  if (error) return <main className="centered-state"><h1>题库加载失败</h1><p>{error}</p><button className="btn btn-primary" onClick={() => { setError(''); setAttempt(value => value + 1); }}>重新加载</button><a href="/">返回首页</a></main>;
  if (!answer || loadedKey !== key) return <main className="centered-state" aria-live="polite"><div className="loader" /><h1>加载中…</h1></main>;
  const answerName = answer.localizedNames?.zh || answer.name;

  return <div className="app classics-play">
    <a className="skip-link" href="#game-main">跳到游戏</a>
    <header className="play-header"><a className="play-brand" href="/">SG<span>SteamGuess</span></a><div className="play-header-actions"><a href="/">首页</a><button className="btn btn-quiet" aria-expanded={settingsOpen} aria-controls="display-settings" onClick={() => setSettingsOpen(open => !open)}>显示设置</button></div></header>
    <main id="game-main" className="play-main">
      <div className="play-heading"><div><h1>{day ? '每日挑战' : '自由练习'}</h1><p>{day && `${day} · `}{profile.label} {pool.length} 款 · 可搜索 {games.length.toLocaleString()} 款</p></div><div className="round-counter"><strong>{profile.attempts - guesses.length}</strong><span>剩余次数 / {profile.attempts}</span></div></div>
      <div className="challenge-bar"><div className="segmented-control" aria-label="难度">{(Object.keys(CHALLENGES) as Challenge[]).map(value => <button key={value} aria-pressed={value === difficulty} disabled={guesses.length > 0 && !ended} onClick={() => changeChallenge(value)}>{CHALLENGES[value].label}</button>)}</div></div>
      {settingsOpen && <section id="display-settings" className="play-settings"><h2>比对字段</h2><div className="field-options">{DISPLAY_FIELDS.filter(field => field !== 'owned').map(field => <label key={field}><input type="checkbox" checked={visibleFields.has(field)} onChange={event => { const next = new Set(visibleFields); if (event.target.checked) next.add(field); else next.delete(field); setVisibleFields(next); saveDisplayFields(next); }} />{FIELD_LABELS[field]}</label>)}</div><small>数据为历史快照；灰色表示资料缺失。</small></section>}
      {!ended && <section className="guess-panel"><SearchBox key={session.id} games={games} excludedAppIds={guessedIds} onSelectGame={selectGame} /><div className="guess-help"><button className="text-button" onClick={() => setPhase('surrendered')}>揭晓答案</button></div></section>}
      {ended && <section className={`round-result ${phase === 'won' ? 'result-win' : ''}`} role="status"><div><p className="section-kicker">{phase === 'won' ? '猜对了' : '答案'}</p><h2>{answerName}</h2><p>{answer.name} · {guesses.length} 次猜测</p><a href={`https://store.steampowered.com/app/${answer.appId}/`} target="_blank" rel="noreferrer">Steam ↗</a></div><div className="result-buttons"><button className="btn btn-primary" onClick={() => { if (day) window.location.assign('/singleplayer'); else newRound(); }}>{day ? '自由练习' : '再来一局'}</button><button className="btn btn-quiet" onClick={() => void share()}>分享结果</button><small aria-live="polite">{shareStatus}</small></div>{shareFallback && <textarea className="share-fallback" aria-label="分享文字" value={shareFallback} readOnly onFocus={event => event.target.select()} />}</section>}
      <Clues key={session.id} urls={answer.hints?.screenshotUrls || []} open={screenshotOpen} clear={screenshotClear} ended={ended}
        onToggle={() => { setScreenshotOpen(value => !value); setScreenshotUsed(true); }} onClear={() => setScreenshotClear(true)} />
      <GameTable records={records} correctGame={answer} revealAnswer={ended && phase !== 'won'} visibleFields={visibleFields} ownedAppIds={new Set()} />
      <footer className="play-footer"><span>{stats.won} 胜 / {stats.played} 局{stats.best ? ` · 最佳 ${stats.best} 次` : ''}</span><span>进度保存在本机</span></footer>
    </main>
  </div>;
}
