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
    popularityMatch: exactField('Popularity', popularityValue),
    reviewsMatch: exactField('Reviews', reviewValue),
    releaseMatch: exactField('Release Date', game.releaseDate),
    allFieldsMatches: [],
    isCorrect: true,
  };

  result.allFieldsMatches = [
    result.nameMatch,
    result.priceMatch,
    result.popularityMatch,
    result.reviewsMatch,
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
                  <div className={`feedback-cell status-${result.popularityMatch.status}`}>
                    <span className="feedback-value">{String(result.popularityMatch.userValue ?? '—')}</span>
                    {resolveArrow(result.popularityMatch.display) && (
                      <span className="feedback-arrow">{resolveArrow(result.popularityMatch.display)}</span>
                    )}
                  </div>
                </td>
                <td>
                  <div className="feedback-cell">
                    <span className="feedback-value">{guess.reviews.total}</span>
                  </div>
                </td>
                <td>
                  <div className={`feedback-cell status-${result.reviewsMatch.status}`}>
                    <span className="feedback-value">{guess.reviews.total > 0 ? Math.round((guess.reviews.positive / guess.reviews.total) * 100) : 0}%</span>
                    {resolveArrow(result.reviewsMatch.display) && (
                      <span className="feedback-arrow">{resolveArrow(result.reviewsMatch.display)}</span>
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
