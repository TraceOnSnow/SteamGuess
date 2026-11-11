import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { HintState } from '../play/progress';
import './ScreenshotHint.css';

interface Props {
  urls: string[];
  state: HintState;
  /** Once the round is over the screenshots are shown sharp and can be browsed. */
  ended: boolean;
  onChange: (next: HintState) => void;
}

export function ScreenshotHint({ urls, state, ended, onChange }: Props) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState<string[]>([]);
  const [loaded, setLoaded] = useState('');
  const [collapsed, setCollapsed] = useState(false);
  const [index, setIndex] = useState(0);
  const usable = urls.filter(url => !failed.includes(url));
  if (!urls.length) return null;

  const clear = ended || state === 'clear';
  const revealed = ended || state !== 'hidden';
  // During play everyone sees the same single screenshot; browsing unlocks at the end.
  const current = usable[ended ? index % Math.max(1, usable.length) : 0];

  if (!revealed) return <section className="shot shot-closed" aria-label={t('hint.title')}>
    <span className="label">{t('hint.title')}</span>
    <button type="button" className="btn btn-ghost btn-small" onClick={() => onChange('blurred')}>{t('hint.show')}</button>
  </section>;

  return <section className="shot" aria-label={t('hint.title')}>
    <div className="shot-bar">
      <span className="label">{t('hint.title')} · {clear ? t('hint.clear') : t('hint.blurred')}</span>
      <span className="shot-actions">
        {!collapsed && !clear && <button type="button" className="btn btn-ghost btn-small" onClick={() => onChange('clear')}>{t('hint.sharpen')}</button>}
        {ended && usable.length > 1 && !collapsed && <>
          <button type="button" className="btn btn-ghost btn-small" aria-label={t('hint.previous')} onClick={() => setIndex(value => (value - 1 + usable.length) % usable.length)}>←</button>
          <span className="num shot-count">{index % usable.length + 1}/{usable.length}</span>
          <button type="button" className="btn btn-ghost btn-small" aria-label={t('hint.next')} onClick={() => setIndex(value => value + 1)}>→</button>
        </>}
        <button type="button" className="link-button" aria-expanded={!collapsed} onClick={() => setCollapsed(value => !value)}>{collapsed ? t('hint.reopen') : t('hint.hide')}</button>
      </span>
    </div>
    {!collapsed && <div className={`shot-frame ${clear ? '' : 'shot-blurred'}`}>
      {current ? <>
        {loaded !== current && <span className="shot-status" role="status">{t('hint.loading')}</span>}
        <img key={current} src={current} alt={t('hint.alt')} referrerPolicy="no-referrer" draggable={false}
          onLoad={() => setLoaded(current)} onError={() => setFailed(values => [...values, current])} />
      </> : <div className="shot-status" role="status">
        <p>{t('hint.failed')}</p>
        <button type="button" className="btn btn-ghost btn-small" onClick={() => { setFailed([]); setLoaded(''); }}>{t('hint.retry')}</button>
      </div>}
    </div>}
  </section>;
}
