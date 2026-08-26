import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Game } from '../types/game';
import type { GuessRecord } from '../types/comparison';
import { ComparisonEngine } from '../engine/ComparisonEngine';
import { getRandomGame, hasDifficulty, loadGameExperience } from '../data/games';
import { DIFFICULTY_LEVELS, isLevelInPool } from '../difficulty/pools';
import type { DifficultyLevel, StartingHintMode } from '../difficulty/types';
import {
  DEFAULT_STARTING_HINTS,
  resolveStartingHintMode,
  type StartingHintPreferences,
} from '../difficulty/startingHints';
import { SearchBox } from '../components/SearchBox/SearchBox';
import { GameTable } from '../components/GameTable/GameTable';
import { SettingsPanel } from '../components/SettingsPanel/SettingsPanel';
import { HintPanel } from '../components/HintPanel/HintPanel';
import { DifficultyFeedback } from '../components/DifficultyFeedback/DifficultyFeedback';
import { LanguageToggle } from '../components/LanguageToggle/LanguageToggle';
import { MainMenuDialog } from '../components/MainMenuDialog/MainMenuDialog';
import { loadDisplayFields, saveDisplayFields, type DisplayField } from '../settings/displayFields';
import { clearSteamLibrary, loadSteamLibrary, saveSteamLibrary, type SteamLibrary } from '../library/steamLibrary';
import { completeSession, createGameSession, getPlayerId } from '../api/client';
import '../App.css';

const MAX_ATTEMPTS = 10;
const comparisonEngine = new ComparisonEngine();
const DIFFICULTY_STORAGE_KEY = 'steamguess-selected-difficulty-v1';
const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = {
  beginner: '入门',
  easy: '简单',
  normal: '普通',
  hard: '困难',
  hell: '地狱',
};
const POOL_MODE_STORAGE_KEY = 'steamguess-pool-mode-v1';
const STARTING_HINT_STORAGE_KEY = 'steamguess-starting-hints-v1';
type PoolMode = 'difficulty' | 'library';

function loadPoolMode(): PoolMode {
  return localStorage.getItem(POOL_MODE_STORAGE_KEY) === 'library' ? 'library' : 'difficulty';
}

function loadSelectedDifficulty(): DifficultyLevel {
  const saved = localStorage.getItem(DIFFICULTY_STORAGE_KEY);
  return DIFFICULTY_LEVELS.includes(saved as DifficultyLevel) ? saved as DifficultyLevel : 'normal';
}

function loadStartingHintPreferences(): StartingHintPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STARTING_HINT_STORAGE_KEY) || '{}') as Partial<StartingHintPreferences>;
    return {
      beginner: ['screenshot', 'review', 'none'].includes(saved.beginner || '') ? saved.beginner! : DEFAULT_STARTING_HINTS.beginner,
      easy: ['screenshot', 'review', 'none'].includes(saved.easy || '') ? saved.easy! : DEFAULT_STARTING_HINTS.easy,
    };
  } catch {
    return DEFAULT_STARTING_HINTS;
  }
}

type GamePhase = 'playing' | 'won' | 'lost' | 'surrendered';

