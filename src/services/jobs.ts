import { all, get, run } from '../db/index.js';
import { encrypt, decrypt, publicId } from '../lib/crypto.js';
import { nowIso } from '../lib/time.js';
import { normalisePayload, parseWebhookUrl, ValidationError, type Payload } from '../lib/validate.js';
import { applyDefaults, getWebhookById, getWebhookByName, revealUrl } from './webhooks.js';

export type JobStatus = 'queued' | 'sending' | 'sent' | 'failed' | 'canceled';

export interface JobRow {
  id: number;
  public_id: string;
  schedule_id: number | null;
  target_type: 'named' | 'url';
  webhook_id: number | null;
  url_enc: Uint8Array | null;
  url_hint: string;
  target_label: string;
  payload_json: string;
  scheduled_at: string;
  status: JobStatus;
  attempts: number;
  next_attempt_at: string | null;
  last_error: string | null;
  response_status: number | null;
  discord_message_id: string | null;
  idempotency_key: string | null;
  source: string;
  alerted: number;
  created_at: string;
  sent_at: string | null;
}

export interface CreateJobInput {
  webhookName?: string | undefined;
  webhookUrl?: string | undefined;
  payload: unknown;
  /** ISO8601. Omitted or in the past means "send on the next tick". */
  sendAt?: string | undefined;
  idempotencyKey?: string | undefined;
  source: string;
  scheduleId?: number | null;
  /** Set false for API keys that may only use registered named webhooks. */
  allowRawUrl?: boolean;
}

export interface CreateJobResult {
  job: JobRow;
  deduped: boolean;
}

export function createJob(input: CreateJobInput): CreateJobResult {
  if (input.idempotencyKey) {
    const existing = get<JobRow>('SELECT * FROM jobs WHERE idempotency_key = ?', input.idempotencyKey);
    if (existing) return { job: existing, deduped: true };
  }

  let targetType: 'named' | 'url';
  let webhookId: number | null = null;
  let urlEnc: Buffer | null = null;
  let urlHint = '';
  let targetLabel = '';
  let payloadInput = (input.payload ?? {}) as Record<string, unknown>;

  if (input.webhookName) {
    const wh = getWebhookByName(input.webhookName);
    if (!wh) throw new ValidationError(`webhook "${input.webhookName}" が見つかりません`);
    if (wh.enabled !== 1) throw new ValidationError(`webhook "${input.webhookName}" は無効化されています`);
    targetType = 'named';
    webhookId = wh.id;
    urlHint = wh.url_hint;
    targetLabel = wh.label ? `${wh.name} (${wh.label})` : wh.name;
    payloadInput = applyDefaults(payloadInput, wh);
  } else if (input.webhookUrl) {
    if (input.allowRawUrl === false) {
      throw new ValidationError('この API キーは Webhook URL の直接指定を許可されていません');
    }
    const parsed = parseWebhookUrl(input.webhookUrl);
    targetType = 'url';
    urlEnc = encrypt(parsed.url);
    urlHint = parsed.hint;
    targetLabel = '直接指定';
  } else {
    throw new ValidationError('webhook か webhook_url のどちらかが必要です');
  }

  const payload = normalisePayload(payloadInput);
  const scheduledAt = input.sendAt ? new Date(input.sendAt).toISOString() : nowIso();
  const id = publicId('job');
  const ts = nowIso();

  run(
    `INSERT INTO jobs
      (public_id, schedule_id, target_type, webhook_id, url_enc, url_hint, target_label,
       payload_json, scheduled_at, status, attempts, next_attempt_at, idempotency_key, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)`,
    id,
    input.scheduleId ?? null,
    targetType,
    webhookId,
    urlEnc,
    urlHint,
    targetLabel,
    JSON.stringify(payload),
    scheduledAt,
    scheduledAt,
    input.idempotencyKey ?? null,
    input.source,
    ts,
  );

  return { job: get<JobRow>('SELECT * FROM jobs WHERE public_id = ?', id)!, deduped: false };
}

/**
 * Named targets resolve at send time so that rotating a webhook's URL also fixes
 * jobs that were queued before the rotation.
 */
export function resolveTargetUrl(job: JobRow): string {
  if (job.target_type === 'url') {
    if (!job.url_enc) throw new Error('ジョブに Webhook URL が保存されていません');
    return decrypt(job.url_enc);
  }
  if (job.webhook_id === null) throw new Error('宛先の named webhook が削除されています');
  const wh = getWebhookById(job.webhook_id);
  if (!wh) throw new Error('宛先の named webhook が削除されています');
  if (wh.enabled !== 1) throw new Error(`named webhook "${wh.name}" は無効化されています`);
  return revealUrl(wh);
}

export function getJob(publicIdValue: string): JobRow | undefined {
  return get<JobRow>('SELECT * FROM jobs WHERE public_id = ?', publicIdValue);
}

export interface ListJobsOptions {
  status?: JobStatus;
  webhook?: string;
  limit?: number;
  offset?: number;
}

export function listJobs(opts: ListJobsOptions = {}): JobRow[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (opts.status) {
    where.push('status = ?');
    params.push(opts.status);
  }
  if (opts.webhook) {
    where.push('webhook_id = (SELECT id FROM named_webhooks WHERE name = ?)');
    params.push(opts.webhook);
  }
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const offset = Math.max(opts.offset ?? 0, 0);
  return all<JobRow>(
    `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY COALESCE(sent_at, scheduled_at) DESC, id DESC LIMIT ? OFFSET ?`,
    ...params,
    limit,
    offset,
  );
}

export function countJobs(status: JobStatus): number {
  const row = get<{ n: number }>('SELECT COUNT(*) AS n FROM jobs WHERE status = ?', status);
  return Number(row?.n ?? 0);
}

export function cancelJob(publicIdValue: string): boolean {
  const job = getJob(publicIdValue);
  if (!job || job.status !== 'queued') return false;
  const res = run(
    "UPDATE jobs SET status = 'canceled', last_error = 'キャンセルされました' WHERE id = ? AND status = 'queued'",
    job.id,
  );
  return Number(res.changes) > 0;
}

export function parsePayload(job: JobRow): Payload {
  return JSON.parse(job.payload_json) as Payload;
}

export const STATUS_LABEL: Record<JobStatus, string> = {
  queued: '待機中',
  sending: '送信中',
  sent: '送信済み',
  failed: '失敗',
  canceled: 'キャンセル',
};
