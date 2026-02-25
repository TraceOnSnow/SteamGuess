import type { Game } from '../../types/game';
import type { ComparisonResult, FieldComparison } from '../../types/comparison';
import './GameTable.css';

interface GameTableProps {
  guesses: Game[];
  correctGame: Game;
  comparisonResults: ComparisonResult[];
  flipArrowLogic?: boolean;
  revealAnswerRow?: boolean;
}

type MetricStatus = 'exact' | 'partial' | 'close' | 'wrong';

function getPercentDiff(user: number, correct: number): number {
  if (correct === 0) return user === 0 ? 0 : 100;
  return Math.abs((user - correct) / correct) * 100;
}

function getMetricStatusByPercentDiff(diffPercent: number): MetricStatus {
  if (diffPercent <= 20) return 'exact';
  if (diffPercent <= 50) return 'partial';
  if (diffPercent <= 100) return 'close';
  return 'wrong';
}

function getArrow(user: number, correct: number, flipArrowLogic = false): string {
  if (user === correct) return '≈';
  const defaultArrow = user > correct ? '↓' : '↑';
  if (!flipArrowLogic) return defaultArrow;
  return defaultArrow === '↑' ? '↓' : '↑';
}

function resolveDisplayArrow(display: string | undefined, flipArrowLogic = false): string | undefined {
  if (!display || display === '≈') return display;
  const defaultArrow = display === '↑' ? '↓' : display === '↓' ? '↑' : display;
  if (!flipArrowLogic) return defaultArrow;
  if (defaultArrow === '↑') return '↓';
  if (defaultArrow === '↓') return '↑';
  return defaultArrow;
}

function getPositiveRate(total: number, positive: number): number {
  if (total <= 0) return 0;
  return Math.round((positive / total) * 100);
}

function extractTagList(game: Game): string[] {
  const tags = game.tags as unknown as {
    userTags?: string[];
    genres?: string[];
    developer?: string;
    publisher?: string;
    developers?: string[];
    publishers?: string[];
  };

  const userTags = Array.isArray(tags.userTags) ? tags.userTags : [];
  const genres = Array.isArray(tags.genres) ? tags.genres : [];
  const developers = Array.isArray(tags.developers)
    ? tags.developers
    : tags.developer
      ? [tags.developer]
      : [];
  const publishers = Array.isArray(tags.publishers)
    ? tags.publishers
    : tags.publisher
      ? [tags.publisher]
      : [];

  return [...developers, ...publishers, ...userTags, ...genres].filter(Boolean);
}

function extractDisplayTags(game: Game): string[] {
  const tags = game.tags as unknown as { userTags?: string[] };
  if (Array.isArray(tags.userTags) && tags.userTags.length > 0) {
    return tags.userTags;
  }
  return extractTagList(game);
}

function buildExactResult(game: Game): ComparisonResult {
  const exactField = (fieldName: string, value: unknown): FieldComparison => ({
    fieldName,
    userValue: value,
    correctValue: value,
    status: 'exact',
    display: '≈',
  });

  const nameMatch: FieldComparison = {
    fieldName: 'Name',
    userValue: game.name,
    correctValue: game.name,
    status: 'exact',
  };

  const priceValue = `$${game.price.us.current}`;
  const popularityValue = `${game.popularity.ccu} (owners: ${game.popularity.owners})`;
  const rate = game.reviews.total > 0 ? Math.round((game.reviews.positive / game.reviews.total) * 100) : 0;
  const reviewValue = `${game.reviews.total} reviews, ${rate}% positive`;
  const tagsValue = extractTagList(game).join(', ');

  const result: ComparisonResult = {
    nameMatch,
    priceMatch: exactField('Price', priceValue),
    popularityMatch: exactField('Popularity', popularityValue),
    reviewsMatch: exactField('Reviews', reviewValue),
    releaseMatch: exactField('Release Date', game.releaseDate),
    tagsMatch: exactField('Tags', tagsValue),
    allFieldsMatches: [],
    isCorrect: true,
  };

  result.allFieldsMatches = [
    result.nameMatch,
    result.priceMatch,
    result.popularityMatch,
    result.reviewsMatch,
    result.releaseMatch,
    result.tagsMatch,
  ];

  return result;
}

