import { all, get, run } from '../db/index.js';
import { nowIso } from '../lib/time.js';
import { ValidationError } from '../lib/validate.js';
import { logger } from '../lib/logger.js';
import { config } from '../config.js';

export interface AdminRow {
  id: number;
  email: string;
  label: string;
  discord_user_id: string | null;
  discord_username: string | null;
  discord_global_name: string | null;
  avatar_url: string | null;
  added_by: string;
  created_at: string;
  last_login_at: string | null;
}

/**
 * Emails are compared case-insensitively. Discord returns them lowercased in
 * practice, but an admin typing one into the UI may not.
 */
export function normaliseEmail(input: string): string {
  return input.trim().toLowerCase();
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function listAdmins(): AdminRow[] {
  return all<AdminRow>('SELECT * FROM admins ORDER BY created_at');
}

export function countAdmins(): number {
  return Number(get<{ n: number }>('SELECT COUNT(*) AS n FROM admins')?.n ?? 0);
}

export function getAdminByEmail(email: string): AdminRow | undefined {
  return get<AdminRow>('SELECT * FROM admins WHERE email = ?', normaliseEmail(email));
}

export function getAdminById(id: number): AdminRow | undefined {
  return get<AdminRow>('SELECT * FROM admins WHERE id = ?', id);
}

export function addAdmin(email: string, label: string, addedBy: string): AdminRow {
  const normalised = normaliseEmail(email);
  if (!EMAIL_RE.test(normalised)) {
    throw new ValidationError('メールアドレスの形式が正しくありません');
  }
  if (getAdminByEmail(normalised)) {
    throw new ValidationError(`${normalised} は既に管理者として登録されています`);
  }
  run(
    'INSERT INTO admins (email, label, added_by, created_at) VALUES (?, ?, ?, ?)',
    normalised,
    label.trim().slice(0, 120),
    addedBy,
    nowIso(),
  );
  return getAdminByEmail(normalised)!;
}

/**
 * Removing an admin also drops their sessions (ON DELETE CASCADE), so access is
 * revoked immediately rather than at the next session expiry.
 */
export function removeAdmin(id: number, actingAdminId: number | null): AdminRow {
  const target = getAdminById(id);
  if (!target) throw new ValidationError('その管理者は見つかりません');
  if (actingAdminId !== null && target.id === actingAdminId) {
    throw new ValidationError('自分自身は削除できません。他の管理者に依頼してください。');
  }
  if (countAdmins() <= 1) {
    throw new ValidationError('最後の管理者は削除できません。先に別の管理者を追加してください。');
  }
  run('DELETE FROM admins WHERE id = ?', id);
  return target;
}

/** Record the Discord profile seen at login, so the UI can show who is who. */
export function recordLogin(
  id: number,
  profile: {
    discordUserId: string;
    username: string;
    globalName: string | null;
    avatarUrl: string | null;
  },
): void {
  run(
    `UPDATE admins SET discord_user_id = ?, discord_username = ?, discord_global_name = ?,
     avatar_url = ?, last_login_at = ? WHERE id = ?`,
    profile.discordUserId,
    profile.username,
    profile.globalName,
    profile.avatarUrl,
    nowIso(),
    id,
  );
}

/**
 * Seed the first admin from BOOTSTRAP_ADMIN_EMAIL so that a fresh install has
 * someone who can log in. Without this, Discord login would have nobody to
 * authorise and the instance would only be reachable via the emergency password.
 */
export function bootstrapAdmin(): void {
  if (countAdmins() > 0) return;
  const email = config.bootstrapAdminEmail;
  if (!email) {
    logger.warn(
      'no admins registered and BOOTSTRAP_ADMIN_EMAIL is unset — ' +
        'log in with the emergency password and add an admin from the 管理者 page',
    );
    return;
  }
  try {
    addAdmin(email, '初期管理者', 'bootstrap');
    logger.info(`bootstrapped admin from BOOTSTRAP_ADMIN_EMAIL: ${normaliseEmail(email)}`);
  } catch (err) {
    logger.error(`could not bootstrap admin "${email}": ${(err as Error).message}`);
  }
}

export function displayName(admin: AdminRow): string {
  return admin.discord_global_name || admin.discord_username || admin.label || admin.email;
}
