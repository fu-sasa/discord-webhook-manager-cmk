import { all, get, run } from '../db/index.js';
import { encrypt, publicId } from '../lib/crypto.js';
import { config } from '../config.js';
import { cronNext, nowIso, validateCron } from '../lib/time.js';
import { normalisePayload, parseWebhookUrl, ValidationError } from '../lib/validate.js';
import { applyDefaults, getWebhookByName } from './webhooks.js';

export interface ScheduleRow {
  id: number;
  public_id: string;
  name: string;
  cron: string;
  tz: string;
  target_type: 'named' | 'url';
  webhook_id: number | null;
  url_enc: Uint8Array | null;
  url_hint: string;
  payload_json: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleInput {
  name: string;
  cron: string;
  tz?: string;
  webhookName?: string | undefined;
  webhookUrl?: string | undefined;
  payload: unknown;
  enabled?: boolean;
}

export function listSchedules(): ScheduleRow[] {
  return all<ScheduleRow>('SELECT * FROM schedules ORDER BY enabled DESC, next_run_at');
}

export function getSchedule(publicIdValue: string): ScheduleRow | undefined {
  return get<ScheduleRow>('SELECT * FROM schedules WHERE public_id = ?', publicIdValue);
}

export function createSchedule(input: ScheduleInput): ScheduleRow {
  const tz = input.tz || config.displayTimezone;
  try {
    validateCron(input.cron, tz);
  } catch (err) {
    throw new ValidationError(`cron 式が不正です: ${(err as Error).message}`);
  }

  let targetType: 'named' | 'url';
  let webhookId: number | null = null;
  let urlEnc: Buffer | null = null;
  let urlHint = '';
  let payloadInput = (input.payload ?? {}) as Record<string, unknown>;

  if (input.webhookName) {
    const wh = getWebhookByName(input.webhookName);
    if (!wh) throw new ValidationError(`webhook "${input.webhookName}" が見つかりません`);
    targetType = 'named';
    webhookId = wh.id;
    urlHint = wh.url_hint;
    payloadInput = applyDefaults(payloadInput, wh);
  } else if (input.webhookUrl) {
    const parsed = parseWebhookUrl(input.webhookUrl);
    targetType = 'url';
    urlEnc = encrypt(parsed.url);
    urlHint = parsed.hint;
  } else {
    throw new ValidationError('webhook か webhook_url のどちらかが必要です');
  }

  const payload = normalisePayload(payloadInput);
  const enabled = input.enabled === false ? 0 : 1;
  const id = publicId('sch');
  const ts = nowIso();

  run(
    `INSERT INTO schedules
      (public_id, name, cron, tz, target_type, webhook_id, url_enc, url_hint, payload_json,
       enabled, next_run_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    input.name,
    input.cron,
    tz,
    targetType,
    webhookId,
    urlEnc,
    urlHint,
    JSON.stringify(payload),
    enabled,
    enabled ? cronNext(input.cron, tz) : null,
    ts,
    ts,
  );
  return getSchedule(id)!;
}

export function setScheduleEnabled(publicIdValue: string, enabled: boolean): ScheduleRow | undefined {
  const row = getSchedule(publicIdValue);
  if (!row) return undefined;
  run(
    'UPDATE schedules SET enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
    enabled ? 1 : 0,
    enabled ? cronNext(row.cron, row.tz) : null,
    nowIso(),
    row.id,
  );
  return getSchedule(publicIdValue);
}

export function deleteSchedule(publicIdValue: string): boolean {
  const row = getSchedule(publicIdValue);
  if (!row) return false;
  run('DELETE FROM schedules WHERE id = ?', row.id);
  return true;
}

export function dueSchedules(atIso = nowIso()): ScheduleRow[] {
  return all<ScheduleRow>(
    'SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?',
    atIso,
  );
}

export function advanceSchedule(row: ScheduleRow, ranAt = nowIso()): void {
  let next: string | null = null;
  try {
    next = cronNext(row.cron, row.tz, new Date());
  } catch {
    next = null;
  }
  run(
    'UPDATE schedules SET last_run_at = ?, next_run_at = ?, updated_at = ? WHERE id = ?',
    ranAt,
    next,
    nowIso(),
    row.id,
  );
}
