import type { Comparison, Currency, Level } from '../../shared/game-rules.js';
import type { Game } from '../types/game';

export type MultiplayerSettings = { difficulty: Exclude<Level, 'unrated'>; bestOf: 1 | 3 | 5; maxPlayers: number; roundTimeSeconds: number; currency: Currency };
export type RoomPlayer = { id: string; displayName: string; ready: boolean; connected: boolean; rematch: boolean; guessCount: number; finished: boolean };
export type GuessResult = { roomId: string; roundId: string; guessAppId: number; feedback: Comparison };
export type RoundEnd = { roomId: string; roundId: string; winnerPlayerId: string | null; reason: string; answer: Game; stateVersion: number; results?: GuessResult[] };
export type RoomSnapshot = {
  id: string; code: string; status: 'lobby' | 'countdown' | 'playing' | 'round_over' | 'finished'; revision: number; hostPlayerId: string; countdownEndsAt: number | null;
  settings: MultiplayerSettings; players: RoomPlayer[];
  match: null | { id: string; roundNumber: number; scores: Record<string, number>; winnerPlayerId: string | null };
  /** `results` is the viewer's own board, recomputed by the server on every snapshot. */
  activeRound: null | { id: string; startedAt: number; endsAt: number; results: GuessResult[]; screenshotUrls: string[] };
  lastRound: RoundEnd | null;
};
export type Ack<T = unknown> = { ok: true; data: T; stateVersion?: number } | { ok: false; error: { code: string; message: string } };
