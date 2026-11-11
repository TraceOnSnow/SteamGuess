import { useTranslation } from 'react-i18next';
import { NUMERIC_FIELDS } from '../../shared/game-rules.js';
import type { Currency, NumericField } from '../../shared/game-rules.js';
import { localizedTagName } from '../data/localization';
import { formatField } from '../lib/format';
import type { Bound, Knowledge } from '../play/knowledge';
import './KnownClues.css';

/** The running summary: tightest known range per clue plus confirmed tags. */
export function KnownClues({ knowledge, currency }: { knowledge: Knowledge; currency: Currency }) {
  const { t, i18n } = useTranslation();
  const language = i18n.language;
  const show = (value: number, field: NumericField) => formatField(value, field, currency, language, t('price.free'));

  function describe(bound: Bound, field: NumericField): string {
    if (bound.exact !== undefined) return t('known.is', { value: show(bound.exact, field) });
    if (bound.near !== undefined) return t('known.about', { value: show(bound.near, field) });
    const date = field === 'releaseDate';
    if (bound.min !== undefined && bound.max !== undefined) return t('known.between', { min: show(bound.min, field), max: show(bound.max, field) });
    if (bound.min !== undefined) return t(date ? 'known.after' : 'known.above', { value: show(bound.min, field) });
    return t(date ? 'known.before' : 'known.below', { value: show(bound.max!, field) });
  }

  const rows = NUMERIC_FIELDS.flatMap(field => knowledge.bounds[field] ? [{ field, text: describe(knowledge.bounds[field]!, field), settled: knowledge.bounds[field]!.exact !== undefined || knowledge.bounds[field]!.near !== undefined }] : []);
  const confirmed = [...knowledge.companies, ...knowledge.tags.map(tag => localizedTagName(tag, language))];
  if (!rows.length && !confirmed.length) return null;

  return <section className="known" aria-label={t('known.title')}>
    <h2 className="label">{t('known.title')}</h2>
    <dl className="known-ranges">
      {rows.map(row => <div key={row.field} className={row.settled ? 'known-settled' : ''}>
        <dt>{t(`field.${row.field}`)}</dt><dd className="num">{row.text}</dd>
      </div>)}
    </dl>
    {confirmed.length > 0 && <p className="known-tags">{confirmed.map(name => <span key={name} className="chip chip-shared">{name}</span>)}</p>}
  </section>;
}
