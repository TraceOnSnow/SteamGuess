import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Game } from './types/game';
import type { ComparisonResult } from './types/comparison';
import { ComparisonEngine } from './engine/ComparisonEngine.ts';
import { sampleGames, getRandomGame } from './data/games';
import { SearchBox } from './components/SearchBox/SearchBox';
import { GameTable } from './components/GameTable/GameTable';
import './App.css';

function App() {
  const { t, i18n } = useTranslation();
  const [currentGame, setCurrentGame] = useState<Game | null>(() => (sampleGames.length > 0 ? getRandomGame() : null));
  const [guesses, setGuesses] = useState<Game[]>([]);
  const [comparisonResults, setComparisonResults] = useState<ComparisonResult[]>([]);
  const [gameOver, setGameOver] = useState(false);
  const [surrendered, setSurrendered] = useState(false);
  const [attemptsLeft, setAttemptsLeft] = useState(10);
  const [showSettings, setShowSettings] = useState(false);
  const [flipArrowLogic, setFlipArrowLogic] = useState(false);

  const comparisonEngine = new ComparisonEngine();

  const handleSelectGame = (guessedGame: Game) => {
    if (gameOver || !currentGame) return;

    // Perform comparison
    const result = comparisonEngine.compare(guessedGame, currentGame);

    // Update state
    const newGuesses = [...guesses, guessedGame];
    const newResults = [...comparisonResults, result];
    const newAttemptsLeft = attemptsLeft - 1;

    setGuesses(newGuesses);
    setComparisonResults(newResults);
    setAttemptsLeft(newAttemptsLeft);

    // Check win condition
    if (result.isCorrect) {
      setGameOver(true);
      setSurrendered(false);
      alert(t('app.alertCorrect', { name: guessedGame.name, count: newGuesses.length }));
    }

    // Check lose condition
    if (newAttemptsLeft === 0 && !result.isCorrect) {
      setGameOver(true);
      setSurrendered(false);
      alert(t('app.alertGameOver', { name: currentGame.name }));
    }
  };

  const handleNewGame = () => {
    if (sampleGames.length === 0) {
      setCurrentGame(null);
      return;
    }

    let randomGame = getRandomGame();
    if (sampleGames.length > 1 && currentGame) {
      while (randomGame.appId === currentGame.appId) {
        randomGame = getRandomGame();
      }
    }

    setCurrentGame(randomGame);
    setGuesses([]);
    setComparisonResults([]);
    setGameOver(false);
    setSurrendered(false);
    setAttemptsLeft(10);
  };

  const handleSurrender = () => {
    if (!currentGame || gameOver) return;
    setGameOver(true);
    setSurrendered(true);
    alert(t('app.alertSurrender', { name: currentGame.name }));
  };

  return (
    <div className="app">
      <header className="app-header">
        <button
          className="settings-btn"
          onClick={() => setShowSettings(prev => !prev)}
          aria-label={t('app.openSettings')}
        >
          ⚙️ {t('app.settings')}
        </button>

        {showSettings && (
          <div className="settings-panel">
            <label className="settings-item">
              <input
                type="checkbox"
                checked={flipArrowLogic}
                onChange={e => setFlipArrowLogic(e.target.checked)}
              />
              <span>{t('app.flipArrowLogic')}</span>
            </label>
            <div className="settings-item" style={{ marginTop: 8 }}>
              <span>{t('app.language')}</span>
              <button
                className="btn btn-primary"
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => i18n.changeLanguage('zh')}
                disabled={i18n.language.startsWith('zh')}
              >
                {t('app.chinese')}
              </button>
              <button
                className="btn btn-primary"
                style={{ padding: '4px 10px', fontSize: 12 }}
                onClick={() => i18n.changeLanguage('en')}
                disabled={i18n.language.startsWith('en')}
              >
                {t('app.english')}
              </button>
            </div>
          </div>
        )}

        <h1>{t('app.title')}</h1>
        <p>{t('app.subtitle')}</p>
      </header>

      <main className="app-main">
        {!currentGame ? (
          <div className="no-game">
            <p>{t('app.noGameLoaded')}</p>
            <button onClick={handleNewGame}>{t('app.startGame')}</button>
          </div>
        ) : (
          <>
            <div className="game-status">
              <div className="status-item">
                <span className="label">{t('app.attemptsLeft')}</span>
                <span className={`value ${attemptsLeft <= 3 ? 'warning' : ''}`}>
                  {attemptsLeft}
                </span>
              </div>
              <div className="status-item">
                <span className="label">{t('app.guessesMade')}</span>
                <span className="value">{guesses.length}</span>
              </div>
              <div className="status-actions">
                <button className="btn btn-danger" onClick={handleSurrender} disabled={gameOver}>
                  {t('app.surrender')}
                </button>
              </div>
            </div>

            <SearchBox onSelectGame={handleSelectGame} isDisabled={gameOver} />

            {(guesses.length > 0 || surrendered) && (
              <GameTable
                guesses={guesses}
                correctGame={currentGame}
                comparisonResults={comparisonResults}
                flipArrowLogic={flipArrowLogic}
                revealAnswerRow={surrendered}
              />
            )}

            {gameOver && (
              <div className="game-over-section">
                <button className="btn btn-primary" onClick={handleNewGame}>
                  {t('app.playAgain')}
                </button>
              </div>
            )}
          </>
        )}
      </main>

      <footer className="app-footer">
        <p>{t('app.footer')}</p>
      </footer>
    </div>
  );
}

export default App;
