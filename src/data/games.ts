import type { Game } from '../types/game';

export const sampleGames: Game[] = [
  {
    appId: 1245620,
    name: 'Elden Ring',
    releaseDate: '2022-02-25',
    price: {
      current: 59.99,
      historicalLow: 29.99,
    },
    popularity: {
      currentWeekly: 15000,
      peakConcurrent: 953027,
    },
    reviews: {
      count: 200000,
      positivePercent: 96,
      steamRating: 'Overwhelmingly Positive',
    },
    players: {
      singlePlayer: true,
      multiplayer: true,
      online: true,
    },
    tags: {
      userTags: ['Action', 'RPG', 'Adventure'],
      genres: ['Action', 'RPG'],
      developer: 'FromSoftware',
      publisher: 'Bandai Namco',
    },
    hints: {
      screenshotUrl: 'elden-ring.jpg',
      funnyReview: 'Incredible journey, legs hurt',
    },
  },
  {
    appId: 570,
    name: 'Dota 2',
    releaseDate: '2013-07-09',
    price: {
      current: 0,
      historicalLow: 0,
    },
    popularity: {
      currentWeekly: 500000,
      peakConcurrent: 1195027,
    },
    reviews: {
      count: 2000000,
      positivePercent: 52,
      steamRating: 'Mixed',
    },
    players: {
      singlePlayer: false,
      multiplayer: true,
      online: true,
    },
    tags: {
      userTags: ['MOBA', 'Strategy', 'Competitive'],
      genres: ['MOBA', 'Strategy'],
      developer: 'Valve',
      publisher: 'Valve',
    },
    hints: {
      screenshotUrl: 'dota2.jpg',
      funnyReview: 'Free game, paid friends',
    },
  },
  {
    appId: 8980,
    name: 'Spore',
    releaseDate: '2008-09-07',
    price: {
      current: 14.99,
      historicalLow: 4.99,
    },
    popularity: {
      currentWeekly: 200,
      peakConcurrent: 40000,
    },
    reviews: {
      count: 10000,
      positivePercent: 76,
      steamRating: 'Very Positive',
    },
    players: {
      singlePlayer: true,
      multiplayer: false,
      online: false,
    },
    tags: {
      userTags: ['Life Simulation', 'Adventure', 'Education'],
      genres: ['Simulation', 'Adventure'],
      developer: 'Maxis',
      publisher: 'Electronic Arts',
    },
    hints: {
      screenshotUrl: 'spore.jpg',
      funnyReview: 'Evolution simulator, not evolution accurate',
    },
  },
];

export function searchGames(query: string): Game[] {
  const lowerQuery = query.toLowerCase();
  return sampleGames.filter(
    game =>
      game.name.toLowerCase().includes(lowerQuery) ||
      game.tags.userTags.some(tag => tag.toLowerCase().includes(lowerQuery)) ||
      game.tags.genres.some(g => g.toLowerCase().includes(lowerQuery)) ||
      game.tags.developer.toLowerCase().includes(lowerQuery) ||
      game.tags.publisher.toLowerCase().includes(lowerQuery)
  );
}

export function getGameById(appId: number): Game | undefined {
  return sampleGames.find(game => game.appId === appId);
}

export function getRandomGame(): Game {
  return sampleGames[Math.floor(Math.random() * sampleGames.length)];
}
