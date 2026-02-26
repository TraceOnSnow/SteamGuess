/**
 * Game Search Box Component
 * Allows users to search and select a game
 */

import React, { useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { Game } from '../../types/game';
import { searchGames } from '../../data/games';
import './SearchBox.css';

interface SearchBoxProps {
  onSelectGame: (game: Game) => void;
  isDisabled?: boolean;
}

export const SearchBox: React.FC<SearchBoxProps> = ({ onSelectGame, isDisabled = false }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [showResults, setShowResults] = useState(false);

  const results = useMemo(() => {
    if (!query.trim()) return [];
    return searchGames(query);
  }, [query]);

  const handleSelectGame = (game: Game) => {
    onSelectGame(game);
    setQuery('');
    setShowResults(false);
  };

  return (
    <div className="search-box">
      <input
        type="text"
        placeholder={t('search.placeholder')}
        value={query}
        onChange={e => {
          setQuery(e.target.value);
          setShowResults(true);
        }}
        disabled={isDisabled}
        className="search-input"
      />

      {showResults && results.length > 0 && (
        <div className="search-results">
          {results.map((game: Game) => (
            <button
              key={game.appId}
              className="result-item"
              onClick={() => handleSelectGame(game)}
            >
              <img
                src={game.header_image || ''}
                alt={game.name}
                className="result-image"
                loading="lazy"
              />
              <div className="result-text">
                <div className="result-name">{game.name}</div>
                <div className="result-meta">
                  {game.releaseDate.split('-')[0]}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