function SinglePlayerPage() {
  const { t } = useTranslation();
  const [games, setGames] = useState<Game[]>([]);
  const [currentGame, setCurrentGame] = useState<Game | null>(null);
  const [records, setRecords] = useState<GuessRecord[]>([]);
  const [phase, setPhase] = useState<GamePhase>('playing');
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [showSettings, setShowSettings] = useState(false);
  const [difficulty, setDifficulty] = useState<DifficultyLevel>(loadSelectedDifficulty);
  const [startingHintPreferences, setStartingHintPreferences] = useState<StartingHintPreferences>(loadStartingHintPreferences);
  const [visibleFields, setVisibleFields] = useState<Set<DisplayField>>(loadDisplayFields);
  const [library, setLibrary] = useState<SteamLibrary | null>(loadSteamLibrary);
  const [poolMode, setPoolMode] = useState<PoolMode>(loadPoolMode);
  const [hintCount, setHintCount] = useState(0);
  const [showDifficultyFeedback, setShowDifficultyFeedback] = useState(false);
  const [showMainMenuDialog, setShowMainMenuDialog] = useState(false);
  const [session, setSession] = useState(createGameSession);
  const sessionCompletionRef = useRef<Promise<void> | null>(null);
  const playerId = useMemo(() => getPlayerId(), []);

  useEffect(() => {
    const controller = new AbortController();
    const initialDifficulty = loadSelectedDifficulty();
    loadGameExperience(controller.signal)
      .then(({ games: catalog }) => {
        const presetPool = catalog.filter(hasDifficulty).filter(game => isLevelInPool(game.difficulty.level, initialDifficulty));
        const savedLibrary = loadSteamLibrary();
        const savedLibraryIds = new Set(savedLibrary?.appIds ?? []);
        const savedLibraryPool = catalog.filter(hasDifficulty).filter(game => savedLibraryIds.has(game.appId));
        const useLibrary = loadPoolMode() === 'library' && savedLibraryPool.length > 0;
        if (!useLibrary && loadPoolMode() === 'library') {
          setPoolMode('difficulty');
          localStorage.setItem(POOL_MODE_STORAGE_KEY, 'difficulty');
        }
        setGames(catalog);
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
    () => games.filter(hasDifficulty).filter(game => isLevelInPool(game.difficulty.level, difficulty)),
    [difficulty, games],
  );
  const libraryPool = useMemo(
    () => games.filter(hasDifficulty).filter(game => ownedAppIds.has(game.appId)),
    [games, ownedAppIds],
  );
  const answerPool = poolMode === 'library' && libraryPool.length > 0 ? libraryPool : difficultyPool;
  const attemptsLeft = MAX_ATTEMPTS - records.length;
  const gameOver = phase !== 'playing';
  const revealAnswer = phase === 'lost' || phase === 'surrendered';
  const hasStarted = records.length > 0 || phase !== 'playing';
  const startingHintMode = resolveStartingHintMode(currentGame, difficulty, startingHintPreferences);
  const requestMainMenu = () => {
    if (!hasStarted) {
      window.location.assign('/');
      return;
    }
    setShowMainMenuDialog(true);
  };

  const handleSelectGame = (guessedGame: Game) => {
    if (!currentGame || gameOver || guessedAppIds.has(guessedGame.appId)) return;

    const result = comparisonEngine.compare(guessedGame, currentGame);
    const nextRecords = [...records, { game: guessedGame, result }];
    setRecords(nextRecords);

    const completedPhase = result.isCorrect ? 'won' : nextRecords.length >= MAX_ATTEMPTS ? 'lost' : null;
    if (completedPhase) {
      setPhase(completedPhase);
      const completion = completeSession({
        sessionId: session.id,
        playerId,
        mode: poolMode,
        difficulty,
        answerAppId: currentGame.appId,
        outcome: completedPhase,
        guesses: nextRecords.length,
        hintsUsed: hintCount,
        startingHintMode,
        startedAt: session.startedAt,
      });
      sessionCompletionRef.current = completion;
      void completion.catch(error => console.warn('Could not save game session.', error));
    }
  };

  const prepareNewRound = () => {
    setRecords([]);
    setPhase('playing');
    setHintCount(0);
    setShowDifficultyFeedback(false);
    sessionCompletionRef.current = null;
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
    const completion = completeSession({
      sessionId: session.id,
      playerId,
      mode: poolMode,
      difficulty,
      answerAppId: currentGame.appId,
      outcome: 'surrendered',
      guesses: records.length,
      hintsUsed: hintCount,
      startingHintMode,
      startedAt: session.startedAt,
    });
    sessionCompletionRef.current = completion;
    void completion.catch(error => console.warn('Could not save game session.', error));
  };

  const resetWithPool = (pool: Game[]) => {
    if (pool.length > 0) setCurrentGame(getRandomGame(pool, currentGame?.appId));
    prepareNewRound();
  };

  const changeDifficulty = (level: DifficultyLevel) => {
    setDifficulty(level);
    localStorage.setItem(DIFFICULTY_STORAGE_KEY, level);
    const pool = games.filter(hasDifficulty).filter(game => isLevelInPool(game.difficulty.level, level));
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

  const changeStartingHintMode = (mode: StartingHintMode) => {
    if (difficulty !== 'beginner' && difficulty !== 'easy') return;
    setStartingHintPreferences(previous => {
      const next = { ...previous, [difficulty]: mode };
      localStorage.setItem(STARTING_HINT_STORAGE_KEY, JSON.stringify(next));
      return next;
    });
    prepareNewRound();
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
    const nextPool = games.filter(hasDifficulty).filter(game => nextOwned.has(game.appId));
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
      <header className={`app-header ${hasStarted ? 'app-header-compact' : ''}`}>
        <div className="header-topbar">
          <div className="header-identity">
            <div className="brand-mark" aria-hidden="true">SG</div>
            <LanguageToggle />
          </div>
          <nav className="header-actions" aria-label={t('app.tools')}>
            <button className="icon-button" type="button" onClick={requestMainMenu}>
              <span>{t('app.mainMenu')}</span>
            </button>
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
            difficulty={difficulty}
            startingHintMode={startingHintMode}
            answerPoolSize={answerPool.length}
            visibleFields={visibleFields}
            library={library}
            matchedLibraryGames={libraryPool.length}
            poolMode={poolMode}
            onDifficultyChange={changeDifficulty}
            onStartingHintModeChange={changeStartingHintMode}
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
                screenshotUrls={currentGame.hints?.screenshotUrls}
                reviewTexts={currentGame.hints?.reviewTexts}
                initialHintMode={startingHintMode}
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
              initialScore={currentGame.difficulty?.score ?? 50}
              playerId={playerId}
              sessionId={session.id}
              beforeSubmit={() => sessionCompletionRef.current ?? Promise.resolve()}
              onClose={() => setShowDifficultyFeedback(false)}
            />
          )}
        </section>

        <GameTable records={records} correctGame={currentGame} revealAnswer={revealAnswer} visibleFields={visibleFields} ownedAppIds={ownedAppIds} />
      </main>

      <footer className="app-footer">
        <p>{t('app.footer')}</p>
      </footer>

      <MainMenuDialog
        open={showMainMenuDialog}
        onCancel={() => setShowMainMenuDialog(false)}
        onConfirm={() => {
          setShowMainMenuDialog(false);
          window.location.assign('/');
        }}
      />
    </div>
  );
}

export default SinglePlayerPage;
