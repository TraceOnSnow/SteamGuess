import { useTranslation } from 'react-i18next';
import { changeLanguage } from '../../i18n';
import './LanguageToggle.css';

export function LanguageToggle() {
  const { i18n, t } = useTranslation();

  return (
    <div className="language-toggle" role="group" aria-label={t('app.language')}>
      <button
        type="button"
        aria-pressed={i18n.language.startsWith('zh')}
        onClick={() => changeLanguage('zh')}
      >
        中
      </button>
      <button
        type="button"
        aria-pressed={i18n.language.startsWith('en')}
        onClick={() => changeLanguage('en')}
      >
        EN
      </button>
    </div>
  );
}
