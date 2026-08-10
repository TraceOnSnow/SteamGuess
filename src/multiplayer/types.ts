import type { Game } from '../types/game';
import type { MatchStatus, ComparisonDirection } from '../types/comparison';

export type MultiplayerField = 'price' | 'popularity' | 'reviews' | 'rating' | 'releaseDate' | 'companies' | 'tags';
export type MultiplayerSettings = { difficulty: 'easy' | 'normal' | 'hard' | 'hell'; bestOf: 1 | 3 | 5; maxPlayers: number; roundTimeSeconds: number; visibleFields: MultiplayerField[] };
export type RoomPlayer = { id: string; displayName: string; ready: boolean; connected: boolean; rematch: boolean; guessCount: number; finished: boolean };
export type RoomSnapshot = {
  id: string; code: string; status: 'lobby' | 'countdown' | 'playing' | 'round_over' | 'finished'; revision: number; hostPlayerId: string; countdownEndsAt: number | null;
  settings: MultiplayerSettings; players: RoomPlayer[];
  match: null | { id: string; roundNumber: number; scores: Record<string, number>; winnerPlayerId: string | null };
  activeRound: null | { id: string; startedAt: number; endsAt: number; guesses: number[] };
};
export type GuessFeedback = {
  isCorrect: boolean;
  fields: { fieldName: string; userValue: string | number | null; status: MatchStatus; direction?: ComparisonDirection }[];
  matchingTags: string[]; matchingCompanies: string[];
};
export type GuessResult = { roomId: string; roundId: string; guessAppId: number; feedback: GuessFeedback; guessesUsed: number; guessesLeft: number; stateVersion: number };
export type RoundEnd = { roomId: string; roundId: string; winnerPlayerId: string | null; reason: string; answer: Game; stateVersion: number };
export type Ack<T = unknown> = { ok: true; data: T; stateVersion?: number } | { ok: false; error: { code: string; message: string } };
