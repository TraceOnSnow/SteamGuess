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
import type { DisplayField } from '../../settings/displayFields';
import { formatRegularPrice, getPlayerPeak } from '../../engine/ComparisonEngine';
import './GameTable.css';

interface GameTableProps {
  records: GuessRecord[];
  correctGame: Game;
  revealAnswer: boolean;
  visibleFields: ReadonlySet<DisplayField>;
  ownedAppIds: ReadonlySet<number>;
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
  const unknown = (fieldName: string): FieldComparison => ({
    fieldName,
    userValue: null,
    correctValue: null,
    status: 'unknown',
  });
  const rate = game.reviews.total > 0 ? (game.reviews.positive / game.reviews.total) * 100 : 0;
  const result: ComparisonResult = {
    nameMatch: exact('Name', game.name),
    priceMatch: game.price.cn?.regular === undefined
      ? unknown('Price')
      : exact('Price', formatRegularPrice(game)),
    ccuMatch: exact('Popularity', getPlayerPeak(game).toLocaleString()),
    totalReviewsMatch: exact('Total Reviews', game.reviews.total.toLocaleString()),
    reviewsRateMatch: exact('Reviews Rate', `${rate.toFixed(1)}%`),
    releaseMatch: game.releaseDate
      ? exact('Release Date', game.releaseDate)
      : unknown('Release Date'),
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

export function GameTable({ records, correctGame, revealAnswer, visibleFields, ownedAppIds }: GameTableProps) {
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
              <th scope="col" className="game-identity-cell">{t('table.gameName')}</th>
              {visibleFields.has('price') && <th scope="col">{t('table.price')}</th>}
              {visibleFields.has('activity') && <th scope="col" className="activity-cell">{t('table.activity')}</th>}
              {visibleFields.has('rating') && <th scope="col" className="rating-cell compact-clue-cell">{t('table.rate')}</th>}
              {visibleFields.has('releaseDate') && <th scope="col" className="release-cell compact-clue-cell">{t('table.releaseDate')}</th>}
              {visibleFields.has('owned') && <th scope="col" className="owned-cell">{t('table.owned')}</th>}
              {visibleFields.has('companies') && <th scope="col" className="companies-cell">{t('table.companies')}</th>}
              {visibleFields.has('tags') && <th scope="col" className="tags-cell">{t('table.tags')}</th>}
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
                  <th scope="row" className="game-identity-cell">
                    <a href={`https://store.steampowered.com/app/${game.appId}`} target="_blank" rel="noopener noreferrer" className="header-image-link" aria-label={t('table.openSteam', { name: game.name })}>
                      {game.header_image
                        ? <img src={game.header_image} alt="" className="game-header-image" loading="lazy" />
                        : <span className="game-header-image placeholder" aria-hidden="true" />}
                    </a>
                    <span className="game-title">{game.localizedNames?.zh && i18n.language.startsWith('zh') ? game.localizedNames.zh : game.name}</span>
                    {isAnswer && <span className="answer-label">{t('table.answer')}</span>}
                  </th>
                  {visibleFields.has('price') && <td>{renderFeedback(result.priceMatch)}</td>}
                  {visibleFields.has('activity') && (
                    <td className="activity-cell">
                      <div className="stacked-feedback">
                        <div className="stacked-feedback-item">
                          {/* <span className="stacked-label">{peakLabel}</span> */}
                          {renderFeedback(result.ccuMatch)}
                        </div>
                        <div className="stacked-feedback-item">
                          {/* <span className="stacked-label">{t('table.reviews')}</span> */}
                          {renderFeedback(result.totalReviewsMatch)}
                        </div>
                      </div>
                    </td>
                  )}
                  {visibleFields.has('rating') && <td className="rating-cell compact-clue-cell">{renderFeedback(result.reviewsRateMatch)}</td>}
                  {visibleFields.has('releaseDate') && <td className="release-cell compact-clue-cell">{renderFeedback(result.releaseMatch)}</td>}
                  {visibleFields.has('owned') && (
                    <td className="owned-cell">
                      {renderFeedback({
                        fieldName: 'Owned',
                        userValue: ownedAppIds.has(game.appId) ? t('table.ownedYes') : t('table.ownedNo'),
                        correctValue: ownedAppIds.has(correctGame.appId) ? t('table.ownedYes') : t('table.ownedNo'),
                        status: ownedAppIds.has(game.appId) === ownedAppIds.has(correctGame.appId) ? 'exact' : 'wrong',
                      })}
                    </td>
                  )}
                  {visibleFields.has('companies') && (
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
                  )}
                  {visibleFields.has('tags') && (
                    <td className="tags-cell">
                      <div className="user-tags-container">
                        {userTags.map(tag => {
                          const shared = correctTags.user.has(tag.toLocaleLowerCase());
                          return (
                            <span key={tag} className={`meta-tag ${shared ? 'shared' : ''}`} title={i18n.language.startsWith('zh') ? tag : undefined}>
                              {localizedTagName(tag, i18n.language)}
                            </span>
                          );
                        })}
                        {userTags.length === 0 && <span className="empty-meta">—</span>}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
