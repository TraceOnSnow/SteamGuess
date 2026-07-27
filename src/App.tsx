import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Game } from './types/game';
import type { GuessRecord } from './types/comparison';
import { ComparisonEngine } from './engine/ComparisonEngine';
import { getRandomGame, loadGames } from './data/games';
import { SearchBox } from './components/SearchBox/SearchBox';
import { GameTable } from './components/GameTable/GameTable';
import './App.css';

const MAX_ATTEMPTS = 10;
const comparisonEngine = new ComparisonEngine();
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

  useEffect(() => {
    const controller = new AbortController();
    loadGames(controller.signal)
      .then(catalog => {
        setGames(catalog);
        setCurrentGame(getRandomGame(catalog));
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
  const attemptsLeft = MAX_ATTEMPTS - records.length;
  const gameOver = phase !== 'playing';
  const revealAnswer = phase === 'lost' || phase === 'surrendered';

  const handleSelectGame = (guessedGame: Game) => {
    if (!currentGame || gameOver || guessedAppIds.has(guessedGame.appId)) return;

    const result = comparisonEngine.compare(guessedGame, currentGame);
    const nextRecords = [...records, { game: guessedGame, result }];
    setRecords(nextRecords);

    if (result.isCorrect) setPhase('won');
    else if (nextRecords.length >= MAX_ATTEMPTS) setPhase('lost');
  };

  const handleNewGame = () => {
    if (games.length === 0) return;
    setCurrentGame(getRandomGame(games, currentGame?.appId));
    setRecords([]);
    setPhase('playing');
  };

  const changeLanguage = (language: 'zh' | 'en') => {
    void i18n.changeLanguage(language);
    localStorage.setItem('steamguess-language', language);
    document.documentElement.lang = language === 'zh' ? 'zh-CN' : 'en';
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
    <div className="app">
      <a className="skip-link" href="#game-main">{t('app.skipToGame')}</a>
      <header className="app-header">
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
          </div>
        )}

        <div className="hero-copy">
          <p className="eyebrow">{t('app.eyebrow', { count: games.length })}</p>
          <h1>{t('app.title')}</h1>
          <p>{t('app.subtitle')}</p>
        </div>
      </header>

      <main className="app-main" id="game-main">
        <section className="game-panel" aria-labelledby="guess-heading">
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

          <div className="guess-prompt">
            <h2 id="guess-heading">{t('app.guessHeading')}</h2>
            <p>{t('app.guessHelp')}</p>
          </div>

          <SearchBox
            games={games}
            excludedAppIds={guessedAppIds}
            onSelectGame={handleSelectGame}
            isDisabled={gameOver}
          />

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
