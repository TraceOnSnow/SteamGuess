import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CUSTOM_MIN, parseCustomPreset, serializeCustomPreset, type CustomPreset } from '../play/presets';
import type { Game } from '../types/game';
import './CustomPresetEditor.css';

interface Props {
  games: Game[];
  preset: CustomPreset | null;
  onApply: (preset: CustomPreset) => void;
}

const EXAMPLE = '{\n  "name": "My list",\n  "appIds": [730, 570, 292030]\n}';

/** Paste or upload a JSON list of Steam AppIDs; download the current one to share it. */
export function CustomPresetEditor({ games, preset, onApply }: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => preset ? serializeCustomPreset(preset) : '');
  const [message, setMessage] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const known = new Set(games.map(game => game.appId));
  const matched = preset ? preset.appIds.filter(id => known.has(id)).length : 0;
  const missing = preset ? preset.appIds.length - matched : 0;

  function apply(source: string) {
    const parsed = parseCustomPreset(source);
    if (!parsed.ok) { setMessage(t(`preset.error.${parsed.error}`)); return; }
    const found = parsed.preset.appIds.filter(id => known.has(id));
    if (found.length < CUSTOM_MIN) { setMessage(t('preset.error.tooFew', { count: CUSTOM_MIN, found: found.length })); return; }
    setText(serializeCustomPreset(parsed.preset));
    setMessage(t('preset.applied', { found: found.length, missing: parsed.preset.appIds.length - found.length }));
    onApply(parsed.preset);
  }
  async function upload(list: FileList | null) {
    const chosen = list?.[0];
    if (!chosen) return;
    if (chosen.size > 200_000) { setMessage(t('preset.error.tooMany')); return; }
    const content = await chosen.text();
    setText(content);
    apply(content);
    if (file.current) file.current.value = '';
  }
  function download() {
    if (!preset) return;
    const url = URL.createObjectURL(new Blob([serializeCustomPreset(preset)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${(preset.name || 'steamguess-preset').replace(/[\\/:*?"<>|]+/g, '_')}.json`;
    link.click();
    URL.revokeObjectURL(url);
  }

  return <section className="custom-preset" aria-label={t('preset.custom')}>
    <div className="custom-preset-head">
      <span className="label">{t('preset.customTitle')}</span>
      {preset && <span className="custom-preset-current">{preset.name || t('preset.unnamed')} · {t('preset.count', { count: matched })}{missing > 0 && ` · ${t('preset.missing', { count: missing })}`}</span>}
    </div>
    <p>{t('preset.customHelp')}</p>
    <textarea value={text} onChange={event => setText(event.target.value)} placeholder={EXAMPLE} rows={5} spellCheck={false}
      aria-label={t('preset.customTitle')} />
    <div className="custom-preset-actions">
      <button type="button" className="btn btn-small" onClick={() => apply(text)} disabled={!text.trim()}>{t('preset.apply')}</button>
      <button type="button" className="btn btn-ghost btn-small" onClick={() => file.current?.click()}>{t('preset.upload')}</button>
      <button type="button" className="btn btn-ghost btn-small" onClick={download} disabled={!preset}>{t('preset.download')}</button>
      <input ref={file} type="file" accept="application/json,.json" hidden onChange={event => void upload(event.target.files)} />
    </div>
    {message && <p className="custom-preset-message" role="status">{message}</p>}
  </section>;
}
