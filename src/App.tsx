import { useState } from 'react';
import type { Game, PlayerGuess } from './types/game';
import type { ComparisonResult } from './types/comparison';
import { ComparisonEngine } from './engine/ComparisonEngine';
import { sampleGames, getGameById } from './data/games';
import { SearchBox } from './components/SearchBox/SearchBox';
import { GameTable } from './components/GameTable/GameTable';
import './App.css';

function App() {
  const [currentGame, setCurrentGame] = useState<Game | null>(sampleGames[0]);
  const [guesses, setGuesses] = useState<Game[]>([]);
  const [comparisonResults, setComparisonResults] = useState<ComparisonResult[]>([]);
  const [gameOver, setGameOver] = useState(false);
  const [attemptsLeft, setAttemptsLeft] = useState(10);

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
      alert(`🎉 Correct! ${guessedGame.name} is the answer!\nYou used ${newGuesses.length} attempts.`);
    }

    // Check lose condition
    if (newAttemptsLeft === 0 && !result.isCorrect) {
      setGameOver(true);
      alert(`❌ Game Over! The answer was: ${currentGame.name}`);
    }
  };

  const handleNewGame = () => {
    const randomGame = sampleGames[Math.floor(Math.random() * sampleGames.length)];
    setCurrentGame(randomGame);
    setGuesses([]);
    setComparisonResults([]);
    setGameOver(false);
    setAttemptsLeft(10);
  };

  return (
    <div className="app">
      <header className="app-header">
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
            </div>

            <SearchBox onSelectGame={handleSelectGame} isDisabled={gameOver} />

            {guesses.length > 0 && (
              <GameTable
                guesses={guesses}
                correctGame={currentGame}
                comparisonResults={comparisonResults}
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
