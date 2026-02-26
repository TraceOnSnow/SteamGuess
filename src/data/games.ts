import type { Game } from '../types/game';
import sampleGameData from '../../public/games_demo.json';

const rawGames = sampleGameData as Record<string, Game>;
export const sampleGames: Game[] = Object.values(rawGames);

export function searchGames(query: string): Game[] {
  const lowerQuery = query.toLowerCase();
  return sampleGames.filter(
    game =>
      game.name.toLowerCase().includes(lowerQuery)
      // game.name.toLowerCase().includes(lowerQuery) ||
      // game.tags.userTags.some(tag => tag.toLowerCase().includes(lowerQuery)) ||
      // game.tags.developers.some(dev => dev.toLowerCase().includes(lowerQuery)) ||
      // game.tags.publishers.some(pub => pub.toLowerCase().includes(lowerQuery))
  );
}

export function getRandomGame(): Game {
  return sampleGames[Math.floor(Math.random() * sampleGames.length)];
}
