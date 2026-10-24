import { randomUUID } from 'node:crypto';
import { COMPARISON_RULES, compareDateValues, compareNumericValues, getPlayerPeak, getPositiveRate, getRegularPrice, getMaxGuesses } from '../../shared/game-rules.js';


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
      const pool = room.pool;
      if (!pool.length) throw new Error('The selected answer pool is empty.');
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
      const maxGuesses = getMaxGuesses(room.settings.difficulty);
      if (!round || !state) return { error: ['INVALID_ROOM_STATE', 'No active round.'] };
      if (state.finished) return { error: ['PLAYER_ALREADY_FINISHED', 'You have finished this round.'] };
      if (state.guesses.includes(appId)) return { error: ['GUESS_DUPLICATE', 'You already guessed this game.'] };
      if (state.guesses.length >= maxGuesses) return { error: ['MAX_GUESSES', 'No guesses remaining.'] };
      const guess = catalog.find(game => game.appId === appId);
      const answer = catalog.find(game => game.appId === round.answerAppId);
      if (!guess || !answer) return { error: ['INVALID_GAME', 'That game is not in the server catalog.'] };
      state.guesses.push(appId);
      const feedback = compareGames(guess, answer);
      let roundEnd = null;
      if (feedback.isCorrect) {
        state.finished = true;
        roundEnd = onRoundEnd(room, playerId, 'correct');
      } else if (state.guesses.length >= maxGuesses) {
        state.finished = true;
        if (Object.values(round.players).every(value => value.finished)) {
          roundEnd = onRoundEnd(room, null, 'guesses_exhausted');
        }
      }
      return {
        feedback,
        guessesUsed: state.guesses.length,
        guessesLeft: maxGuesses - state.guesses.length,
        roundEnd,
      };
    },
    maxGuesses: 10,
  };
}
