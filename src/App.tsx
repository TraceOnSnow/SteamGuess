import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Game } from './types/game';
import type { GuessRecord } from './types/comparison';
import { ComparisonEngine } from './engine/ComparisonEngine';
import { getRandomGame, loadGameExperience } from './data/games';
import { DIFFICULTY_LEVELS, isLevelInPool, type DifficultyModel } from './difficulty/model';
import type { DifficultyLevel } from './labeler/types';
import { SearchBox } from './components/SearchBox/SearchBox';
import { GameTable } from './components/GameTable/GameTable';
import { SettingsPanel } from './components/SettingsPanel/SettingsPanel';
import { HintPanel } from './components/HintPanel/HintPanel';
import { DifficultyFeedback } from './components/DifficultyFeedback/DifficultyFeedback';
import { loadDisplayFields, saveDisplayFields, type DisplayField } from './settings/displayFields';
import { clearSteamLibrary, loadSteamLibrary, saveSteamLibrary, type SteamLibrary } from './library/steamLibrary';
import { completeSession, createGameSession, getPlayerId } from './api/client';
import './App.css';

const MAX_ATTEMPTS = 10;
const comparisonEngine = new ComparisonEngine();
const DIFFICULTY_STORAGE_KEY = 'steamguess-selected-difficulty-v1';
const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = { easy: '简单', normal: '普通', hard: '困难', hell: '地狱' };
const POOL_MODE_STORAGE_KEY = 'steamguess-pool-mode-v1';
type PoolMode = 'difficulty' | 'library';

function loadPoolMode(): PoolMode {
  return localStorage.getItem(POOL_MODE_STORAGE_KEY) === 'library' ? 'library' : 'difficulty';
}

function loadSelectedDifficulty(): DifficultyLevel {
  const saved = localStorage.getItem(DIFFICULTY_STORAGE_KEY);
  return DIFFICULTY_LEVELS.includes(saved as DifficultyLevel) ? saved as DifficultyLevel : 'normal';
}
type GamePhase = 'playing' | 'won' | 'lost' | 'surrendered';

