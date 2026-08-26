import type { DifficultyLevel, StartingHintMode } from '../difficulty/types';

const PLAYER_ID_KEY = 'steamguess-player-id-v1';

function createId(prefix: string): string {
  const value = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${value}`;
}

export function getPlayerId(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage): string {
  const saved = storage.getItem(PLAYER_ID_KEY);
  if (saved) return saved;
  const created = createId('player');
  storage.setItem(PLAYER_ID_KEY, created);
  return created;
}

export function createGameSession(): { id: string; startedAt: string } {
  return { id: createId('session'), startedAt: new Date().toISOString() };
}

async function postJson(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null) as { error?: string } | null;
  if (!response.ok) throw new Error(payload?.error || `Request failed (${response.status})`);
}

export interface CompletedSession {
  sessionId: string;
  playerId: string;
  mode: 'difficulty' | 'library';
  difficulty: DifficultyLevel;
  answerAppId: number;
  outcome: 'won' | 'lost' | 'surrendered';
  guesses: number;
  hintsUsed: number;
  startingHintMode: StartingHintMode;
  startedAt: string;
}

export function completeSession(session: CompletedSession): Promise<void> {
  return postJson('/api/sessions/complete', session);
}

export interface DifficultyFeedbackPayload {
  playerId: string;
  sessionId: string;
  appId: number;
  score: number;
  level: DifficultyLevel;
}

export function submitDifficultyFeedback(payload: DifficultyFeedbackPayload): Promise<void> {
  return postJson('/api/feedback/difficulty', payload);
}
