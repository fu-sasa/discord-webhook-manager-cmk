import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { audit } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { config } from '../config.js';
import {
  createScheduleSchema,
  createWebhookSchema,
  sendMessageSchema,
  updateWebhookSchema,
  ValidationError,
  zodFail,
} from '../lib/validate.js';
import { authenticate, hasScope, type ApiKeyContext } from '../services/apikeys.js';
import {
  cancelJob,
  createJob,
  getJob,
  listJobs,
  parsePayload,
  type JobRow,
  type JobStatus,
} from '../services/jobs.js';
import {
  createWebhook,
  deleteWebhook,
  getWebhookByName,
  listWebhooks,
  toPublic,
  updateWebhook,
} from '../services/webhooks.js';
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  setScheduleEnabled,
} from '../services/schedules.js';
import { kick, waitForJob } from '../scheduler/worker.js';
import { cronPreview } from '../lib/time.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyContext;
  }
}

function fail(reply: FastifyReply, status: number, code: string, message: string, details?: unknown) {
  return reply.code(status).send({ error: { code, message, ...(details ? { details } : {}) } });
}

function jobView(job: JobRow) {
  return {
    id: job.public_id,
    status: job.status,
    target: {
      type: job.target_type,
      name: job.target_label || null,
      url_hint: job.url_hint,
    },
    scheduled_at: job.scheduled_at,
    sent_at: job.sent_at,
    attempts: job.attempts,
    next_attempt_at: job.next_attempt_at,
    response_status: job.response_status,
    discord_message_id: job.discord_message_id,
    last_error: job.last_error,
    idempotency_key: job.idempotency_key,
    source: job.source,
    created_at: job.created_at,
  };
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  // Per-key throttling. Keyed by a hash so raw tokens never sit in memory.
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (req) => sha256(String(req.headers.authorization ?? req.ip)),
    errorResponseBuilder: () => ({
      error: { code: 'rate_limited', message: 'リクエストが多すぎます。1分あたり120件までです。' },
    }),
  });

  // ---- authentication ------------------------------------------------------
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
      return fail(reply, 401, 'unauthorized', 'Authorization: Bearer <token> ヘッダーが必要です');
    }
    const ctx = authenticate(token);
    if (!ctx) return fail(reply, 401, 'unauthorized', 'API キーが無効か失効しています');
    req.apiKey = ctx;
    return undefined;
  });

  const requireManage = (req: FastifyRequest, reply: FastifyReply): boolean => {
    if (!hasScope(req.apiKey!, 'manage')) {
      fail(reply, 403, 'forbidden', 'この操作には manage スコープが必要です');
      return false;
    }
    return true;
  };

  // ---- messages ------------------------------------------------------------
  app.post('/messages', async (req, reply) => {
    const parsed = sendMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      const e = zodFail(parsed.error);
      return fail(reply, 400, 'invalid_request', e.message, e.details);
    }
    const body = parsed.data;
    const ctx = req.apiKey!;

    try {
      const { job, deduped } = createJob({
        webhookName: body.webhook,
        webhookUrl: body.webhook_url,
        payload: body.payload,
        sendAt: body.send_at,
        idempotencyKey: body.idempotency_key,
        source: `api:${ctx.id}`,
        allowRawUrl: ctx.allowRawUrl,
      });

      if (deduped) {
        return reply.code(200).send({ ...jobView(job), deduplicated: true });
      }

      audit(`api:${ctx.label}`, 'message.create', { job: job.public_id, target: job.target_label }, req.ip);
      kick();

      if (body.wait) {
        const settled = (await waitForJob(job.public_id, 10_000)) ?? job;
        return reply.code(settled.status === 'sent' ? 200 : 202).send(jobView(settled));
      }
      return reply.code(202).send(jobView(job));
    } catch (err) {
      if (err instanceof ValidationError) {
        return fail(reply, 400, 'invalid_request', err.message, err.details);
      }
      throw err;
    }
  });

  app.get('/messages', async (req, reply) => {
    const q = req.query as { status?: string; webhook?: string; limit?: string; offset?: string };
    const jobs = listJobs({
      status: q.status as JobStatus | undefined,
      webhook: q.webhook,
      limit: q.limit ? Number(q.limit) : 50,
      offset: q.offset ? Number(q.offset) : 0,
    });
    return reply.send({ data: jobs.map(jobView) });
  });

  app.get('/messages/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return fail(reply, 404, 'not_found', `ジョブ ${id} が見つかりません`);
    const includePayload = (req.query as { include?: string }).include === 'payload';
    return reply.send(includePayload ? { ...jobView(job), payload: parsePayload(job) } : jobView(job));
  });

  app.delete('/messages/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return fail(reply, 404, 'not_found', `ジョブ ${id} が見つかりません`);
    if (!cancelJob(id)) {
      return fail(reply, 409, 'not_cancelable', `ステータス ${job.status} のジョブはキャンセルできません`);
    }
    audit(`api:${req.apiKey!.label}`, 'message.cancel', { job: id }, req.ip);
    return reply.send(jobView(getJob(id)!));
  });

  // ---- named webhooks ------------------------------------------------------
  app.get('/webhooks', async (_req, reply) => {
    return reply.send({ data: listWebhooks().map(toPublic) });
  });

  app.get('/webhooks/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const wh = getWebhookByName(name);
    if (!wh) return fail(reply, 404, 'not_found', `webhook "${name}" が見つかりません`);
    return reply.send(toPublic(wh));
  });

  app.post('/webhooks', async (req, reply) => {
    if (!requireManage(req, reply)) return reply;
    const parsed = createWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      const e = zodFail(parsed.error);
      return fail(reply, 400, 'invalid_request', e.message, e.details);
    }
    try {
      const wh = createWebhook(parsed.data);
      audit(`api:${req.apiKey!.label}`, 'webhook.create', { name: wh.name }, req.ip);
      return reply.code(201).send(toPublic(wh));
    } catch (err) {
      if (err instanceof ValidationError) {
        const conflict = err.message.includes('既に登録');
        return fail(reply, conflict ? 409 : 400, conflict ? 'conflict' : 'invalid_request', err.message);
      }
      throw err;
    }
  });

  app.patch('/webhooks/:name', async (req, reply) => {
    if (!requireManage(req, reply)) return reply;
    const { name } = req.params as { name: string };
    const parsed = updateWebhookSchema.safeParse(req.body);
    if (!parsed.success) {
      const e = zodFail(parsed.error);
      return fail(reply, 400, 'invalid_request', e.message, e.details);
    }
    try {
      const wh = updateWebhook(name, parsed.data);
      audit(`api:${req.apiKey!.label}`, 'webhook.update', { name }, req.ip);
      return reply.send(toPublic(wh));
    } catch (err) {
      if (err instanceof ValidationError) {
        const missing = err.message.includes('見つかりません');
        return fail(reply, missing ? 404 : 400, missing ? 'not_found' : 'invalid_request', err.message);
      }
      throw err;
    }
  });

  app.delete('/webhooks/:name', async (req, reply) => {
    if (!requireManage(req, reply)) return reply;
    const { name } = req.params as { name: string };
    if (!deleteWebhook(name)) return fail(reply, 404, 'not_found', `webhook "${name}" が見つかりません`);
    audit(`api:${req.apiKey!.label}`, 'webhook.delete', { name }, req.ip);
    return reply.code(204).send();
  });

  // ---- schedules -----------------------------------------------------------
  app.get('/schedules', async (_req, reply) => {
    return reply.send({
      data: listSchedules().map((s) => ({
        id: s.public_id,
        name: s.name,
        cron: s.cron,
        tz: s.tz,
        target: { type: s.target_type, url_hint: s.url_hint },
        enabled: s.enabled === 1,
        last_run_at: s.last_run_at,
        next_run_at: s.next_run_at,
      })),
    });
  });

  app.post('/schedules', async (req, reply) => {
    if (!requireManage(req, reply)) return reply;
    const parsed = createScheduleSchema.safeParse(req.body);
    if (!parsed.success) {
      const e = zodFail(parsed.error);
      return fail(reply, 400, 'invalid_request', e.message, e.details);
    }
    try {
      const sch = createSchedule({
        name: parsed.data.name,
        cron: parsed.data.cron,
        tz: parsed.data.tz ?? config.displayTimezone,
        webhookName: parsed.data.webhook,
        webhookUrl: parsed.data.webhook_url,
        payload: parsed.data.payload,
        enabled: parsed.data.enabled,
      });
      audit(`api:${req.apiKey!.label}`, 'schedule.create', { id: sch.public_id }, req.ip);
      return reply.code(201).send({
        id: sch.public_id,
        name: sch.name,
        cron: sch.cron,
        tz: sch.tz,
        enabled: sch.enabled === 1,
        next_run_at: sch.next_run_at,
        upcoming: cronPreview(sch.cron, sch.tz, 3),
      });
    } catch (err) {
      if (err instanceof ValidationError) return fail(reply, 400, 'invalid_request', err.message, err.details);
      throw err;
    }
  });

  app.patch('/schedules/:id', async (req, reply) => {
    if (!requireManage(req, reply)) return reply;
    const { id } = req.params as { id: string };
    const body = req.body as { enabled?: boolean };
    if (typeof body?.enabled !== 'boolean') {
      return fail(reply, 400, 'invalid_request', 'enabled (boolean) のみ更新できます');
    }
    const updated = setScheduleEnabled(id, body.enabled);
    if (!updated) return fail(reply, 404, 'not_found', `スケジュール ${id} が見つかりません`);
    audit(`api:${req.apiKey!.label}`, 'schedule.update', { id, enabled: body.enabled }, req.ip);
    return reply.send({ id: updated.public_id, enabled: updated.enabled === 1, next_run_at: updated.next_run_at });
  });

  app.delete('/schedules/:id', async (req, reply) => {
    if (!requireManage(req, reply)) return reply;
    const { id } = req.params as { id: string };
    if (!getSchedule(id)) return fail(reply, 404, 'not_found', `スケジュール ${id} が見つかりません`);
    deleteSchedule(id);
    audit(`api:${req.apiKey!.label}`, 'schedule.delete', { id }, req.ip);
    return reply.code(204).send();
  });

  // ---- misc ----------------------------------------------------------------
  app.get('/me', async (req, reply) => {
    const ctx = req.apiKey!;
    return reply.send({
      label: ctx.label,
      scopes: ctx.scopes,
      allow_raw_url: ctx.allowRawUrl,
      timezone: config.displayTimezone,
    });
  });
}
