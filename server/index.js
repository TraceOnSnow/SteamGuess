import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, relative, resolve, sep } from 'node:path';
import { createApiHandler } from './api.js';

const rootDir = resolve(process.cwd());
const distDir = resolve(rootDir, 'dist');
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || '0.0.0.0';
const trustProxy = process.env.STEAMGUESS_TRUST_PROXY === 'true';
const api = createApiHandler({
  rootDir,
  dbPath: process.env.STEAMGUESS_DB_PATH,
  steamApiKey: process.env.STEAM_WEB_API_KEY || '',
  trustProxy,
  writeRateLimit: Number(process.env.STEAMGUESS_WRITE_RATE_LIMIT || 60),
  profileRateLimit: Number(process.env.STEAMGUESS_PROFILE_RATE_LIMIT || 12),
});
const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
};
const contentSecurityPolicy = [
  "default-src 'self'",
  "base-uri 'self'",
  "connect-src 'self'",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: https://shared.akamai.steamstatic.com https://cdn.cloudflare.steamstatic.com",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join('; ');

function securityHeaders(response) {
  response.setHeader('Content-Security-Policy', contentSecurityPolicy);
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}

const server = createServer(async (request, response) => {
  securityHeaders(response);
  const startedAt = Date.now();
  if (process.env.STEAMGUESS_REQUEST_LOG === 'true') {
    response.on('finish', () => {
      console.log(`${request.method} ${new URL(request.url ?? '/', 'http://localhost').pathname} ${response.statusCode} ${Date.now() - startedAt}ms`);
    });
  }

  if ((request.url ?? '').startsWith('/api/')) return api(request, response);
  const url = new URL(request.url ?? '/', 'http://localhost');
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    response.statusCode = 400;
    response.end('Bad request.');
    return;
  }
  const requested = resolve(distDir, `.${pathname === '/' ? '/index.html' : pathname}`);
  const outsideDist = requested !== distDir && relative(distDir, requested).startsWith(`..${sep}`);
  let file = outsideDist ? resolve(distDir, 'index.html') : requested;
  if (!existsSync(file) || statSync(file).isDirectory()) file = resolve(distDir, 'index.html');
  if (!existsSync(file)) {
    response.statusCode = 503;
    response.end('Run npm run build before starting the server.');
    return;
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', mime[extname(file)] || 'application/octet-stream');
  if (file.endsWith('index.html')) response.setHeader('Cache-Control', 'no-cache');
  else response.setHeader('Cache-Control', 'public, max-age=3600');
  if (request.method === 'HEAD') return response.end();
  createReadStream(file).pipe(response);
});

server.listen(port, host, () => {
  console.log(`SteamGuess server listening on http://${host}:${port}`);
});

function shutdown(signal) {
  console.log(`${signal} received; shutting down.`);
  server.close(() => {
    api.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
