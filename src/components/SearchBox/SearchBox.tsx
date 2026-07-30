import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Game } from '../../types/game';
import { searchGames } from '../../data/games';
import './SearchBox.css';

interface SearchBoxProps {
  games: Game[];
  excludedAppIds: ReadonlySet<number>;
  onSelectGame: (game: Game) => void;
  isDisabled?: boolean;
}

export function SearchBox({ games, excludedAppIds, onSelectGame, isDisabled = false }: SearchBoxProps) {
  const { t, i18n } = useTranslation();
  const listboxId = useId();
  const [query, setQuery] = useState('');
  const [isOpen, setIsOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const results = useMemo(
    () => searchGames(games, query, excludedAppIds),
    [excludedAppIds, games, query],
  );

  const selectGame = (game: Game) => {
    onSelectGame(game);
    setQuery('');
    setIsOpen(false);
    setActiveIndex(0);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      setIsOpen(false);
      return;
    }

    if (results.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex(index => (index + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setIsOpen(true);
      setActiveIndex(index => (index - 1 + results.length) % results.length);
    } else if (event.key === 'Enter' && isOpen) {
      event.preventDefault();
      selectGame(results[Math.min(activeIndex, results.length - 1)]);
    }
  };

  const showMenu = isOpen && query.trim().length > 0;

  return (
    <div className="search-box">
      <label className="search-label" htmlFor={`${listboxId}-input`}>
        {t('search.label')}
      </label>
      <div className="search-input-wrap">
        <span className="search-icon" aria-hidden="true">⌕</span>
        <input
          id={`${listboxId}-input`}
          type="search"
          value={query}
          placeholder={t('search.placeholder')}
          disabled={isDisabled}
          className="search-input"
          autoComplete="off"
          role="combobox"
          aria-autocomplete="list"
          aria-controls={listboxId}
          aria-expanded={showMenu}
          aria-activedescendant={showMenu && results.length > 0 ? `${listboxId}-${activeIndex}` : undefined}
          onFocus={() => setIsOpen(true)}
          onChange={event => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setIsOpen(true);
          }}
          onKeyDown={handleKeyDown}
          onBlur={event => {
            if (!event.currentTarget.parentElement?.parentElement?.contains(event.relatedTarget)) {
              setIsOpen(false);
            }
          }}
        />
      </div>

      {showMenu && (
        <div className="search-results" id={listboxId} role="listbox">
          {results.length > 0 ? results.map((game, index) => (
            <button
              id={`${listboxId}-${index}`}
              key={game.appId}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`result-item ${index === activeIndex ? 'active' : ''}`}
              onMouseDown={event => event.preventDefault()}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => selectGame(game)}
            >
              {game.header_image ? (
                <img src={game.header_image} alt="" className="result-image" loading="lazy" />
              ) : (
                <span className="result-image placeholder" aria-hidden="true" />
              )}
              <span className="result-text">
                <span className="result-name">{i18n.language.startsWith('zh') && game.localizedNames?.zh ? game.localizedNames.zh : game.name}</span>
                <span className="result-meta">
                  {game.localizedNames?.zh && game.localizedNames.zh !== game.name ? `${game.name} · ` : ''}{game.releaseDate ? game.releaseDate.slice(0, 4) : '—'} · App {game.appId}
                </span>
              </span>
            </button>
          )) : (
            <p className="search-empty" role="status">{t('search.noResults')}</p>
          )}
        </div>
      )}
    </div>
  );
}