export function GameTable({ guesses, correctGame, comparisonResults, flipArrowLogic = false, revealAnswerRow = false }: GameTableProps) {
  if (guesses.length === 0 && !revealAnswerRow) return null;

  const correctTagSet = new Set(extractTagList(correctGame).map(tag => tag.toLowerCase()));
  const rows = guesses.map((game, index) => ({
    game,
    result: comparisonResults[index],
    isAnswerRow: false,
  }));

  if (revealAnswerRow) {
    rows.push({
      game: correctGame,
      result: buildExactResult(correctGame),
      isAnswerRow: true,
    });
  }

  return (
    <div className="game-table-container">
      <table className="game-table">
        <thead>
          <tr>
            <th></th>
            <th>Game Name</th>
            <th>Price</th>
            <th>Popularity</th>
            <th>Reviews</th>
            <th>Release</th>
            <th>Tags</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ game: guess, result, isAnswerRow }, index) => {
            const displayTags = extractDisplayTags(guess);

            return (
              <tr key={index} className={isAnswerRow ? 'answer-row' : ''}>
                <td className="header-image-cell">
                  <a
                    href={`https://store.steampowered.com/app/${guess.appId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="header-image-link"
                    aria-label={`Open ${guess.name} on Steam`}
                  >
                    {guess.header_image ? (
                      <img
                        src={guess.header_image}
                        alt={guess.name}
                        className="game-header-image"
                        loading="lazy"
                      />
                    ) : (
                      <div className="game-header-image placeholder" />
                    )}
                  </a>
                </td>
                <td className={`name-cell status-${result.nameMatch.status}`}>
                  <span className="status-badge">{result.nameMatch.status === 'exact' ? '✓' : '✗'}</span>
                  {guess.name}{isAnswerRow ? ' (Answer)' : ''}
                </td>
                <td>
                  <div className={`feedback-cell status-${result.priceMatch.status}`}>
                    <span className="feedback-value">{String(result.priceMatch.userValue ?? '—')}</span>
                    {resolveDisplayArrow(result.priceMatch.display, flipArrowLogic) && (
                      <span className="feedback-arrow">{resolveDisplayArrow(result.priceMatch.display, flipArrowLogic)}</span>
                    )}
                  </div>
                </td>
                <td>
                  <div className="metric-boxes">
                    {(() => {
                      const ccuStatus = getMetricStatusByPercentDiff(
                        getPercentDiff(guess.popularity.ccu, correctGame.popularity.ccu)
                      );
                      const ownersStatus = getMetricStatusByPercentDiff(
                        getPercentDiff(guess.popularity.owners, correctGame.popularity.owners)
                      );
                      return (
                        <>
                          <div className={`mini-feedback status-${ccuStatus}`}>
                            <span className="mini-label">CCU</span>
                            <span className="mini-value">{guess.popularity.ccu}</span>
                            <span className="feedback-arrow">{getArrow(guess.popularity.ccu, correctGame.popularity.ccu, flipArrowLogic)}</span>
                          </div>
                          <div className={`mini-feedback status-${ownersStatus}`}>
                            <span className="mini-label">Owners</span>
                            <span className="mini-value">{guess.popularity.owners}</span>
                            <span className="feedback-arrow">{getArrow(guess.popularity.owners, correctGame.popularity.owners, flipArrowLogic)}</span>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </td>
                <td>
                  <div className="metric-boxes">
                    {(() => {
                      const guessRate = getPositiveRate(guess.reviews.total, guess.reviews.positive);
                      const correctRate = getPositiveRate(correctGame.reviews.total, correctGame.reviews.positive);
                      const totalStatus = getMetricStatusByPercentDiff(
                        getPercentDiff(guess.reviews.total, correctGame.reviews.total)
                      );
                      const rateStatus = getMetricStatusByPercentDiff(
                        getPercentDiff(guessRate, correctRate)
                      );
                      return (
                        <>
                          <div className={`mini-feedback status-${totalStatus}`}>
                            <span className="mini-label">Total</span>
                            <span className="mini-value">{guess.reviews.total}</span>
                            <span className="feedback-arrow">{getArrow(guess.reviews.total, correctGame.reviews.total, flipArrowLogic)}</span>
                          </div>
                          <div className={`mini-feedback status-${rateStatus}`}>
                            <span className="mini-label">Rate</span>
                            <span className="mini-value">{guessRate}%</span>
                            <span className="feedback-arrow">{getArrow(guessRate, correctRate, flipArrowLogic)}</span>
                          </div>
                        </>
                      );
                    })()}
                  </div>
                </td>
                <td>
                  <div className={`feedback-cell status-${result.releaseMatch.status}`}>
                    <span className="feedback-value">{String(result.releaseMatch.userValue ?? '—')}</span>
                    {resolveDisplayArrow(result.releaseMatch.display, flipArrowLogic) && (
                      <span className="feedback-arrow">{resolveDisplayArrow(result.releaseMatch.display, flipArrowLogic)}</span>
                    )}
                  </div>
                </td>
                <td>
                  <div className="meta-tags-container">
                    {displayTags.map((tag, tagIndex) => {
                      const matched = correctTagSet.has(tag.toLowerCase());
                      return (
                        <span
                          key={`${index}-${tag}-${tagIndex}`}
                          className={`meta-tag ${matched ? 'shared' : ''}`}
                        >
                          {tag}
                        </span>
                      );
                    })}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
