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
import './App.css';

const MAX_ATTEMPTS = 10;
const comparisonEngine = new ComparisonEngine();
const DIFFICULTY_STORAGE_KEY = 'steamguess-selected-difficulty-v1';
const DIFFICULTY_LABELS: Record<DifficultyLevel, string> = { easy: '简单', normal: '普通', hard: '困难', hell: '地狱' };

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

  useEffect(() => {
    const controller = new AbortController();
    const initialDifficulty = loadSelectedDifficulty();
    loadGameExperience(controller.signal)
      .then(({ games: catalog, model }) => {
        const pool = catalog.filter(game => !game.difficulty || isLevelInPool(game.difficulty.level, initialDifficulty));
        setGames(catalog);
        setDifficultyModel(model);
        setCurrentGame(getRandomGame(pool.length > 0 ? pool : catalog));
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
  const answerPool = useMemo(
    () => games.filter(game => !game.difficulty || isLevelInPool(game.difficulty.level, difficulty)),
    [difficulty, games],
  );
  const attemptsLeft = MAX_ATTEMPTS - records.length;
  const gameOver = phase !== 'playing';
  const revealAnswer = phase === 'lost' || phase === 'surrendered';
  const hasStarted = records.length > 0 || phase !== 'playing';

  const handleSelectGame = (guessedGame: Game) => {
    if (!currentGame || gameOver || guessedAppIds.has(guessedGame.appId)) return;

    const result = comparisonEngine.compare(guessedGame, currentGame);
    const nextRecords = [...records, { game: guessedGame, result }];
    setRecords(nextRecords);

    if (result.isCorrect) setPhase('won');
    else if (nextRecords.length >= MAX_ATTEMPTS) setPhase('lost');
  };

  const handleNewGame = () => {
    if (answerPool.length === 0) return;
    setCurrentGame(getRandomGame(answerPool, currentGame?.appId));
    setRecords([]);
    setPhase('playing');
  };

  const changeLanguage = (language: 'zh' | 'en') => {
    void i18n.changeLanguage(language);
    localStorage.setItem('steamguess-language', language);
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
  };

  const changeDifficulty = (level: DifficultyLevel) => {
    setDifficulty(level);
    localStorage.setItem(DIFFICULTY_STORAGE_KEY, level);
    const pool = games.filter(game => !game.difficulty || isLevelInPool(game.difficulty.level, level));
    if (pool.length > 0) setCurrentGame(getRandomGame(pool, currentGame?.appId));
    setRecords([]);
    setPhase('playing');
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
          <button
            className="icon-button"
            type="button"
            onClick={() => setShowSettings(open => !open)}
            aria-expanded={showSettings}
            aria-controls="settings-panel"
          >
            <span aria-hidden="true">⚙</span>
            <span>{t('app.settings')}</span>
          </button>
        </div>

        {showSettings && (
          <div className="settings-panel" id="settings-panel">
            <span>{t('app.language')}</span>
            <div className="segmented-control" aria-label={t('app.language')}>
              <button type="button" onClick={() => changeLanguage('zh')} aria-pressed={i18n.language.startsWith('zh')}>
                中文
              </button>
              <button type="button" onClick={() => changeLanguage('en')} aria-pressed={i18n.language.startsWith('en')}>
                English
              </button>
            </div>
            <span>{t('app.difficulty')}</span>
            <div className="segmented-control difficulty-control" aria-label={t('app.difficulty')}>
              {DIFFICULTY_LEVELS.map(level => (
                <button type="button" key={level} onClick={() => changeDifficulty(level)} aria-pressed={difficulty === level}>
                  {i18n.language.startsWith('zh') ? DIFFICULTY_LABELS[level] : level[0].toUpperCase() + level.slice(1)}
                </button>
              ))}
            </div>
            <small className="model-status">
              {difficultyModel
                ? t('app.modelReady', { count: difficultyModel.trainingLabels, pool: answerPool.length })
                : t('app.modelFallback', { pool: answerPool.length })}
            </small>
          </div>
        )}

        <div className="hero-copy">
          <p className="eyebrow">Steam Games · {t('app.eyebrow', { count: answerPool.length })} · {DIFFICULTY_LABELS[difficulty]}</p>
          <h1>{t('app.title')}</h1>
          <p>{t('app.subtitle')}</p>
        </div>
      </header>

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
              <button className="btn btn-quiet" type="button" onClick={() => setPhase('surrendered')} disabled={gameOver}>
                {t('app.surrender')}
              </button>
            </div>
          </div>

          {phase !== 'playing' && (
            <div className={`outcome-card outcome-${phase}`} role="status" aria-live="polite">
              <div>
                <p className="outcome-kicker">{t(`outcome.${phase}.kicker`)}</p>
                <h2>{t(`outcome.${phase}.title`, { name: currentGame.name })}</h2>
                <p>{t(`outcome.${phase}.message`, { count: records.length })}</p>
              </div>
              <button className="btn btn-primary" type="button" onClick={handleNewGame}>
                {t('app.playAgain')}
              </button>
            </div>
          )}
        </section>

        <GameTable records={records} correctGame={currentGame} revealAnswer={revealAnswer} />
      </main>

      <footer className="app-footer">
        <p>{t('app.footer')}</p>
      </footer>
    </div>
  );
}

export default App;
