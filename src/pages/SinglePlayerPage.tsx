import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { compareGames } from '../../shared/game-rules.js';
import { completeSession, createGameSession, getPlayerId, submitAnswerFeedback } from '../api/client';
import { CustomPresetEditor } from '../components/CustomPresetEditor';
import { GuessCard } from '../components/GuessCard';
import { KnownClues } from '../components/KnownClues';
import { ResultBanner } from '../components/ResultBanner';
import { ScreenshotHint } from '../components/ScreenshotHint';
import { SearchBox } from '../components/SearchBox';
import { TopBar } from '../components/TopBar';
import { getRandomGame, loadGames } from '../data/games';
import { currencyFor } from '../lib/format';
import { summarize } from '../play/knowledge';
import { readSavedRound, readStats, recordResult, roundKey, saveRound, type HintState, type Phase } from '../play/progress';
import { PRESETS, presetFingerprint, presetPool, readCustomPreset, saveCustomPreset, tgaRange, METACRITIC_MIN, type CustomPreset, type PresetId } from '../play/presets';
import { challengeUrl, decodeChallenge } from '../play/share';
import { ATTEMPTS, DAILY_LEVEL, LEVELS, POOL_SIZES, answerPool, dailyAnswer, dateKey, normalizeLevel, type Level } from '../play/rules';
import type { Game } from '../types/game';
import './play.css';

const LEVEL_KEY = 'steamguess-level-v2';

/** What a practice round draws from: a cumulative tier or a themed preset. */
type Choice = { kind: 'level'; level: Level } | { kind: 'preset'; preset: PresetId };
function readChoice(): Choice {
  try {
    const stored = localStorage.getItem(LEVEL_KEY) || '';
    const preset = stored.startsWith('preset:') ? stored.slice(7) as PresetId : null;
    return preset && PRESETS.includes(preset) ? { kind: 'preset', preset } : { kind: 'level', level: normalizeLevel(stored) };
  } catch { return { kind: 'level', level: 'normal' }; }
}
function choiceName(choice: Choice) { return choice.kind === 'level' ? choice.level : `preset:${choice.preset}`; }

