import { get, getSetting, run, setSetting } from '../db/index.js';
import { config } from '../config.js';
import { hashPassword, randomToken, verifyPassword } from '../lib/crypto.js';
import { isoPlusSeconds, nowIso } from '../lib/time.js';
import { logger } from '../lib/logger.js';

const PASSWORD_KEY = 'admin_password_hash';
const PASSWORD_LOGIN_KEY = 'password_login_enabled';
export const SESSION_COOKIE = 'dwm_session';
export const OAUTH_STATE_COOKIE = 'dwm_oauth_state';

const LOCKOUT_WINDOW_MINUTES = 15;
const LOCKOUT_THRESHOLD = 10;

export function isPasswordConfigured(): boolean {
  return Boolean(getSetting(PASSWORD_KEY));
}

export function setAdminPassword(password: string): void {
  if (password.length < 12) {
    throw new Error('パスワードは12文字以上にしてください');
  }
  setSetting(PASSWORD_KEY, hashPassword(password));
}

export function verifyAdminPassword(password: string): boolean {
  const stored = getSetting(PASSWORD_KEY);
  if (!stored) return false;
  return verifyPassword(password, stored);
}

/**
 * Seed the admin password on first boot. Falls back to a generated one so the
 * service never starts with an empty or guessable credential.
 */
export function bootstrapAdminPassword(): void {
  if (isPasswordConfigured()) return;
  const seeded = config.initialAdminPassword;
  if (seeded && seeded.length >= 12) {
    setAdminPassword(seeded);
    logger.info('admin password initialised from ADMIN_PASSWORD');
    return;
  }
  const generated = randomToken(12);
  setAdminPassword(generated);
  logger.warn('='.repeat(72));
  logger.warn('ADMIN_PASSWORD was not set (or was shorter than 12 chars).');
  logger.warn(`A password has been generated — save it now, it is not shown again:`);
  logger.warn(`    ${generated}`);
  logger.warn('='.repeat(72));
}

/**
 * The emergency password path. Discord is the intended way in, but if the OAuth
 * app is misconfigured or Discord is unreachable this is the only route back
 * into a remote box short of a shell. Disable it once Discord login is proven.
 */
export function isPasswordLoginEnabled(): boolean {
  return getSetting(PASSWORD_LOGIN_KEY) !== '0';
}

export function setPasswordLoginEnabled(enabled: boolean): void {
  setSetting(PASSWORD_LOGIN_KEY, enabled ? '1' : '0');
}

// ---- sessions ---------------------------------------------------------------

export type LoginMethod = 'discord' | 'password';

export interface SessionRow {
  id: string;
  created_at: string;
  expires_at: string;
  ip: string;
  ua: string;
  admin_id: number | null;
  method: LoginMethod;
}

export function createSession(
  ip: string,
  ua: string,
  opts: { adminId?: number | null; method?: LoginMethod } = {},
): SessionRow {
  const id = randomToken(32);
  const created = nowIso();
  const expires = isoPlusSeconds(config.sessionTtlSeconds);
  const adminId = opts.adminId ?? null;
  const method = opts.method ?? 'password';
  run(
    'INSERT INTO sessions (id, created_at, expires_at, ip, ua, admin_id, method) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id,
    created,
    expires,
    ip,
    ua.slice(0, 300),
    adminId,
    method,
  );
  return { id, created_at: created, expires_at: expires, ip, ua, admin_id: adminId, method };
}

export function getSession(id: string | undefined): SessionRow | undefined {
  if (!id) return undefined;
  const row = get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
  if (!row) return undefined;
  if (Date.parse(row.expires_at) <= Date.now()) {
    run('DELETE FROM sessions WHERE id = ?', id);
    return undefined;
  }
  return row;
}

export function destroySession(id: string | undefined): void {
  if (id) run('DELETE FROM sessions WHERE id = ?', id);
}

/** Invalidate every session — used after a password change. */
export function destroyAllSessions(): void {
  run('DELETE FROM sessions');
}

// ---- brute-force throttling -------------------------------------------------

export function recordLoginAttempt(ip: string, success: boolean): void {
  run('INSERT INTO login_attempts (ip, at, success) VALUES (?, ?, ?)', ip, nowIso(), success ? 1 : 0);
  if (success) run('DELETE FROM login_attempts WHERE ip = ? AND success = 0', ip);
}

export function isLockedOut(ip: string): boolean {
  const since = new Date(Date.now() - LOCKOUT_WINDOW_MINUTES * 60_000).toISOString();
  const row = get<{ n: number }>(
    'SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ? AND success = 0 AND at >= ?',
    ip,
    since,
  );
  return Number(row?.n ?? 0) >= LOCKOUT_THRESHOLD;
}

export const LOCKOUT_MESSAGE = `ログイン試行が多すぎます。${LOCKOUT_WINDOW_MINUTES} 分ほど待ってから再度お試しください。`;