function App() {
  const { t, i18n } = useTranslation();
  const [games, setGames] = useState<Game[]>([]);
  const [currentGame, setCurrentGame] = useState<Game | null>(null);
  const [records, setRecords] = useState<GuessRecord[]>([]);
  const [phase, setPhase] = useState<GamePhase>('playing');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [difficulty, setDifficulty] = useState<DifficultyLevel>(loadSelectedDifficulty);
  const [difficultyModel, setDifficultyModel] = useState<DifficultyModel | null>(null);
  const [visibleFields, setVisibleFields] = useState<Set<DisplayField>>(loadDisplayFields);
  const [library, setLibrary] = useState<SteamLibrary | null>(loadSteamLibrary);
  const [poolMode, setPoolMode] = useState<PoolMode>(loadPoolMode);
  const [hintCount, setHintCount] = useState(0);
  const [showDifficultyFeedback, setShowDifficultyFeedback] = useState(false);
  const [session, setSession] = useState(createGameSession);
  const playerId = useMemo(() => getPlayerId(), []);

  useEffect(() => {
    const controller = new AbortController();
    const initialDifficulty = loadSelectedDifficulty();
    loadGameExperience(controller.signal)
      .then(({ games: catalog, model }) => {
        const presetPool = catalog.filter(game => !game.difficulty || isLevelInPool(game.difficulty.level, initialDifficulty));
        const savedLibrary = loadSteamLibrary();
        const savedLibraryIds = new Set(savedLibrary?.appIds ?? []);
        const savedLibraryPool = catalog.filter(game => savedLibraryIds.has(game.appId));
        const useLibrary = loadPoolMode() === 'library' && savedLibraryPool.length > 0;
        if (!useLibrary && loadPoolMode() === 'library') {
          setPoolMode('difficulty');
          localStorage.setItem(POOL_MODE_STORAGE_KEY, 'difficulty');
        }
        setGames(catalog);
        setDifficultyModel(model);
        setCurrentGame(getRandomGame(useLibrary ? savedLibraryPool : (presetPool.length > 0 ? presetPool : catalog)));
      })
      .catch(error => {
        if (error instanceof DOMException && error.name === 'AbortError') return;
        console.error(error);
        setLoadError(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
  }, [loadAttempt]);

  const guessedAppIds = useMemo(
    () => new Set(records.map(record => record.game.appId)),
    [records],
  );
  const ownedAppIds = useMemo(() => new Set(library?.appIds ?? []), [library]);
  const difficultyPool = useMemo(
    () => games.filter(game => !game.difficulty || isLevelInPool(game.difficulty.level, difficulty)),
    [difficulty, games],
  );
  const libraryPool = useMemo(() => games.filter(game => ownedAppIds.has(game.appId)), [games, ownedAppIds]);
  const answerPool = poolMode === 'library' && libraryPool.length > 0 ? libraryPool : difficultyPool;
  const attemptsLeft = MAX_ATTEMPTS - records.length;
  const gameOver = phase !== 'playing';
  const revealAnswer = phase === 'lost' || phase === 'surrendered';
  const hasStarted = records.length > 0 || phase !== 'playing';

  const handleSelectGame = (guessedGame: Game) => {
    if (!currentGame || gameOver || guessedAppIds.has(guessedGame.appId)) return;

    const result = comparisonEngine.compare(guessedGame, currentGame);
    const nextRecords = [...records, { game: guessedGame, result }];
    setRecords(nextRecords);

    const completedPhase = result.isCorrect ? 'won' : nextRecords.length >= MAX_ATTEMPTS ? 'lost' : null;
    if (completedPhase) {
      setPhase(completedPhase);
      void completeSession({
        sessionId: session.id,
        playerId,
        mode: poolMode,
        difficulty,
        answerAppId: currentGame.appId,
        outcome: completedPhase,
        guesses: nextRecords.length,
        hintsUsed: hintCount,
        startedAt: session.startedAt,
      }).catch(error => console.warn('Could not save game session.', error));
    }
  };

  const prepareNewRound = () => {
    setRecords([]);
    setPhase('playing');
    setHintCount(0);
    setShowDifficultyFeedback(false);
    setSession(createGameSession());
  };

  const handleNewGame = () => {
    if (answerPool.length === 0) return;
    setCurrentGame(getRandomGame(answerPool, currentGame?.appId));
    prepareNewRound();
  };

  const handleSurrender = () => {
    if (!currentGame || gameOver) return;
    setPhase('surrendered');
    void completeSession({
      sessionId: session.id,
      playerId,
      mode: poolMode,
      difficulty,
      answerAppId: currentGame.appId,
      outcome: 'surrendered',
      guesses: records.length,
      hintsUsed: hintCount,
      startedAt: session.startedAt,
    }).catch(error => console.warn('Could not save game session.', error));
  };

  const changeLanguage = (language: 'zh' | 'en') => {
    void i18n.changeLanguage(language);
    localStorage.setItem('steamguess-language', language);
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  };

  const resetWithPool = (pool: Game[]) => {
    if (pool.length > 0) setCurrentGame(getRandomGame(pool, currentGame?.appId));
    prepareNewRound();
  };

  const changeDifficulty = (level: DifficultyLevel) => {
    setDifficulty(level);
    localStorage.setItem(DIFFICULTY_STORAGE_KEY, level);
    const pool = games.filter(game => !game.difficulty || isLevelInPool(game.difficulty.level, level));
    resetWithPool(pool);
  };

  const changeVisibleField = (field: DisplayField, visible: boolean) => {
    setVisibleFields(previous => {
      const next = new Set(previous);
      if (visible) next.add(field);
      else next.delete(field);
      saveDisplayFields(next);
      return next;
    });
  };

  const changePoolMode = (mode: PoolMode) => {
    const nextMode = mode === 'library' && libraryPool.length === 0 ? 'difficulty' : mode;
    setPoolMode(nextMode);
    localStorage.setItem(POOL_MODE_STORAGE_KEY, nextMode);
    resetWithPool(nextMode === 'library' ? libraryPool : difficultyPool);
  };

  const changeLibrary = (nextLibrary: SteamLibrary | null) => {
    setLibrary(nextLibrary);
    if (!nextLibrary) {
      clearSteamLibrary();
      setPoolMode('difficulty');
      localStorage.setItem(POOL_MODE_STORAGE_KEY, 'difficulty');
      resetWithPool(difficultyPool);
      return;
    }
    saveSteamLibrary(nextLibrary);
    const nextOwned = new Set(nextLibrary.appIds);
    const nextPool = games.filter(game => nextOwned.has(game.appId));
    if (nextPool.length > 0) {
      setPoolMode('library');
      localStorage.setItem(POOL_MODE_STORAGE_KEY, 'library');
      resetWithPool(nextPool);
    }
  };

  if (isLoading) {
    return (
      <main className="centered-state" aria-live="polite">
        <div className="loader" aria-hidden="true" />
        <h1>{t('app.title')}</h1>
        <p>{t('app.loading')}</p>
      </main>
    );
  }

  if (loadError || !currentGame) {
    return (
      <main className="centered-state">
        <div className="state-icon" aria-hidden="true">!</div>
        <h1>{t('app.loadFailed')}</h1>
        <p>{t('app.loadFailedHelp')}</p>
        <button
          className="btn btn-primary"
          type="button"
          onClick={() => {
            setIsLoading(true);
            setLoadError(false);
            setLoadAttempt(value => value + 1);
          }}
        >
          {t('app.retry')}
        </button>
      </main>
    );
  }

  return (
    <div className={`app ${hasStarted ? 'game-started' : ''}`}>
      <a className="skip-link" href="#game-main">{t('app.skipToGame')}</a>
      <header className="app-header" aria-hidden={hasStarted}>
        <div className="header-topbar">
          <div className="brand-mark" aria-hidden="true">SG</div>
          <nav className="header-actions" aria-label={t('app.tools')}>
            <button
              className="icon-button"
              type="button"
              onClick={() => setShowSettings(open => !open)}
              aria-expanded={showSettings}
              aria-controls="settings-panel"
            >
              <span>{t('app.settings')}</span>
            </button>
          </nav>
        </div>



        <div className="hero-copy">
          <p className="eyebrow">Steam Games · {t('app.eyebrow', { count: answerPool.length })} · {poolMode === 'library' ? t('app.libraryPool') : DIFFICULTY_LABELS[difficulty]}</p>
          <h1>{t('app.title')}</h1>
          <p>{t('app.subtitle')}</p>
        </div>
      </header>

        {showSettings && (
          <SettingsPanel
            language={i18n.language}
            difficulty={difficulty}
            difficultyModel={difficultyModel}
            answerPoolSize={answerPool.length}
            visibleFields={visibleFields}
            library={library}
            matchedLibraryGames={libraryPool.length}
            poolMode={poolMode}
            onLanguageChange={changeLanguage}
            onDifficultyChange={changeDifficulty}
            onVisibleFieldChange={changeVisibleField}
            onLibraryChange={changeLibrary}
            onPoolModeChange={changePoolMode}
            onClose={() => setShowSettings(false)}
          />
        )}

      <main className="app-main" id="game-main">
        <section className="game-panel" aria-label={t('search.label')}>
          <div className="game-search-row">
            <SearchBox
              games={games}
              excludedAppIds={guessedAppIds}
              onSelectGame={handleSelectGame}
              isDisabled={gameOver}
            />
            <div className="game-toolbar">
              <div className="attempt-meter" aria-label={t('app.attemptsLeft', { count: attemptsLeft })}>
                <span>{t('app.attempts')}</span>
                <strong className={attemptsLeft <= 3 ? 'warning' : ''}>{attemptsLeft}</strong>
                <span>/ {MAX_ATTEMPTS}</span>
              </div>
              <HintPanel
                key={`${currentGame.appId}-${session.id}`}
                screenshotUrl={currentGame.hints?.screenshotUrl}
                revealOriginal={gameOver}
                onUseHint={() => setHintCount(count => count + 1)}
              />
              <button className="btn btn-quiet" type="button" onClick={handleSurrender} disabled={gameOver}>
                {t('app.surrender')}
              </button>
              {hasStarted && (
                <button className="btn btn-quiet" type="button" onClick={() => setShowSettings(open => !open)} aria-expanded={showSettings} aria-controls="settings-panel">
                  {t('app.settings')}
                </button>
              )}
            </div>
          </div>

          {phase !== 'playing' && (
            <div className={`outcome-card outcome-${phase}`} role="status" aria-live="polite">
              <div>
                <p className="outcome-kicker">{t(`outcome.${phase}.kicker`)}</p>
                <h2>{t(`outcome.${phase}.title`, { name: currentGame.name })}</h2>
                <p>{t(`outcome.${phase}.message`, { count: records.length })}</p>
              </div>
              <div className="outcome-actions">
                <button className="btn btn-quiet" type="button" onClick={() => setShowDifficultyFeedback(open => !open)} aria-expanded={showDifficultyFeedback} aria-controls="difficulty-feedback-title">
                  {t('feedback.open')}
                </button>
                <button className="btn btn-primary" type="button" onClick={handleNewGame}>
                  {t('app.playAgain')}
                </button>
              </div>
            </div>
          )}

          {phase !== 'playing' && showDifficultyFeedback && (
            <DifficultyFeedback
              appId={currentGame.appId}
              initialScore={currentGame.difficulty?.score}
              playerId={playerId}
              sessionId={session.id}
              onClose={() => setShowDifficultyFeedback(false)}
            />
          )}
        </section>

        <GameTable records={records} correctGame={currentGame} revealAnswer={revealAnswer} visibleFields={visibleFields} ownedAppIds={ownedAppIds} />
      </main>

      <footer className="app-footer">
        <p>{t('app.footer')}</p>
      </footer>
    </div>
  );
}

export default App;