export default function SinglePlayerPage() {
  const { t, i18n } = useTranslation();
  const [day] = useState(() => new URLSearchParams(window.location.search).get('daily') === '1' ? dateKey() : undefined);
  // A shared link (?g=) pins the answer so a friend plays the same game.
  const [challenge] = useState(() => day ? null : decodeChallenge(new URLSearchParams(window.location.search).get('g')));
  const [practiceChoice, setPracticeChoice] = useState<Choice>(readChoice);
  const [custom, setCustom] = useState<CustomPreset | null>(readCustomPreset);
  const choice: Choice = day || challenge ? { kind: 'level', level: DAILY_LEVEL } : practiceChoice;
  const level: Level = choice.kind === 'level' ? choice.level : 'unrated';
  const preset = choice.kind === 'preset' ? choice.preset : null;
  const poolName = preset === 'custom' ? `preset:custom:${presetFingerprint(custom)}` : choiceName(choice);
  const key = roundKey(day, challenge ? `challenge:${challenge}` : poolName);

  const [games, setGames] = useState<Game[]>([]);
  const [loadedKey, setLoadedKey] = useState('');
  const [answer, setAnswer] = useState<Game | null>(null);
  const [guesses, setGuesses] = useState<number[]>([]);
  const [phase, setPhase] = useState<Phase>('playing');
  const [session, setSession] = useState(createGameSession);
  const [hint, setHint] = useState<HintState>('hidden');
  const [verdict, setVerdict] = useState<'fair' | 'obscure' | undefined>();
  const [stats, setStats] = useState(readStats);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const [confirmGiveUp, setConfirmGiveUp] = useState(false);
  const [share, setShare] = useState<{ status: string; text?: string }>({ status: '' });
  const reported = useRef('');

  const ended = phase !== 'playing';
  const ready = loadedKey === key && (Boolean(answer) || preset === 'custom');
  const currency = currencyFor(i18n.language);
  const byId = useMemo(() => new Map(games.map(game => [game.appId, game])), [games]);
  const guessedIds = useMemo(() => new Set(guesses), [guesses]);
  const records = useMemo(() => answer ? guesses.flatMap(id => {
    const game = byId.get(id);
    return game ? [{ game, result: compareGames(game, answer, currency) }] : [];
  }) : [], [answer, byId, guesses, currency]);
  const knowledge = useMemo(() => summarize(records, currency), [records, currency]);

  // Load the catalog, then resume the saved round for this key or deal a new one.
  useEffect(() => {
    let cancelled = false;
    loadGames().then(catalog => {
      if (cancelled) return;
      const shared = challenge ? catalog.filter(game => game.appId === challenge) : [];
      const pool = shared.length ? shared : preset ? presetPool(catalog, preset, custom) : answerPool(catalog, level);
      if (!pool.length) {
        // An empty custom preset is not an error: show the editor so one can be loaded.
        if (preset === 'custom') { setGames(catalog); setAnswer(null); setLoadedKey(key); return; }
        throw new Error('empty pool');
      }
      const ids = new Set(catalog.map(game => game.appId));
      const saved = readSavedRound(key);
      const savedAnswer = saved && pool.find(game => game.appId === saved.answerAppId);
      setGames(catalog);
      setShare({ status: '' }); setConfirmGiveUp(false);
      if (saved && savedAnswer && saved.guesses.length <= ATTEMPTS && saved.guesses.every(id => ids.has(id))) {
        setAnswer(savedAnswer); setGuesses(saved.guesses); setPhase(saved.phase); setSession(saved.session); setHint(saved.hint); setVerdict(saved.verdict);
        if (saved.phase !== 'playing') reported.current = saved.session.id;
      } else {
        setAnswer(day ? dailyAnswer(catalog, day) : getRandomGame(pool));
        setGuesses([]); setPhase('playing'); setSession(createGameSession()); setHint('hidden'); setVerdict(undefined);
      }
      setLoadedKey(key);
    }).catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
    // `custom` is covered by `key` through its fingerprint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, key, level, preset, challenge, reload]);

  useEffect(() => {
    if (answer && ready) saveRound(key, { answerAppId: answer.appId, guesses, phase, level, session, hint, verdict });
  }, [answer, ready, key, guesses, phase, level, session, hint, verdict]);

  // Report each finished round once: local stats plus the server-side record.
  useEffect(() => {
    if (!answer || !ready || !ended || reported.current === session.id) return;
    reported.current = session.id;
    setStats(recordResult(session.id, phase, guesses.length));
    void completeSession({
      sessionId: session.id, playerId: getPlayerId(), mode: day ? 'daily' : preset ? 'preset' : 'practice',
      difficulty: preset || challenge ? answer.difficulty?.level ?? 'unrated' : level,
      answerAppId: answer.appId, outcome: phase as 'won' | 'lost' | 'surrendered', guesses: guesses.length,
      hintsUsed: hint === 'hidden' ? 0 : hint === 'blurred' ? 1 : 2, startedAt: session.startedAt,
    }).catch(() => { /* Local progress is enough when the API is offline. */ });
  }, [answer, ready, ended, phase, guesses.length, level, session, hint, day, preset, challenge]);

  const tgaYears = useMemo(() => tgaRange(games), [games]);
  const poolLabel = preset === 'custom' ? (custom?.name || t('preset.custom')) : preset ? t(`preset.${preset}`) : t(`level.${level}`);
  const pool = useMemo(() => preset ? presetPool(games, preset, custom) : answerPool(games, level), [games, preset, custom, level]);

  function newRound() {
    if (!pool.length) return;
    setAnswer(getRandomGame(pool, answer?.appId));
    setGuesses([]); setPhase('playing'); setHint('hidden'); setVerdict(undefined);
    setSession(createGameSession()); setShare({ status: '' }); setConfirmGiveUp(false);
    window.scrollTo({ top: 0 });
  }
  function choose(next: Choice) {
    if (choiceName(next) === choiceName(practiceChoice) || (answer && guesses.length > 0 && !ended)) return;
    setPracticeChoice(next);
    try { localStorage.setItem(LEVEL_KEY, choiceName(next)); } catch { /* Optional preference. */ }
  }
  function applyCustom(next: CustomPreset) {
    saveCustomPreset(next);
    setCustom(next);
  }
  function guess(game: Game) {
    if (!answer || ended || guessedIds.has(game.appId)) return;
    const next = [...guesses, game.appId];
    setGuesses(next); setConfirmGiveUp(false);
    if (game.appId === answer.appId) setPhase('won');
    else if (next.length >= ATTEMPTS) setPhase('lost');
  }
  function vote(next: 'fair' | 'obscure') {
    if (!answer) return;
    setVerdict(next);
    void submitAnswerFeedback({ sessionId: session.id, playerId: getPlayerId(), appId: answer.appId, verdict: next }).catch(() => { /* Best effort. */ });
  }
  async function copyResult() {
    const squares = records.map(record => record.result.isCorrect ? '🟩' : '⬛').join('');
    const outcome = phase === 'won' ? `${guesses.length}/${ATTEMPTS}` : t('result.shareMissed');
    if (!answer) return;
    const title = day ? `${t('play.daily')} ${day}` : challenge ? t('play.challenge') : `${t('play.practice')} · ${poolLabel}`;
    const text = [
      `SteamGuess · ${title}`,
      `${squares || '—'} ${outcome}${hint !== 'hidden' ? ` · ${t('result.shareHint')}` : ''}`,
      `${t('result.shareInvite')} ${challengeUrl(window.location.origin, answer.appId)}`,
    ].join('\n');
    try { await navigator.clipboard.writeText(text); setShare({ status: t('result.copied') }); }
    catch { setShare({ status: t('result.copyManually'), text }); }
  }

  if (failed) return <main className="state">
    <h1>{t('play.loadFailed')}</h1><p>{t('play.loadFailedHelp')}</p>
    <button className="btn" onClick={() => { setFailed(false); setReload(value => value + 1); }}>{t('play.retry')}</button>
    <a className="link-button" href="/">{t('nav.home')}</a>
  </main>;
  if (!ready) return <main className="state" aria-live="polite"><div className="spinner" /><p>{t('play.loading')}</p></main>;

  const left = ATTEMPTS - guesses.length;
  const locked = guesses.length > 0 && !ended;
  const kicker = phase === 'won' ? `${t('result.won')} · ${t('result.wonIn', { count: guesses.length })}` : phase === 'lost' ? t('result.lost') : t('result.surrendered');

  return <div className="page">
    <a className="skip-link" href="#game">{t('nav.skip')}</a>
    <TopBar><a className="topbar-link" href="/">{t('nav.home')}</a></TopBar>
    <main id="game" className="play">
      <div className="play-head">
        <div>
          <h1>{day ? t('play.daily') : challenge ? t('play.challenge') : t('play.practice')}</h1>
          <p>{day ? <span className="num">{day}</span>
            : challenge ? t('play.challengeHelp')
            : preset === 'tga' ? t('presetHelp.tga', { count: pool.length, from: tgaYears?.[0], to: tgaYears?.[1] })
            : preset === 'metacritic' ? t('presetHelp.metacritic', { count: pool.length, score: METACRITIC_MIN })
            : preset === 'custom' ? t('presetHelp.custom', { name: poolLabel, count: pool.length })
            : t(`levelHelp.${level}`, { count: Math.min(POOL_SIZES[level], pool.length) })}</p>
        </div>
        <div className="attempts" aria-label={t('play.attempts', { used: guesses.length, total: ATTEMPTS })}>
          <div className="pips" aria-hidden="true">{Array.from({ length: ATTEMPTS }, (_, index) =>
            <i key={index} className={index < guesses.length ? (phase === 'won' && index === guesses.length - 1 ? 'pip-hit' : 'pip-used') : ''} />)}</div>
          <span className="num">{ended ? t('play.attempts', { used: guesses.length, total: ATTEMPTS }) : t('play.attemptsLeft', { count: left })}</span>
        </div>
      </div>

      {!day && !challenge && <div className="level-row">
        <div className="segmented" role="group" aria-label={t('mp.difficulty')}>
          {LEVELS.map(value => <button key={value} type="button" aria-pressed={!preset && value === level} disabled={locked} title={locked ? t('play.locked') : undefined}
            onClick={() => choose({ kind: 'level', level: value })}>{t(`level.${value}`)}</button>)}
        </div>
        <div className="segmented" role="group" aria-label={t('preset.title')}>
          {PRESETS.map(value => <button key={value} type="button" aria-pressed={preset === value} disabled={locked} title={locked ? t('play.locked') : undefined}
            onClick={() => choose({ kind: 'preset', preset: value })}>{t(`preset.${value}`)}</button>)}
        </div>
      </div>}
      {!day && !challenge && preset === 'custom' && !locked && <CustomPresetEditor games={games} preset={custom} onApply={applyCustom} />}
      {!answer ? <p className="board-empty">{t('preset.needList')}</p> : <>

      {ended ? <ResultBanner game={answer} kicker={kicker} tone={phase === 'won' ? 'win' : 'neutral'}>
        <div className="result-buttons">
          <button className="btn" onClick={() => { if (day || challenge) window.location.assign('/singleplayer'); else newRound(); }}>{day || challenge ? t('result.toPractice') : t('result.again')}</button>
          <button className="btn btn-ghost" onClick={() => void copyResult()}>{share.status || t('result.share')}</button>
        </div>
        {day && <p className="result-note">{t('result.comeBack')}</p>}
        {answer.difficulty?.level === 'unrated' && <div className="vote">
          {verdict ? <p>{t('feedback.thanks')}</p> : <>
            <p>{t('feedback.ask')}</p>
            <button className="btn btn-ghost btn-small" onClick={() => vote('fair')}>{t('feedback.fair')}</button>
            <button className="btn btn-ghost btn-small" onClick={() => vote('obscure')}>{t('feedback.obscure')}</button>
          </>}
        </div>}
        {share.text && <textarea className="share-text" aria-label={t('result.share')} value={share.text} readOnly rows={3} onFocus={event => event.target.select()} />}
      </ResultBanner> : <div className="guess-entry">
        <SearchBox key={session.id} games={games} excludedAppIds={guessedIds} onSelectGame={guess} autoFocus={window.matchMedia('(pointer: fine)').matches} />
        <div className="guess-entry-actions">
          {confirmGiveUp
            ? <><span>{t('play.giveUpConfirm')}</span><button className="link-button" onClick={() => setPhase('surrendered')}>{t('play.giveUp')}</button></>
            : <button className="link-button" onClick={() => setConfirmGiveUp(true)}>{t('play.giveUp')}</button>}
        </div>
      </div>}

      <ScreenshotHint key={session.id} urls={answer.hints?.screenshotUrls ?? []} state={hint} ended={ended} onChange={setHint} />
      {!ended && <KnownClues knowledge={knowledge} currency={currency} />}

      <section className="board" aria-live="polite">
        {records.length > 0 && <div className="legend" aria-hidden="true">
          {(['exact', 'partial', 'close', 'wrong'] as const).map(status => <span key={status}><i className={`is-${status}`} />{t(`status.${status}`)}</span>)}
          <span>↑ {t('direction.higher')}</span><span>↓ {t('direction.lower')}</span>
        </div>}
        {ended && phase !== 'won' && <GuessCard game={answer} result={compareGames(answer, answer, currency)} currency={currency} isAnswer />}
        {[...records].reverse().map((record, index) =>
          <GuessCard key={record.game.appId} game={record.game} result={record.result} currency={currency} number={records.length - index} />)}
        {!records.length && !ended && <p className="board-empty">{t('play.empty')}</p>}
      </section>

      </>}

      <footer className="play-foot">
        <span>{t('play.statsLine', { won: stats.won, played: stats.played })}</span>
        <span>{t('play.savedLocally')}</span>
      </footer>
    </main>
  </div>;
}
