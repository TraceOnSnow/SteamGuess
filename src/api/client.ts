import type { Level } from '../../shared/game-rules.js';

const PLAYER_ID_KEY = 'steamguess-player-id-v1';

function createId(prefix: string): string {
  const value = typeof crypto.randomUUID === 'function' ? crypto.randomUUID() : `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return `${prefix}_${value}`;
}

/** An anonymous, per-browser id; there are no accounts. */
export function getPlayerId(): string {
  try {
    const saved = localStorage.getItem(PLAYER_ID_KEY);
    if (saved) return saved;
    const created = createId('player');
    localStorage.setItem(PLAYER_ID_KEY, created);
    return created;
  } catch { return createId('player'); }
}

export function createGameSession(): { id: string; startedAt: string } {
  return { id: createId('session'), startedAt: new Date().toISOString() };
}

async function postJson(path: string, body: unknown): Promise<void> {
  const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`Request failed (${response.status})`);
}

export interface CompletedSession {
  sessionId: string; playerId: string; mode: 'daily' | 'practice' | 'preset'; difficulty: Level; answerAppId: number;
  outcome: 'won' | 'lost' | 'surrendered'; guesses: number; hintsUsed: number; startedAt: string;
}
/** Results feed the later regrading of tiers; failures are ignored by callers. */
export function completeSession(session: CompletedSession): Promise<void> {
  return postJson('/api/sessions/complete', session);
}
export function submitAnswerFeedback(payload: { sessionId: string; playerId: string; appId: number; verdict: 'fair' | 'obscure' }): Promise<void> {
  return postJson('/api/feedback/answer', payload);
}
