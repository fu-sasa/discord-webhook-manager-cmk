import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { migrations } from './schema.js';

export type Row = Record<string, unknown>;

let database: DatabaseSync | null = null;

export function db(): DatabaseSync {
  if (!database) throw new Error('Database not initialised — call initDb() first');
  return database;
}

export function initDb(path = config.databasePath): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const conn = new DatabaseSync(path);
  conn.exec('PRAGMA journal_mode = WAL');
  conn.exec('PRAGMA foreign_keys = ON');
  conn.exec('PRAGMA busy_timeout = 5000');
  conn.exec('PRAGMA synchronous = NORMAL');
  conn.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);

  const applied = new Set(
    conn.prepare('SELECT id FROM _migrations').all().map((r) => Number((r as Row)['id'])),
  );
  for (const m of migrations) {
    if (applied.has(m.id)) continue;
    conn.exec('BEGIN');
    try {
      conn.exec(m.sql);
      conn
        .prepare('INSERT INTO _migrations (id, name, applied_at) VALUES (?, ?, ?)')
        .run(m.id, m.name, new Date().toISOString());
      conn.exec('COMMIT');
    } catch (err) {
      conn.exec('ROLLBACK');
      throw new Error(`Migration ${m.id} (${m.name}) failed: ${(err as Error).message}`);
    }
  }

  database = conn;
  return conn;
}

export function closeDb(): void {
  database?.close();
  database = null;
}

/** Run `fn` inside a transaction, rolling back on any thrown error. */
export function tx<T>(fn: () => T): T {
  const conn = db();
  conn.exec('BEGIN');
  try {
    const out = fn();
    conn.exec('COMMIT');
    return out;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return db().prepare(sql).all(...(params as never[])) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return db().prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]) {
  return db().prepare(sql).run(...(params as never[]));
}

// ---- settings helpers -------------------------------------------------------

export function getSetting(key: string): string | undefined {
  const row = get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  run(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    key,
    value,
    new Date().toISOString(),
  );
}

export function audit(actor: string, action: string, detail: unknown = {}, ip = ''): void {
  run(
    'INSERT INTO audit_log (at, actor, action, detail_json, ip) VALUES (?, ?, ?, ?, ?)',
    new Date().toISOString(),
    actor,
    action,
    JSON.stringify(detail ?? {}),
    ip,
  );
}
