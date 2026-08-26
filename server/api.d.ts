import type { IncomingMessage, ServerResponse } from 'node:http';
export interface ApiOptions {
  rootDir?: string;
  dbPath?: string;
  catalogDbPath?: string;
  adminToken?: string;
  allowAdminWithoutToken?: boolean;
  steamApiKey?: string;
  trustProxy?: boolean;
  writeRateLimit?: number;
  profileRateLimit?: number;
  rateLimitWindowMs?: number;
}
export interface ApiHandler {
  (request: IncomingMessage, response: ServerResponse, next?: () => void): Promise<void>;
  close(): void;
}
export interface RateLimitResult { allowed: boolean; limit: number; remaining: number; resetAt: number }
export function createRateLimiter(options: { limit: number; windowMs: number }): { consume(key: string, now?: number): RateLimitResult };
export function createApiHandler(options?: ApiOptions): ApiHandler;
