import { useTranslation } from 'react-i18next';

type Field = 'price' | 'popularity' | 'reviews' | 'rating' | 'releaseDate' | 'companies' | 'tags';

/** A small "?" that explains a clue on hover, keyboard focus or tap. */
export function FieldHelp({ field }: { field: Field }) {
  const { t } = useTranslation();
  const text = t(`fieldHelp.${field}`);
  return <span className="field-help" tabIndex={0} role="note" aria-label={text}>
    ?<span className="field-help-tip" aria-hidden="true">{text}</span>
  </span>;
}
