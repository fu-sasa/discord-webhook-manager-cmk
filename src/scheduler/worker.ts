import { all, get, run } from '../db/index.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { nowIso } from '../lib/time.js';
import { decrypt } from '../lib/crypto.js';
import { sendToDiscord } from '../services/discord.js';
import {
  createJob,
  getJob,
  parsePayload,
  resolveTargetUrl,
  type JobRow,
} from '../services/jobs.js';
import { advanceSchedule, dueSchedules } from '../services/schedules.js';
import { alertJobFailure } from '../services/alerts.js';

/** Backoff between delivery attempts, in seconds. Index = attempt number - 1. */
const BACKOFF_SECONDS = [30, 120, 600, 1800, 7200];

let timer: NodeJS.Timeout | null = null;
let running = false;
let stopped = false;

export function startScheduler(): void {
  stopped = false;
  recoverStuckJobs();
  timer = setInterval(() => {
    void tick();
  }, config.schedulerTickMs);
  timer.unref?.();
  logger.info(`scheduler started (tick=${config.schedulerTickMs}ms, batch=${config.schedulerBatch})`);
  void tick();
}

export function stopScheduler(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

/** Run a tick immediately — used after enqueueing so "send now" feels instant. */
export function kick(): void {
  if (!stopped) void tick();
}

/**
 * A job left in `sending` means the process died mid-delivery. Requeue it: the
 * send either never reached Discord or already succeeded, and a duplicate
 * announcement is a smaller problem than a silently dropped one.
 */
function recoverStuckJobs(): void {
  const res = run(
    "UPDATE jobs SET status = 'queued', next_attempt_at = ? WHERE status = 'sending'",
    nowIso(),
  );
  if (Number(res.changes) > 0) {
    logger.warn(`recovered ${res.changes} job(s) left in 'sending' by a previous run`);
  }
}

export async function tick(): Promise<void> {
  if (running || stopped) return;
  running = true;
  try {
    materialiseSchedules();
    const jobs = claimDueJobs();
    for (const job of jobs) {
      await deliver(job);
    }
    pruneExpiredSessions();
  } catch (err) {
    logger.error(`scheduler tick failed: ${(err as Error).message}`, err);
  } finally {
    running = false;
  }
}

function materialiseSchedules(): void {
  for (const sch of dueSchedules()) {
    try {
      const payload = JSON.parse(sch.payload_json) as unknown;
      createJob({
        webhookName:
          sch.target_type === 'named' && sch.webhook_id !== null
            ? get<{ name: string }>('SELECT name FROM named_webhooks WHERE id = ?', sch.webhook_id)?.name
            : undefined,
        webhookUrl: sch.target_type === 'url' && sch.url_enc ? decrypt(sch.url_enc) : undefined,
        payload,
        source: `schedule:${sch.public_id}`,
        scheduleId: sch.id,
      });
      logger.info(`schedule ${sch.public_id} (${sch.name}) fired`);
    } catch (err) {
      logger.error(`schedule ${sch.public_id} could not be queued: ${(err as Error).message}`);
    } finally {
      // Always advance, otherwise a broken schedule fires every tick forever.
      advanceSchedule(sch);
    }
  }
}

function claimDueJobs(): JobRow[] {
  const now = nowIso();
  const candidates = all<JobRow>(
    `SELECT * FROM jobs
     WHERE status = 'queued'
       AND scheduled_at <= ?
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY scheduled_at ASC, id ASC
     LIMIT ?`,
    now,
    now,
    config.schedulerBatch,
  );

  const claimed: JobRow[] = [];
  for (const job of candidates) {
    const res = run(
      "UPDATE jobs SET status = 'sending', attempts = attempts + 1 WHERE id = ? AND status = 'queued'",
      job.id,
    );
    if (Number(res.changes) > 0) claimed.push({ ...job, status: 'sending', attempts: job.attempts + 1 });
  }
  return claimed;
}

async function deliver(job: JobRow): Promise<void> {
  const lateBySeconds = (Date.now() - Date.parse(job.scheduled_at)) / 1000;
  if (job.attempts <= 1 && lateBySeconds > config.misfireGraceSeconds) {
    await fail(
      job,
      null,
      `予定時刻から ${Math.round(lateBySeconds / 3600)} 時間以上経過していたため送信を中止しました（misfire）`,
    );
    return;
  }

  let url: string;
  try {
    url = resolveTargetUrl(job);
  } catch (err) {
    await fail(job, null, (err as Error).message);
    return;
  }

  const result = await sendToDiscord(url, parsePayload(job));

  if (result.ok) {
    run(
      `UPDATE jobs SET status = 'sent', sent_at = ?, response_status = ?, discord_message_id = ?,
       last_error = NULL, next_attempt_at = NULL WHERE id = ?`,
      nowIso(),
      result.status,
      result.messageId ?? null,
      job.id,
    );
    logger.info(`job ${job.public_id} sent (${job.target_label || job.url_hint})`);
    return;
  }

  // Rate limiting is not the job's fault — requeue without burning an attempt.
  if (result.status === 429 && result.retryAfterMs) {
    run(
      `UPDATE jobs SET status = 'queued', attempts = attempts - 1,
       next_attempt_at = ?, last_error = ?, response_status = 429 WHERE id = ?`,
      new Date(Date.now() + result.retryAfterMs).toISOString(),
      result.error ?? 'rate limited',
      job.id,
    );
    logger.warn(`job ${job.public_id} rate limited, retrying in ${Math.round(result.retryAfterMs / 1000)}s`);
    return;
  }

  if (result.retryable && job.attempts < config.maxAttempts) {
    const wait = BACKOFF_SECONDS[Math.min(job.attempts - 1, BACKOFF_SECONDS.length - 1)]!;
    run(
      `UPDATE jobs SET status = 'queued', next_attempt_at = ?, last_error = ?, response_status = ?
       WHERE id = ?`,
      new Date(Date.now() + wait * 1000).toISOString(),
      result.error ?? '不明なエラー',
      result.status || null,
      job.id,
    );
    logger.warn(
      `job ${job.public_id} attempt ${job.attempts}/${config.maxAttempts} failed (${result.error}); retrying in ${wait}s`,
    );
    return;
  }

  await fail(job, result.status || null, result.error ?? '不明なエラー');
}

async function fail(job: JobRow, status: number | null, message: string): Promise<void> {
  run(
    "UPDATE jobs SET status = 'failed', last_error = ?, response_status = ?, next_attempt_at = NULL WHERE id = ?",
    message,
    status,
    job.id,
  );
  logger.error(`job ${job.public_id} failed: ${message}`);
  const fresh = getJob(job.public_id);
  if (fresh) await alertJobFailure(fresh);
}

function pruneExpiredSessions(): void {
  run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
  run("DELETE FROM login_attempts WHERE at < datetime('now', '-1 day')");
}

/**
 * Block until a job reaches a terminal state, for the API's `wait: true`.
 * Returns the latest known row even if the timeout wins.
 */
export async function waitForJob(publicIdValue: string, timeoutMs = 10_000): Promise<JobRow | undefined> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = getJob(publicIdValue);
    if (!job) return undefined;
    if (job.status === 'sent' || job.status === 'failed' || job.status === 'canceled') return job;
    if (Date.now() >= deadline) return job;
    await new Promise((r) => setTimeout(r, 200));
  }
}
