import { useTranslation } from 'react-i18next';
import type { Game } from '../../types/game';
import type {
  ComparisonDirection,
  ComparisonResult,
  FieldComparison,
  GuessRecord,
  MatchStatus,
} from '../../types/comparison';
import './GameTable.css';

interface GameTableProps {
  records: GuessRecord[];
  correctGame: Game;
  revealAnswer: boolean;
}

interface RowData {
  game: Game;
  result: ComparisonResult;
  isAnswer: boolean;
}

function getTags(game: Game): string[] {
  return [...game.tags.developers, ...game.tags.publishers, ...game.tags.userTags].filter(Boolean);
}

function getDisplayTags(game: Game): string[] {
  return game.tags.userTags.length > 0 ? game.tags.userTags.slice(0, 8) : getTags(game).slice(0, 8);
}

function buildAnswerResult(game: Game): ComparisonResult {
  const exact = (fieldName: string, value: string | number): FieldComparison => ({
    fieldName,
    userValue: value,
    correctValue: value,
    status: 'exact',
    direction: 'equal',
  });
  const rate = game.reviews.total > 0 ? (game.reviews.positive / game.reviews.total) * 100 : 0;

  const result: ComparisonResult = {
    nameMatch: exact('Name', game.name),
    priceMatch: exact('Price', `$${game.price.us.current}`),
    ccuMatch: exact('Popularity', game.popularity.ccu.toLocaleString()),
    totalReviewsMatch: exact('Total Reviews', game.reviews.total.toLocaleString()),
    reviewsRateMatch: exact('Reviews Rate', `${rate.toFixed(1)}%`),
    releaseMatch: exact('Release Date', game.releaseDate),
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

function directionSymbol(direction: ComparisonDirection | undefined): string | null {
  if (direction === 'higher') return '↑';
  if (direction === 'lower') return '↓';
  if (direction === 'near') return '≈';
  if (direction === 'equal') return '=';
  return null;
}

export function GameTable({ records, correctGame, revealAnswer }: GameTableProps) {
  const { t } = useTranslation();
  if (records.length === 0 && !revealAnswer) return null;

  const correctTags = new Set(getTags(correctGame).map(tag => tag.toLocaleLowerCase()));
  const rows: RowData[] = records.map(record => ({ ...record, isAnswer: false }));

  if (revealAnswer && !records.some(record => record.game.appId === correctGame.appId)) {
    rows.push({ game: correctGame, result: buildAnswerResult(correctGame), isAnswer: true });
  }

  const renderFeedback = (field: FieldComparison) => {
    const symbol = directionSymbol(field.direction);
    const directionLabel = field.direction ? t(`direction.${field.direction}`) : '';
    return (
      <div className={`feedback-cell status-${field.status}`} title={directionLabel}>
        <span className="feedback-value">{String(field.userValue ?? '—')}</span>
        {symbol && <span className="feedback-arrow" aria-label={directionLabel}>{symbol}</span>}
        <span className="sr-only">{t(`status.${field.status}`)}</span>
      </div>
    );
  };

  return (
    <section className="guesses-section" aria-labelledby="guesses-title">
      <div className="table-heading">
        <div>
          <p className="eyebrow">{t('table.feedback')}</p>
          <h2 id="guesses-title">{t('table.title')}</h2>
        </div>
        <div className="legend" aria-label={t('table.legend')}>
          {(['exact', 'partial', 'close', 'wrong'] as MatchStatus[]).map(status => (
            <span key={status} className={`legend-item status-${status}`}>
              {t(`status.${status}`)}
            </span>
          ))}
        </div>
      </div>

      <div className="game-table-container">
        <table className="game-table">
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">{t('table.cover')}</span></th>
              <th scope="col">{t('table.gameName')}</th>
              <th scope="col">{t('table.price')}</th>
              <th scope="col">{t('table.peakPlayers')}</th>
              <th scope="col">{t('table.reviews')}</th>
              <th scope="col">{t('table.rate')}</th>
              <th scope="col">{t('table.releaseDate')}</th>
              <th scope="col">{t('table.tags')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ game, result, isAnswer }) => (
              <tr key={`${game.appId}-${isAnswer ? 'answer' : 'guess'}`} className={isAnswer ? 'answer-row' : ''}>
                <td className="header-image-cell">
                  <a
                    href={`https://store.steampowered.com/app/${game.appId}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="header-image-link"
                    aria-label={t('table.openSteam', { name: game.name })}
                  >
                    {game.header_image ? (
                      <img src={game.header_image} alt="" className="game-header-image" loading="lazy" />
                    ) : (
                      <span className="game-header-image placeholder" aria-hidden="true" />
                    )}
                  </a>
                </td>
                <th scope="row" className={`name-cell status-${result.nameMatch.status}`}>
                  <span className="name-mark" aria-hidden="true">{result.isCorrect ? '✓' : '×'}</span>
                  <span>{game.name}</span>
                  {isAnswer && <span className="answer-label">{t('table.answer')}</span>}
                </th>
                <td>{renderFeedback(result.priceMatch)}</td>
                <td>{renderFeedback(result.ccuMatch)}</td>
                <td>{renderFeedback(result.totalReviewsMatch)}</td>
                <td>{renderFeedback(result.reviewsRateMatch)}</td>
                <td>{renderFeedback(result.releaseMatch)}</td>
                <td>
                  <div className="meta-tags-container">
                    {getDisplayTags(game).map(tag => {
                      const shared = correctTags.has(tag.toLocaleLowerCase());
                      return (
                        <span key={tag} className={`meta-tag ${shared ? 'shared' : ''}`}>
                          {tag}
                          {shared && <span className="sr-only"> ({t('table.sharedTag')})</span>}
                        </span>
                      );
                    })}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
