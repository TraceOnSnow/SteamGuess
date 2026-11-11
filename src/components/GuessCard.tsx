import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { NUMERIC_FIELDS } from '../../shared/game-rules.js';
import type { Comparison, Currency, FieldResult, NumericField } from '../../shared/game-rules.js';
import { localizedTagName } from '../data/localization';
import { FieldHelp } from './FieldHelp';
import { displayName, fieldValue, formatField, secondaryName } from '../lib/format';
import type { Game } from '../types/game';
import './GuessCard.css';

const VISIBLE_OTHER_TAGS = 6;

/** Far misses get a doubled arrow so distance reads without relying on colour. */
function arrow({ status, direction }: FieldResult): string {
  if (direction === 'equal') return '';
  if (direction === 'near') return '≈';
  if (!direction) return '';
  const glyph = direction === 'higher' ? '↑' : '↓';
  return status === 'wrong' ? glyph + glyph : glyph;
}

export function ClueTile({ field, value, result }: { field: NumericField; value: string; result: FieldResult }) {
  const { t } = useTranslation();
  const direction = result.direction && field === 'releaseDate'
    ? ({ higher: 'later', lower: 'earlier' } as Record<string, string>)[result.direction] ?? result.direction
    : result.direction;
  const spoken = [t(`status.${result.status}`), direction ? t(`direction.${direction}`) : ''].filter(Boolean).join(', ');
  return <div className={`tile is-${result.status}`}>
    <span className="tile-label">{t(`field.${field}`)}<FieldHelp field={field} /></span>
    <span className="tile-value">{value}<i aria-hidden="true">{arrow(result)}</i></span>
    <span className="sr-only">{spoken}</span>
  </div>;
}

interface Props {
  game: Game;
  result: Comparison;
  currency: Currency;
  /** 1-based guess number; omitted for the revealed answer. */
  number?: number;
  isAnswer?: boolean;
}

export function GuessCard({ game, result, currency, number, isAnswer = false }: Props) {
  const { t, i18n } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const language = i18n.language;
  const secondary = secondaryName(game, language);
  const sharedTags = new Set(result.matchingTags.map(tag => tag.toLocaleLowerCase()));
  const sharedCompanies = new Set(result.matchingCompanies.map(name => name.toLocaleLowerCase()));
  const companies = [...new Set([...game.tags.developers, ...game.tags.publishers])];
  const shared = game.tags.userTags.filter(tag => sharedTags.has(tag.toLocaleLowerCase()));
  const others = game.tags.userTags.filter(tag => !sharedTags.has(tag.toLocaleLowerCase()));
  const shownOthers = expanded || isAnswer ? others : others.slice(0, VISIBLE_OTHER_TAGS);

  return <article className={`guess ${result.isCorrect ? 'guess-correct' : ''} ${isAnswer ? 'guess-answer' : ''}`}>
    <header className="guess-id">
      <a href={`https://store.steampowered.com/app/${game.appId}/`} target="_blank" rel="noopener noreferrer" tabIndex={-1} aria-hidden="true">
        {game.header_image ? <img src={game.header_image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="guess-thumb" />}
      </a>
      <div>
        <span className="label">{isAnswer ? t('result.surrendered') : t('play.guessNumber', { count: number })}</span>
        <h3>{displayName(game, language)}</h3>
        {secondary && <p>{secondary}</p>}
      </div>
    </header>
    <div className="tiles">
      {NUMERIC_FIELDS.map(field => <ClueTile key={field} field={field} result={result.fields[field]}
        value={field === 'price' && fieldValue(game, field, currency) === undefined ? t('price.unknown')
          : formatField(fieldValue(game, field, currency), field, currency, language, t('price.free'))} />)}
    </div>
    <dl className="guess-meta">
      <div>
        <dt className="label">{t('field.companies')}<FieldHelp field="companies" /></dt>
        <dd>{companies.length ? companies.map(name => <span key={name} className={`chip ${sharedCompanies.has(name.toLocaleLowerCase()) ? 'chip-shared' : ''}`}>{name}</span>) : '—'}</dd>
      </div>
      <div>
        <dt className="label">{t('field.tags')}<FieldHelp field="tags" /></dt>
        <dd>
          {shared.map(tag => <span key={tag} className="chip chip-shared">{localizedTagName(tag, language)}</span>)}
          {!shared.length && !isAnswer && <span className="chip-none">{t('play.noShared')}</span>}
          {shownOthers.map(tag => <span key={tag} className="chip">{localizedTagName(tag, language)}</span>)}
          {!isAnswer && others.length > VISIBLE_OTHER_TAGS && <button type="button" className="chip chip-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
            {expanded ? t('play.fewerTags') : `+ ${t('play.moreTags', { count: others.length - VISIBLE_OTHER_TAGS })}`}
          </button>}
        </dd>
      </div>
    </dl>
  </article>;
}
