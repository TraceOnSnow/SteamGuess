import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { searchGames } from '../data/games';
import { displayName, secondaryName } from '../lib/format';
import type { Game } from '../types/game';
import './SearchBox.css';

interface Props {
  games: Game[];
  excludedAppIds: ReadonlySet<number>;
  onSelectGame: (game: Game) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}

/** Combobox over the whole searchable catalog; Enter submits the highlighted game. */
export function SearchBox({ games, excludedAppIds, onSelectGame, disabled = false, autoFocus = false }: Props) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const results = useMemo(() => searchGames(games, query, excludedAppIds), [excludedAppIds, games, query]);
  const showMenu = open && query.trim().length > 0;

  function select(game: Game) {
    onSelectGame(game);
    setQuery(''); setOpen(false); setActive(0);
  }
  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return; // Do not steal Enter from an IME.
    if (event.key === 'Escape') return setOpen(false);
    if (!results.length) return;
    if (event.key === 'ArrowDown') { event.preventDefault(); setOpen(true); setActive(index => (index + 1) % results.length); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); setActive(index => (index - 1 + results.length) % results.length); }
    else if (event.key === 'Enter' && showMenu) { event.preventDefault(); select(results[Math.min(active, results.length - 1)]); }
  }

  return <div className="search" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <label className="sr-only" htmlFor={`${id}-input`}>{t('search.label')}</label>
    <div className="search-field">
      <svg className="search-icon" viewBox="0 0 20 20" aria-hidden="true"><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4.5 4.5" /></svg>
      <input id={`${id}-input`} type="text" inputMode="search" enterKeyHint="search" value={query} disabled={disabled}
        placeholder={t('search.placeholder')} autoComplete="off" autoCorrect="off" spellCheck={false} autoFocus={autoFocus}
        role="combobox" aria-autocomplete="list" aria-controls={`${id}-list`} aria-expanded={showMenu}
        aria-activedescendant={showMenu && results.length ? `${id}-${active}` : undefined}
        onFocus={() => setOpen(true)} onKeyDown={onKeyDown}
        onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); }} />
      <span className="search-hint" aria-hidden="true">{t('search.hint')}</span>
    </div>
    {showMenu && <div className="search-menu" id={`${id}-list`} role="listbox">
      {results.length ? results.map((game, index) => {
        const secondary = secondaryName(game, i18n.language);
        return <button key={game.appId} id={`${id}-${index}`} type="button" role="option" aria-selected={index === active}
          className="search-option" onMouseDown={event => event.preventDefault()} onMouseEnter={() => setActive(index)} onClick={() => select(game)}>
          {game.header_image ? <img src={game.header_image} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <span className="search-thumb" aria-hidden="true" />}
          <span className="search-text">
            <strong>{displayName(game, i18n.language)}</strong>
            <small>{[secondary, game.releaseDate.slice(0, 4)].filter(Boolean).join(' · ')}</small>
          </span>
        </button>;
      }) : <p className="search-empty" role="status">{t('search.empty')}</p>}
    </div>}
  </div>;
}
