import { all, get, run } from '../db/index.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { parseWebhookUrl, ValidationError } from '../lib/validate.js';
import { nowIso } from '../lib/time.js';

export interface NamedWebhookRow {
  id: number;
  name: string;
  label: string;
  url_enc: Uint8Array;
  url_hint: string;
  default_username: string | null;
  default_avatar_url: string | null;
  default_thread_id: string | null;
  tags: string;
  enabled: number;
  note: string;
  created_at: string;
  updated_at: string;
}

/** Shape safe to render in the UI or return from the API — never the URL. */
export interface NamedWebhookPublic {
  id: number;
  name: string;
  label: string;
  url_hint: string;
  default_username: string | null;
  default_avatar_url: string | null;
  default_thread_id: string | null;
  tags: string[];
  enabled: boolean;
  note: string;
  created_at: string;
  updated_at: string;
}

export function toPublic(row: NamedWebhookRow): NamedWebhookPublic {
  return {
    id: row.id,
    name: row.name,
    label: row.label,
    url_hint: row.url_hint,
    default_username: row.default_username,
    default_avatar_url: row.default_avatar_url,
    default_thread_id: row.default_thread_id,
    tags: row.tags ? row.tags.split(',').filter(Boolean) : [],
    enabled: row.enabled === 1,
    note: row.note,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listWebhooks(): NamedWebhookRow[] {
  return all<NamedWebhookRow>('SELECT * FROM named_webhooks ORDER BY name');
}

export function getWebhookByName(name: string): NamedWebhookRow | undefined {
  return get<NamedWebhookRow>('SELECT * FROM named_webhooks WHERE name = ?', name);
}

export function getWebhookById(id: number): NamedWebhookRow | undefined {
  return get<NamedWebhookRow>('SELECT * FROM named_webhooks WHERE id = ?', id);
}

export function revealUrl(row: NamedWebhookRow): string {
  return decrypt(row.url_enc);
}

export interface WebhookInput {
  name: string;
  label?: string;
  url: string;
  default_username?: string;
  default_avatar_url?: string;
  default_thread_id?: string;
  tags?: string;
  note?: string;
  enabled?: boolean;
}

function normaliseTags(tags: string | undefined): string {
  if (!tags) return '';
  return tags
    .split(/[,\s]+/)
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
    .slice(0, 20)
    .join(',');
}

export function createWebhook(input: WebhookInput): NamedWebhookRow {
  if (getWebhookByName(input.name)) {
    throw new ValidationError(`name "${input.name}" は既に登録されています`);
  }
  const parsed = parseWebhookUrl(input.url);
  const ts = nowIso();
  run(
    `INSERT INTO named_webhooks
      (name, label, url_enc, url_hint, default_username, default_avatar_url, default_thread_id,
       tags, enabled, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    input.name,
    input.label ?? '',
    encrypt(parsed.url),
    parsed.hint,
    input.default_username || null,
    input.default_avatar_url || null,
    input.default_thread_id || null,
    normaliseTags(input.tags),
    input.enabled === false ? 0 : 1,
    input.note ?? '',
    ts,
    ts,
  );
  return getWebhookByName(input.name)!;
}

export function updateWebhook(name: string, input: Partial<WebhookInput>): NamedWebhookRow {
  const existing = getWebhookByName(name);
  if (!existing) throw new ValidationError(`webhook "${name}" が見つかりません`);

  const sets: string[] = [];
  const params: unknown[] = [];
  const push = (col: string, value: unknown) => {
    sets.push(`${col} = ?`);
    params.push(value);
  };

  if (input.url !== undefined && input.url !== '') {
    const parsed = parseWebhookUrl(input.url);
    push('url_enc', encrypt(parsed.url));
    push('url_hint', parsed.hint);
  }
  if (input.label !== undefined) push('label', input.label);
  if (input.default_username !== undefined) push('default_username', input.default_username || null);
  if (input.default_avatar_url !== undefined) push('default_avatar_url', input.default_avatar_url || null);
  if (input.default_thread_id !== undefined) push('default_thread_id', input.default_thread_id || null);
  if (input.tags !== undefined) push('tags', normaliseTags(input.tags));
  if (input.note !== undefined) push('note', input.note);
  if (input.enabled !== undefined) push('enabled', input.enabled ? 1 : 0);

  if (sets.length === 0) return existing;
  push('updated_at', nowIso());
  params.push(existing.id);
  run(`UPDATE named_webhooks SET ${sets.join(', ')} WHERE id = ?`, ...params);
  return getWebhookByName(name)!;
}

export function deleteWebhook(name: string): boolean {
  const existing = getWebhookByName(name);
  if (!existing) return false;
  run('DELETE FROM named_webhooks WHERE id = ?', existing.id);
  return true;
}

/** Apply a named webhook's defaults to a payload without overriding explicit values. */
export function applyDefaults(
  payload: Record<string, unknown>,
  row: NamedWebhookRow | undefined,
): Record<string, unknown> {
  if (!row) return payload;
  const out: Record<string, unknown> = { ...payload };
  if (out['username'] === undefined && row.default_username) out['username'] = row.default_username;
  if (out['avatar_url'] === undefined && row.default_avatar_url) out['avatar_url'] = row.default_avatar_url;
  if (out['thread_id'] === undefined && row.default_thread_id) out['thread_id'] = row.default_thread_id;
  return out;
}
