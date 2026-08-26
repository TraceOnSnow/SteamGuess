#!/usr/bin/env node
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const dbPath = resolve(argument('--db', process.env.STEAMGUESS_DB_PATH || 'data/runtime/steamguess.sqlite'));
const backupDir = resolve(argument('--out-dir', process.env.STEAMGUESS_BACKUP_DIR || 'data/backups'));
const prefix = argument('--prefix', 'steamguess').replace(/[^A-Za-z0-9._-]/g, '-');
const keep = Math.max(1, Number(argument('--keep', process.env.STEAMGUESS_BACKUP_KEEP || '14')) || 14);
if (!existsSync(dbPath)) {
  console.error(`Database not found: ${dbPath}`);
  process.exit(1);
}

mkdirSync(backupDir, { recursive: true });
const stamp = new Date().toISOString().replaceAll(':', '-').replace(/\.\d{3}Z$/, 'Z');
const destination = resolve(backupDir, `${prefix}-${stamp}.sqlite`);
const escaped = destination.replaceAll("'", "''");
const db = new DatabaseSync(dbPath);
try {
  db.exec('PRAGMA wal_checkpoint(PASSIVE);');
  db.exec(`VACUUM INTO '${escaped}';`);
} finally {
  db.close();
}

const backups = readdirSync(backupDir)
  .filter(file => file.startsWith(`${prefix}-`) && file.endsWith('.sqlite'))
  .map(file => ({ file, path: resolve(backupDir, file), mtime: statSync(resolve(backupDir, file)).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime);
for (const old of backups.slice(keep)) unlinkSync(old.path);
console.log(`backup=${basename(destination)} directory=${dirname(destination)} kept=${Math.min(backups.length, keep)}`);
