import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage } from '../i18n';

export function Brand() {
  return <a className="brand" href="/" aria-label="SteamGuess">
    <span className="brand-mark" aria-hidden="true">S<b>?</b></span>
    <span>STEAMGUESS</span>
  </a>;
}

export function LanguageToggle() {
  const { i18n, t } = useTranslation();
  const zh = i18n.language.startsWith('zh');
  return <div className="lang" role="group" aria-label={t('nav.language')}>
    <button type="button" aria-pressed={zh} onClick={() => changeLanguage('zh')}>中文</button>
    <button type="button" aria-pressed={!zh} onClick={() => changeLanguage('en')}>EN</button>
  </div>;
}

export function TopBar({ children }: { children?: ReactNode }) {
  return <header className="topbar">
    <Brand />
    <div className="topbar-actions">{children}<LanguageToggle /></div>
  </header>;
}
