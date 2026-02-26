import type { Game } from '../../types/game';
import type { ComparisonResult, FieldComparison } from '../../types/comparison';
import { useTranslation } from 'react-i18next';
import './GameTable.css';

interface GameTableProps {
  guesses: Game[];
  correctGame: Game;
  comparisonResults: ComparisonResult[];
  flipArrowLogic?: boolean;
  revealAnswerRow?: boolean;
}



function getTagsForMatching(game: Game): string[] {
  const { developers, publishers, userTags } = game.tags;
  return [...developers, ...publishers, ...userTags].filter(Boolean);
}

function getTagsForDisplay(game: Game): string[] {
  const { userTags } = game.tags;
  return userTags.length > 0 ? userTags : getTagsForMatching(game);
}

function buildExactResult(game: Game): ComparisonResult {
  const exactField = (fieldName: string, value: unknown): FieldComparison => ({
    fieldName,
    userValue: value,
    correctValue: value,
    status: 'exact',
    // display: '≈',
  });

  const nameMatch: FieldComparison = {
    fieldName: 'Name',
    userValue: game.name,
    correctValue: game.name,
    status: 'exact',
  };

  const priceValue = `$${game.price.us.current}`;
  const popularityValue = String(game.popularity.ccu);
  const rate = game.reviews.total > 0 ? ((game.reviews.positive / game.reviews.total) * 100).toFixed(1) : '0.0';
  const reviewValue = `${game.reviews.total} reviews, ${rate}% positive`;


  const result: ComparisonResult = {
    nameMatch,
    priceMatch: exactField('Price', priceValue),
    ccuMatch: exactField('Popularity', popularityValue),
    totalReviewsMatch: exactField('Total Reviews', game.reviews.total),
    reviewsRateMatch: exactField('Reviews', reviewValue),
    releaseMatch: exactField('Release Date', game.releaseDate),
    allFieldsMatches: [],
    isCorrect: true,
  };

  result.allFieldsMatches = [
    result.nameMatch,
    result.priceMatch,
    result.ccuMatch,
    result.totalReviewsMatch,
    result.reviewsRateMatch,
    result.releaseMatch,
  ];

  return result;
}

export function GameTable({ guesses, correctGame, comparisonResults, flipArrowLogic = false, revealAnswerRow = false }: GameTableProps) {
  const { t } = useTranslation();
  if (guesses.length === 0 && !revealAnswerRow) return null;

  const resolveArrow = (display: string | undefined): string | undefined => {
    if (!display || display === '≈' || display === '=') return display;
    const base = display === '↑' ? '↓' : display === '↓' ? '↑' : display;
    if (!flipArrowLogic) return base;
    return base === '↑' ? '↓' : base === '↓' ? '↑' : base;
  };

  const correctTagSet = new Set(getTagsForMatching(correctGame).map(tag => tag.toLowerCase()));
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
            <th>{t('table.gameName')}</th>
            <th>{t('table.price')}</th>
            <th>{t('table.peakPlayers')}</th>
            <th>{t('table.reviews')}</th>
            <th>{t('table.rate')}</th>
            <th>{t('table.releaseDate')}</th>
            <th>{t('table.tags')}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ game: guess, result, isAnswerRow }, index) => {
            const displayTags = getTagsForDisplay(guess);

            return (
              <tr key={index} className={isAnswerRow ? 'answer-row' : ''}>
                <td className="header-image-cell">
                  <a
                    href={`https://store.steampowered.com/app/${guess.appId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="header-image-link"
                    aria-label={t('table.openSteam', { name: guess.name })}
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
                  {guess.name}{isAnswerRow ? t('table.answerSuffix') : ''}
                </td>
                <td>
                  <div className={`feedback-cell status-${result.priceMatch.status}`}>
                    <span className="feedback-value">{String(result.priceMatch.userValue ?? '—')}</span>
                    {resolveArrow(result.priceMatch.display) && (
                      <span className="feedback-arrow">{resolveArrow(result.priceMatch.display)}</span>
                    )}
                  </div>
                </td>
                <td>
                  <div className={`feedback-cell status-${result.ccuMatch.status}`}>
                    <span className="feedback-value">{String(result.ccuMatch.userValue ?? '—')}</span>
                    {resolveArrow(result.ccuMatch.display) && (
                      <span className="feedback-arrow">{resolveArrow(result.ccuMatch.display)}</span>
                    )}
                  </div>
                </td>
                
                <td>
                  <div className={`feedback-cell status-${result.totalReviewsMatch.status}`}>
                    <span className="feedback-value">{String(result.totalReviewsMatch.userValue ?? '—')}</span>
                    {resolveArrow(result.totalReviewsMatch.display) && (
                      <span className="feedback-arrow">{resolveArrow(result.totalReviewsMatch.display)}</span>
                    )}
                  </div>
                </td>

                <td>
                  <div className={`feedback-cell status-${result.reviewsRateMatch.status}`}>
                    <span className="feedback-value">{String(result.reviewsRateMatch.userValue ?? '—')}%</span>
                    {resolveArrow(result.reviewsRateMatch.display) && (
                      <span className="feedback-arrow">{resolveArrow(result.reviewsRateMatch.display)}</span>
                    )}
                  </div>
                </td>
                <td>
                  <div className={`feedback-cell status-${result.releaseMatch.status}`}>
                    <span className="feedback-value">{String(result.releaseMatch.userValue ?? '—')}</span>
                    {resolveArrow(result.releaseMatch.display) && (
                      <span className="feedback-arrow">{resolveArrow(result.releaseMatch.display)}</span>
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
