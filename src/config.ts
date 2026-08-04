import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
/** Project root: `src/` in dev, `dist/` after a build — both sit one level below root. */
export const ROOT = resolve(here, '..');

/**
 * Minimal .env reader. Avoids a dependency and the `--env-file` flag so the
 * same entrypoint works under `npm run dev`, `npm start` and systemd.
 * Values already present in the real environment always win.
 */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  for (const rawLine of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv(process.env.DOTENV_PATH ?? resolve(ROOT, '.env'));

function str(key: string, fallback?: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return v;
}

function int(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new Error(`Environment variable ${key} must be an integer`);
  return n;
}

function bool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v === '1' || v.toLowerCase() === 'true';
}

const appSecret = str('APP_SECRET');
if (!/^[0-9a-fA-F]{64}$/.test(appSecret)) {
  throw new Error('APP_SECRET must be 64 hex characters (32 bytes). Generate: openssl rand -hex 32');
}

export const config = {
  appSecret,
  initialAdminPassword: process.env.ADMIN_PASSWORD ?? '',
  host: str('HOST', '127.0.0.1'),
  port: int('PORT', 8080),
  publicBaseUrl: str('PUBLIC_BASE_URL', 'http://localhost:8080').replace(/\/+$/, ''),
  databasePath: resolve(ROOT, str('DATABASE_PATH', './data/dwm.db')),
  displayTimezone: str('TZ_DISPLAY', 'Asia/Tokyo'),
  schedulerTickMs: int('SCHEDULER_TICK_MS', 5000),
  schedulerBatch: int('SCHEDULER_BATCH', 10),
  misfireGraceSeconds: int('MISFIRE_GRACE_SECONDS', 86400),
  maxAttempts: int('MAX_ATTEMPTS', 5),
  sessionTtlSeconds: int('SESSION_TTL_SECONDS', 604800),
  cookieSecure: bool('COOKIE_SECURE', true),
  logLevel: str('LOG_LEVEL', 'info'),
  publicDir: resolve(ROOT, 'public'),
} as const;

export type Config = typeof config;
