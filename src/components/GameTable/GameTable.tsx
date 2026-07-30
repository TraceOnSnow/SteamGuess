import { useTranslation } from 'react-i18next';
import { localizedTagName } from '../../data/localization';
import type { Game } from '../../types/game';
import type {
  ComparisonDirection,
  ComparisonResult,
  FieldComparison,
  GuessRecord,
  MatchStatus,
} from '../../types/comparison';
import { buildMetadataMatchSets, getCompanies, isSharedCompany, orderByMatch } from './metadata';
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
    priceMatch: exact('Price', `$${game.price.us.regular}`),
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
  const { t, i18n } = useTranslation();
  if (records.length === 0 && !revealAnswer) return null;

  const correctTags = buildMetadataMatchSets(correctGame);
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
        <h2 id="guesses-title">{t('table.title')}</h2>
        <div className="legend" aria-label={t('table.legend')}>
          {(['exact', 'partial', 'close', 'wrong'] as MatchStatus[]).map(status => (
            <span key={status} className={`legend-item status-${status}`}>{t(`status.${status}`)}</span>
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
              <th scope="col" className="companies-cell">{t('table.companies')}</th>
              <th scope="col" className="tags-cell">{t('table.tags')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ game, result, isAnswer }) => {
              const companies = getCompanies(game).sort((a, b) =>
                Number(isSharedCompany(b, correctTags)) - Number(isSharedCompany(a, correctTags)),
              );
              const userTags = orderByMatch(game.tags.userTags, correctTags.user).slice(0, 20);
              return (
                <tr key={`${game.appId}-${isAnswer ? 'answer' : 'guess'}`} className={isAnswer ? 'answer-row' : ''}>
                  <td className="header-image-cell">
                    <a href={`https://store.steampowered.com/app/${game.appId}`} target="_blank" rel="noopener noreferrer" className="header-image-link" aria-label={t('table.openSteam', { name: game.name })}>
                      {game.header_image
                        ? <img src={game.header_image} alt="" className="game-header-image" loading="lazy" />
                        : <span className="game-header-image placeholder" aria-hidden="true" />}
                    </a>
                  </td>
                  <th scope="row" className="name-cell">
                    <span className={`name-result status-${result.nameMatch.status}`}>
                      <span className="name-mark" aria-hidden="true">{result.isCorrect ? '✓' : '×'}</span>
                      <span>{game.localizedNames?.zh && i18n.language.startsWith('zh') ? game.localizedNames.zh : game.name}</span>
                    </span>
                    {isAnswer && <span className="answer-label">{t('table.answer')}</span>}
                  </th>
                  <td>{renderFeedback(result.priceMatch)}</td>
                  <td>{renderFeedback(result.ccuMatch)}</td>
                  <td>{renderFeedback(result.totalReviewsMatch)}</td>
                  <td>{renderFeedback(result.reviewsRateMatch)}</td>
                  <td>{renderFeedback(result.releaseMatch)}</td>
                  <td className="companies-cell">
                    <div className="company-tags-container">
                      {companies.map(company => {
                        const shared = isSharedCompany(company, correctTags);
                        return (
                          <span key={company.value.toLocaleLowerCase()} className={`meta-tag company-tag ${shared ? 'shared' : ''}`}>
                            {company.value}{shared && <span className="match-check" aria-hidden="true">✓</span>}
                          </span>
                        );
                      })}
                      {companies.length === 0 && <span className="empty-meta">—</span>}
                    </div>
                  </td>
                  <td className="tags-cell">
                    <div className="user-tags-container">
                      {userTags.map(tag => {
                        const shared = correctTags.user.has(tag.toLocaleLowerCase());
                        return (
                          <span key={tag} className={`meta-tag ${shared ? 'shared' : ''}`} title={i18n.language.startsWith('zh') ? tag : undefined}>
                            {localizedTagName(tag, i18n.language)}{shared && <span className="match-check" aria-hidden="true">✓</span>}
                          </span>
                        );
                      })}
                      {userTags.length === 0 && <span className="empty-meta">—</span>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
