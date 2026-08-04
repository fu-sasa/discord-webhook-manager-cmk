import { all, get, run } from '../db/index.js';
import { randomToken, sha256 } from '../lib/crypto.js';
import { nowIso } from '../lib/time.js';

export type Scope = 'send' | 'manage';

export interface ApiKeyRow {
  id: number;
  label: string;
  key_hash: string;
  prefix: string;
  scopes: string;
  allow_raw_url: number;
  last_used_at: string | null;
  disabled_at: string | null;
  created_at: string;
}

export interface ApiKeyContext {
  id: number;
  label: string;
  scopes: Scope[];
  allowRawUrl: boolean;
}

const TOKEN_PREFIX = 'dwm_';

export function listApiKeys(): ApiKeyRow[] {
  return all<ApiKeyRow>('SELECT * FROM api_keys ORDER BY disabled_at IS NOT NULL, created_at DESC');
}

/**
 * Creates a key and returns the plaintext token exactly once — only its
 * SHA-256 is persisted, so a lost token cannot be recovered, only replaced.
 */
export function createApiKey(opts: {
  label: string;
  scopes: Scope[];
  allowRawUrl: boolean;
}): { row: ApiKeyRow; token: string } {
  const token = TOKEN_PREFIX + randomToken(32);
  run(
    'INSERT INTO api_keys (label, key_hash, prefix, scopes, allow_raw_url, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    opts.label,
    sha256(token),
    token.slice(0, 12),
    opts.scopes.join(','),
    opts.allowRawUrl ? 1 : 0,
    nowIso(),
  );
  const row = get<ApiKeyRow>('SELECT * FROM api_keys WHERE key_hash = ?', sha256(token))!;
  return { row, token };
}

export function revokeApiKey(id: number): boolean {
  const row = get<ApiKeyRow>('SELECT * FROM api_keys WHERE id = ?', id);
  if (!row || row.disabled_at) return false;
  run('UPDATE api_keys SET disabled_at = ? WHERE id = ?', nowIso(), id);
  return true;
}

export function deleteApiKey(id: number): boolean {
  const row = get<ApiKeyRow>('SELECT id FROM api_keys WHERE id = ?', id);
  if (!row) return false;
  run('DELETE FROM api_keys WHERE id = ?', id);
  return true;
}

/** Look up an active key by its plaintext token. */
export function authenticate(token: string): ApiKeyContext | null {
  if (!token.startsWith(TOKEN_PREFIX)) return null;
  const row = get<ApiKeyRow>(
    'SELECT * FROM api_keys WHERE key_hash = ? AND disabled_at IS NULL',
    sha256(token),
  );
  if (!row) return null;
  // Best-effort usage stamp; never block the request on it.
  try {
    run('UPDATE api_keys SET last_used_at = ? WHERE id = ?', nowIso(), row.id);
  } catch {
    /* ignore */
  }
  return {
    id: row.id,
    label: row.label,
    scopes: row.scopes.split(',').filter(Boolean) as Scope[],
    allowRawUrl: row.allow_raw_url === 1,
  };
}

export function hasScope(ctx: ApiKeyContext, scope: Scope): boolean {
  return ctx.scopes.includes(scope);
}
