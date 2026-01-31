import type { Game } from '../../types/game';
import type { ComparisonResult } from '../../types/comparison';
import { getStatusColor } from '../../config/comparison';
import './GameTable.css';

interface GameTableProps {
  guesses: Game[];
  correctGame: Game;
  comparisonResults: ComparisonResult[];
}

export function GameTable({ guesses, correctGame, comparisonResults }: GameTableProps) {
  if (guesses.length === 0) return null;

  return (
    <div className="game-table-container">
      <table className="game-table">
        <thead>
          <tr>
            <th>Game Name</th>
            <th>Players</th>
            <th>Price</th>
            <th>Popularity</th>
            <th>Reviews</th>
            <th>Release</th>
            <th>Tags</th>
          </tr>
        </thead>
        <tbody>
          {guesses.map((guess, index) => {
            const result = comparisonResults[index];
            return (
              <tr key={index}>
                <td style={{ backgroundColor: getStatusColor(result.nameMatch.status) }}>
                  <span className="status-badge">{result.nameMatch.status === 'exact' ? '✓' : '✗'}</span>
                  {guess.name}
                </td>
                <td style={{ backgroundColor: getStatusColor(result.playerMatch.status) }}>
                  {result.playerMatch.display || '○'}
                </td>
                <td style={{ backgroundColor: getStatusColor(result.priceMatch.status) }}>
                  {result.priceMatch.display || '○'}
                </td>
                <td style={{ backgroundColor: getStatusColor(result.popularityMatch.status) }}>
                  {result.popularityMatch.display || '○'}
                </td>
                <td style={{ backgroundColor: getStatusColor(result.reviewsMatch.status) }}>
                  {result.reviewsMatch.display || '○'}
                </td>
                <td style={{ backgroundColor: getStatusColor(result.releaseMatch.status) }}>
                  {result.releaseMatch.display || '○'}
                </td>
                <td style={{ backgroundColor: getStatusColor(result.tagsMatch.status) }}>
                  <span className="tags-display">
                    {result.tagsMatch.userValue}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div className="correct-answer-section">
        <h3>Correct Answer</h3>
        <div className="correct-game-info">
          <div><strong>Name:</strong> {correctGame.name}</div>
          <div><strong>Players:</strong> {correctGame.players.singlePlayer ? 'Single' : ''} {correctGame.players.multiplayer ? 'Multi' : ''} {correctGame.players.online ? 'Online' : ''}</div>
          <div><strong>Price:</strong> ${correctGame.price.current}</div>
          <div><strong>Release:</strong> {correctGame.releaseDate}</div>
        </div>
      </div>
    </div>
  );
}
