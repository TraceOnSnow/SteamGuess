import { useState } from 'react';
import type { Game, PlayerGuess } from './types/game';
import type { ComparisonResult } from './types/comparison';
import { ComparisonEngine } from './engine/ComparisonEngine.ts';
import { sampleGames, getRandomGame } from './data/games';
import { SearchBox } from './components/SearchBox/SearchBox';
import { GameTable } from './components/GameTable/GameTable';
import './App.css';

function App() {
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
    const result = comparisonEngine.compare(guessedGame as PlayerGuess, currentGame);

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
      alert(`🎉 Correct! ${guessedGame.name} is the answer!\nYou used ${newGuesses.length} attempts.`);
    }

    // Check lose condition
    if (newAttemptsLeft === 0 && !result.isCorrect) {
      setGameOver(true);
      setSurrendered(false);
      alert(`❌ Game Over! The answer was: ${currentGame.name}`);
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
    alert(`🏳️ You surrendered.\nAnswer: ${currentGame.name}`);
  };

  return (
    <div className="app">
      <header className="app-header">
        <button
          className="settings-btn"
          onClick={() => setShowSettings(prev => !prev)}
          aria-label="Open settings"
        >
          ⚙️ Settings
        </button>

        {showSettings && (
          <div className="settings-panel">
            <label className="settings-item">
              <input
                type="checkbox"
                checked={flipArrowLogic}
                onChange={e => setFlipArrowLogic(e.target.checked)}
              />
              <span>翻转箭头逻辑</span>
            </label>
          </div>
        )}

        <h1>🎮 SteamGuess</h1>
        <p>Guess the Steam game based on the clues!</p>
      </header>

      <main className="app-main">
        {!currentGame ? (
          <div className="no-game">
            <p>No game loaded</p>
            <button onClick={handleNewGame}>Start Game</button>
          </div>
        ) : (
          <>
            <div className="game-status">
              <div className="status-item">
                <span className="label">Attempts Left:</span>
                <span className={`value ${attemptsLeft <= 3 ? 'warning' : ''}`}>
                  {attemptsLeft}
                </span>
              </div>
              <div className="status-item">
                <span className="label">Guesses Made:</span>
                <span className="value">{guesses.length}</span>
              </div>
              <div className="status-actions">
                <button className="btn btn-danger" onClick={handleSurrender} disabled={gameOver}>
                  Surrender
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
                  Play Again
                </button>
              </div>
            )}
          </>
        )}
      </main>

      <footer className="app-footer">
        <p>SteamGuess © 2025 | MVP v0.1</p>
      </footer>
    </div>
  );
}

export default App;
