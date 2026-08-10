import { randomUUID } from 'node:crypto';
import { COMPARISON_RULES, compareDateValues, compareNumericValues, getPlayerPeak, getPositiveRate, getRegularPrice } from '../../shared/game-rules.js';

const MAX_GUESSES = 10;
function numeric(fieldName, user, correct, rule) { return { fieldName, userValue: Number.isFinite(user) ? user : null, ...compareNumericValues(user, correct, rule) }; }
export function compareGames(guess, answer) {
  const fields = [
    numeric('price', getRegularPrice(guess), getRegularPrice(answer), COMPARISON_RULES.price),
    numeric('popularity', getPlayerPeak(guess), getPlayerPeak(answer), COMPARISON_RULES.popularity),
    numeric('reviews', guess.reviews?.total, answer.reviews?.total, COMPARISON_RULES.popularity),
    numeric('rating', getPositiveRate(guess), getPositiveRate(answer), COMPARISON_RULES.reviewsRate),
    { fieldName: 'releaseDate', userValue: guess.releaseDate || null, ...compareDateValues(guess.releaseDate, answer.releaseDate) },
  ];
  const matchingTags = (guess.tags?.userTags ?? []).filter(tag => (answer.tags?.userTags ?? []).includes(tag));
  const matchingCompanies = [...(guess.tags?.developers ?? []), ...(guess.tags?.publishers ?? [])]
    .filter(company => [...(answer.tags?.developers ?? []), ...(answer.tags?.publishers ?? [])].includes(company));
  return { isCorrect: guess.appId === answer.appId, fields, matchingTags, matchingCompanies };
}

export function createMatchEngine({ catalog, random = Math.random, now = () => Date.now(), onRoundEnd }) {
  return {
    startRound(room) {
      const pool = room.pool.length ? room.pool : catalog;
      const previousAnswer = room.match?.rounds.at(-1)?.answerAppId;
      const choices = pool.length > 1 && previousAnswer ? pool.filter(game => game.appId !== previousAnswer) : pool;
      const answer = choices[Math.floor(random() * choices.length)];
      room.activeRound = { id: `round_${randomUUID()}`, answerAppId: answer.appId, startedAt: now(), endsAt: now() + room.settings.roundTimeSeconds * 1000, players: {} };
      for (const player of room.players) room.activeRound.players[player.id] = { guesses: [], finished: false, disconnected: false };
      return room.activeRound;
    },
    guess(room, playerId, appId) {
      const round = room.activeRound;
      const state = round?.players[playerId];
      if (!round || !state) return { error: ['INVALID_ROOM_STATE', 'No active round.'] };
      if (state.finished) return { error: ['PLAYER_ALREADY_FINISHED', 'You have finished this round.'] };
      if (state.guesses.includes(appId)) return { error: ['GUESS_DUPLICATE', 'You already guessed this game.'] };
      if (state.guesses.length >= MAX_GUESSES) return { error: ['MAX_GUESSES', 'No guesses remaining.'] };
      const guess = catalog.find(game => game.appId === appId);
      const answer = catalog.find(game => game.appId === round.answerAppId);
      if (!guess || !answer) return { error: ['INVALID_GAME', 'That game is not in the server catalog.'] };
      state.guesses.push(appId);
      const feedback = compareGames(guess, answer);
      if (feedback.isCorrect) {
        state.finished = true;
        onRoundEnd(room, playerId, 'correct');
      } else if (state.guesses.length >= MAX_GUESSES) {
        state.finished = true;
        if (Object.values(round.players).every(value => value.finished)) onRoundEnd(room, null, 'guesses_exhausted');
      }
      return { feedback, guessesUsed: state.guesses.length, guessesLeft: MAX_GUESSES - state.guesses.length };
    },
    maxGuesses: MAX_GUESSES,
  };
}
