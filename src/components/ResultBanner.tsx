import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { displayName, secondaryName } from '../lib/format';
import type { Game } from '../types/game';

/** The reveal: cover, name and whatever actions the page passes in. */
export function ResultBanner({ game, kicker, tone, children }: { game: Game; kicker: string; tone: 'win' | 'neutral'; children?: ReactNode }) {
  const { t, i18n } = useTranslation();
  const secondary = secondaryName(game, i18n.language);
  return <section className={`result result-${tone}`} role="status">
    {game.header_image && <img src={game.header_image} alt="" referrerPolicy="no-referrer" />}
    <div className="result-text">
      <span className="label">{kicker}</span>
      <h2>{displayName(game, i18n.language)}</h2>
      {secondary && <p>{secondary}</p>}
      <a className="link-button" href={`https://store.steampowered.com/app/${game.appId}/`} target="_blank" rel="noopener noreferrer">{t('result.store')} ↗</a>
    </div>
    {children && <div className="result-actions">{children}</div>}
  </section>;
}
