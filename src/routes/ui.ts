import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { all, audit, getSetting, run, setSetting } from '../db/index.js';
import { config } from '../config.js';
import { formatLocal, utcIsoToWallTime, wallTimeToUtcIso } from '../lib/time.js';
import { ValidationError, normalisePayload, type Payload } from '../lib/validate.js';
import {
  LOCKOUT_MESSAGE,
  OAUTH_STATE_COOKIE,
  SESSION_COOKIE,
  createSession,
  destroyAllSessions,
  destroySession,
  getSession,
  isLockedOut,
  isPasswordLoginEnabled,
  recordLoginAttempt,
  setAdminPassword,
  setPasswordLoginEnabled,
  verifyAdminPassword,
  type SessionRow,
} from '../services/auth.js';
import {
  addAdmin,
  displayName,
  getAdminByEmail,
  getAdminById,
  listAdmins,
  recordLogin,
  removeAdmin,
  type AdminRow,
} from '../services/admins.js';
import {
  OAuthError,
  authorizeUrl,
  exchangeCode,
  fetchProfile,
  revokeToken,
} from '../services/discord-oauth.js';
import { adminsPage } from '../views/admins.js';
import { randomToken, safeEqual } from '../lib/crypto.js';
import { runWithContext, setCurrentUser } from '../lib/request-context.js';
import {
  createWebhook,
  deleteWebhook,
  getWebhookById,
  getWebhookByName,
  listWebhooks,
  revealUrl,
  updateWebhook,
} from '../services/webhooks.js';
import {
  cancelJob,
  countJobs,
  createJob,
  getJob,
  listJobs,
  parsePayload,
  type JobStatus,
} from '../services/jobs.js';
import {
  createSchedule,
  deleteSchedule,
  getSchedule,
  listSchedules,
  setScheduleEnabled,
} from '../services/schedules.js';
import { createApiKey, deleteApiKey, listApiKeys, revokeApiKey, type Scope } from '../services/apikeys.js';
import { ALERT_SETTING_KEY, getAlertWebhookName } from '../services/alerts.js';
import { sendToDiscord } from '../services/discord.js';
import { kick } from '../scheduler/worker.js';
import { loginPage } from '../views/login.js';
import { dashboardPage } from '../views/dashboard.js';
import { webhookEditPage, webhooksPage } from '../views/webhooks.js';
import { composePage } from '../views/compose.js';
import { jobDetailPage, jobsPage } from '../views/jobs.js';
import { schedulesPage } from '../views/schedules.js';
import { apiKeysPage } from '../views/apikeys.js';
import { settingsPage, type AuditEntry } from '../views/settings.js';
import { logger } from '../lib/logger.js';

declare module 'fastify' {
  interface FastifyRequest {
    session?: SessionRow;
    admin?: AdminRow;
  }
}

/** Who to attribute an audit entry to. */
function actorOf(req: FastifyRequest): string {
  if (req.admin) return req.admin.email;
  if (req.session) return 'emergency-password';
  return 'system';
}

function sendHtml(reply: FastifyReply, body: string, status = 200) {
  return reply.code(status).type('text/html; charset=utf-8').send(body);
}

function flashRedirect(reply: FastifyReply, path: string, opts: { ok?: string; err?: string } = {}) {
  const params = new URLSearchParams();
  if (opts.ok) params.set('ok', opts.ok);
  if (opts.err) params.set('err', opts.err);
  const qs = params.toString();
  return reply.redirect(qs ? `${path}${path.includes('?') ? '&' : '?'}${qs}` : path, 303);
}

function flash(req: FastifyRequest): { notice: string | null; error: string | null } {
  const q = req.query as { ok?: string; err?: string };
  return { notice: q.ok ?? null, error: q.err ?? null };
}

function str(body: unknown, key: string): string {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  return typeof v === 'string' ? v.trim() : '';
}

function checked(body: unknown, key: string): boolean {
  const v = (body as Record<string, unknown> | undefined)?.[key];
  return v === 'on' || v === 'true' || v === '1';
}

/**
 * Turn a compose-form submission into a Discord payload. The browser normally
 * supplies a fully-built `payload` JSON; the individual fields are the fallback
 * so plain-text sending still works without JavaScript.
 */
function payloadFromForm(body: unknown): Payload {
  const rawPayload = str(body, 'payload') || str(body, 'payload_json');
  let draft: Record<string, unknown>;
  if (rawPayload) {
    try {
      const parsed = JSON.parse(rawPayload) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ValidationError('payload は JSON オブジェクトである必要があります');
      }
      draft = parsed as Record<string, unknown>;
    } catch (err) {
      if (err instanceof ValidationError) throw err;
      throw new ValidationError(`JSON を解釈できませんでした: ${(err as Error).message}`);
    }
  } else {
    draft = {};
    const content = str(body, 'content');
    if (content) draft['content'] = content;
    const username = str(body, 'username');
    if (username) draft['username'] = username;
    const avatar = str(body, 'avatar_url');
    if (avatar) draft['avatar_url'] = avatar;
    const thread = str(body, 'thread_id');
    if (thread) draft['thread_id'] = thread;
    if (checked(body, 'allow_everyone')) draft['allowed_mentions'] = { parse: ['everyone', 'roles', 'users'] };
    if (checked(body, 'silent')) draft['flags'] = 4096;
  }
  return normalisePayload(draft);
}

const PUBLIC_PATHS = new Set(['/login', '/healthz', '/auth/discord', '/auth/discord/callback']);

export async function registerUiRoutes(app: FastifyInstance): Promise<void> {
  // Establish the per-request identity context that `layout()` reads.
  app.addHook('onRequest', (req, _reply, done) => {
    runWithContext({ user: null }, done);
  });

  // ---- authentication guard ------------------------------------------------
  app.addHook('preHandler', async (req: FastifyRequest, reply: FastifyReply) => {
    const path = req.url.split('?')[0] ?? '';
    const session = getSession(req.cookies[SESSION_COOKIE]);
    if (session) {
      req.session = session;
      const admin = session.admin_id !== null ? getAdminById(session.admin_id) : undefined;
      if (admin) req.admin = admin;
      setCurrentUser({
        name: admin ? displayName(admin) : '緊急ログイン',
        avatarUrl: admin?.avatar_url ?? null,
        emergency: !admin,
      });
    }

    if (PUBLIC_PATHS.has(path) || path.startsWith('/static/')) return undefined;
    if (!session) {
      if (req.method !== 'GET') return reply.code(401).send('セッションが切れています。再ログインしてください。');
      return reply.redirect('/login', 303);
    }
    return undefined;
  });

  const setSessionCookie = (reply: FastifyReply, id: string) => {
    reply.setCookie(SESSION_COOKIE, id, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: config.sessionTtlSeconds,
    });
  };

  const renderLogin = (req: FastifyRequest, reply: FastifyReply, error?: string | null, status = 200) => {
    const f = flash(req);
    return sendHtml(
      reply,
      loginPage({
        error: error ?? f.error,
        notice: f.notice,
        discordEnabled: config.discordEnabled,
        passwordEnabled: isPasswordLoginEnabled(),
      }),
      status,
    );
  };

  // ---- login ---------------------------------------------------------------
  app.get('/login', async (req, reply) => {
    if (req.session) return reply.redirect('/', 303);
    return renderLogin(req, reply);
  });

  // ---- Discord OAuth2 ------------------------------------------------------
  app.get('/auth/discord', async (req, reply) => {
    if (!config.discordEnabled) {
      return renderLogin(req, reply, 'Discord ログインが設定されていません。', 503);
    }
    // The state is held in a cookie rather than server-side: it only needs to
    // survive the round trip and prove the callback belongs to this browser.
    const state = randomToken(24);
    reply.setCookie(OAUTH_STATE_COOKIE, state, {
      path: '/auth/discord',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.cookieSecure,
      maxAge: 600,
    });
    return reply.redirect(authorizeUrl(state), 303);
  });

  app.get('/auth/discord/callback', async (req, reply) => {
    const q = req.query as { code?: string; state?: string; error?: string; error_description?: string };
    const expected = req.cookies[OAUTH_STATE_COOKIE];
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: '/auth/discord' });

    if (q.error) {
      const detail = q.error === 'access_denied' ? 'Discord 側で許可がキャンセルされました。' : q.error;
      return renderLogin(req, reply, `ログインできませんでした: ${detail}`, 401);
    }
    if (!q.code || !q.state || !expected || !safeEqual(q.state, expected)) {
      return renderLogin(
        req,
        reply,
        'ログインの検証に失敗しました（リンクの有効期限切れの可能性があります）。もう一度お試しください。',
        400,
      );
    }
    if (isLockedOut(req.ip)) return renderLogin(req, reply, LOCKOUT_MESSAGE, 429);

    let accessToken: string;
    try {
      accessToken = await exchangeCode(q.code);
    } catch (err) {
      const message = err instanceof OAuthError ? err.message : 'Discord の認証に失敗しました';
      logger.error(`discord callback failed: ${(err as Error).message}`);
      return renderLogin(req, reply, message, 502);
    }

    let profile;
    try {
      profile = await fetchProfile(accessToken);
    } catch (err) {
      return renderLogin(req, reply, (err as Error).message, 502);
    } finally {
      void revokeToken(accessToken);
    }

    if (!profile.email) {
      audit('discord', 'login.denied', { reason: 'no_email', discord_id: profile.id }, req.ip);
      return renderLogin(
        req,
        reply,
        'Discord アカウントにメールアドレスが登録されていません。',
        403,
      );
    }
    // An unverified address can be set to anyone else's, so it must not grant access.
    if (!profile.emailVerified) {
      audit('discord', 'login.denied', { reason: 'email_unverified', email: profile.email }, req.ip);
      return renderLogin(
        req,
        reply,
        'Discord のメールアドレスが未確認です。Discord 側で確認を済ませてから再度お試しください。',
        403,
      );
    }

    const admin = getAdminByEmail(profile.email);
    if (!admin) {
      recordLoginAttempt(req.ip, false);
      audit('discord', 'login.denied', { reason: 'not_admin', email: profile.email }, req.ip);
      logger.warn(`login denied for ${profile.email} (not registered as an admin)`);
      return renderLogin(
        req,
        reply,
        `${profile.email} は管理者として登録されていません。既存の管理者に追加を依頼してください。`,
        403,
      );
    }

    recordLoginAttempt(req.ip, true);
    recordLogin(admin.id, {
      discordUserId: profile.id,
      username: profile.username,
      globalName: profile.globalName,
      avatarUrl: profile.avatarUrl,
    });
    const session = createSession(req.ip, String(req.headers['user-agent'] ?? ''), {
      adminId: admin.id,
      method: 'discord',
    });
    audit(admin.email, 'login.success', { method: 'discord' }, req.ip);
    logger.info(`admin logged in via discord: ${admin.email}`);
    setSessionCookie(reply, session.id);
    return reply.redirect('/', 303);
  });

  // ---- emergency password login -------------------------------------------
  app.post('/login', async (req, reply) => {
    if (!isPasswordLoginEnabled()) {
      return renderLogin(req, reply, 'パスワードログインは無効化されています。', 403);
    }
    const ip = req.ip;
    if (isLockedOut(ip)) return renderLogin(req, reply, LOCKOUT_MESSAGE, 429);

    const password = str(req.body, 'password');
    if (!password || !verifyAdminPassword(password)) {
      recordLoginAttempt(ip, false);
      audit('emergency-password', 'login.failed', {}, ip);
      return renderLogin(req, reply, 'パスワードが違います。', 401);
    }
    recordLoginAttempt(ip, true);
    const session = createSession(ip, String(req.headers['user-agent'] ?? ''), { method: 'password' });
    audit('emergency-password', 'login.success', { method: 'password' }, ip);
    logger.warn(`emergency password login from ${ip}`);
    setSessionCookie(reply, session.id);
    return reply.redirect('/', 303);
  });

  app.post('/logout', async (req, reply) => {
    destroySession(req.cookies[SESSION_COOKIE]);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return reply.redirect('/login', 303);
  });

  // ---- admin management ----------------------------------------------------
  app.get('/admins', async (req, reply) => {
    const f = flash(req);
    return sendHtml(
      reply,
      adminsPage({
        admins: listAdmins(),
        currentAdminId: req.admin?.id ?? null,
        discordEnabled: config.discordEnabled,
        passwordLoginEnabled: isPasswordLoginEnabled(),
        notice: f.notice,
        error: f.error,
      }),
    );
  });

  app.post('/admins', async (req, reply) => {
    try {
      const admin = addAdmin(str(req.body, 'email'), str(req.body, 'label'), actorOf(req));
      audit(actorOf(req), 'admin.add', { email: admin.email }, req.ip);
      return flashRedirect(reply, '/admins', {
        ok: `${admin.email} を管理者に追加しました。本人が Discord でログインできます。`,
      });
    } catch (err) {
      return flashRedirect(reply, '/admins', { err: (err as Error).message });
    }
  });

  app.post('/admins/:id/delete', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    try {
      const removed = removeAdmin(id, req.admin?.id ?? null);
      audit(actorOf(req), 'admin.remove', { email: removed.email }, req.ip);
      return flashRedirect(reply, '/admins', {
        ok: `${removed.email} を管理者から削除しました。ログイン中のセッションも無効になりました。`,
      });
    } catch (err) {
      return flashRedirect(reply, '/admins', { err: (err as Error).message });
    }
  });

  app.post('/admins/password-login', async (req, reply) => {
    const enable = str(req.body, 'enabled') === '1';
    if (!enable && !config.discordEnabled) {
      return flashRedirect(reply, '/admins', {
        err: 'Discord ログインが未設定のため、パスワードログインは無効にできません。',
      });
    }
    if (!enable && listAdmins().length === 0) {
      return flashRedirect(reply, '/admins', {
        err: '管理者が1人も登録されていないため、パスワードログインは無効にできません。',
      });
    }
    setPasswordLoginEnabled(enable);
    audit(actorOf(req), 'settings.password_login', { enabled: enable }, req.ip);
    return flashRedirect(reply, '/admins', {
      ok: enable ? 'パスワードログインを有効にしました。' : 'パスワードログインを無効にしました。',
    });
  });

  // ---- dashboard -----------------------------------------------------------
  app.get('/', async (req, reply) => {
    const f = flash(req);
    return sendHtml(
      reply,
      dashboardPage({
        queued: countJobs('queued'),
        sent: countJobs('sent'),
        failed: countJobs('failed'),
        webhookCount: listWebhooks().length,
        scheduleCount: listSchedules().length,
        upcoming: listJobs({ status: 'queued', limit: 10 }),
        recent: listJobs({ limit: 10 }),
        alertWebhook: getAlertWebhookName(),
        notice: f.notice,
      }),
    );
  });

  // ---- webhooks ------------------------------------------------------------
  app.get('/webhooks', async (req, reply) => {
    const f = flash(req);
    return sendHtml(reply, webhooksPage({ webhooks: listWebhooks(), notice: f.notice, error: f.error }));
  });

  app.post('/webhooks', async (req, reply) => {
    try {
      const wh = createWebhook({
        name: str(req.body, 'name'),
        label: str(req.body, 'label'),
        url: str(req.body, 'url'),
        default_username: str(req.body, 'default_username'),
        default_avatar_url: str(req.body, 'default_avatar_url'),
        default_thread_id: str(req.body, 'default_thread_id'),
        tags: str(req.body, 'tags'),
        note: str(req.body, 'note'),
      });
      audit(actorOf(req), 'webhook.create', { name: wh.name }, req.ip);
      return flashRedirect(reply, '/webhooks', { ok: `webhook "${wh.name}" を登録しました。` });
    } catch (err) {
      return flashRedirect(reply, '/webhooks', { err: (err as Error).message });
    }
  });

  app.get('/webhooks/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    const wh = getWebhookByName(name);
    if (!wh) return flashRedirect(reply, '/webhooks', { err: `webhook "${name}" が見つかりません。` });
    const f = flash(req);
    return sendHtml(reply, webhookEditPage({ webhook: wh, notice: f.notice, error: f.error }));
  });

  app.post('/webhooks/:name', async (req, reply) => {
    const { name } = req.params as { name: string };
    try {
      updateWebhook(name, {
        label: str(req.body, 'label'),
        url: str(req.body, 'url'),
        default_username: str(req.body, 'default_username'),
        default_avatar_url: str(req.body, 'default_avatar_url'),
        default_thread_id: str(req.body, 'default_thread_id'),
        tags: str(req.body, 'tags'),
        note: str(req.body, 'note'),
        enabled: str(req.body, 'enabled') !== '0',
      });
      audit(actorOf(req), 'webhook.update', { name }, req.ip);
      return flashRedirect(reply, `/webhooks/${encodeURIComponent(name)}`, { ok: '保存しました。' });
    } catch (err) {
      return flashRedirect(reply, `/webhooks/${encodeURIComponent(name)}`, { err: (err as Error).message });
    }
  });

  app.post('/webhooks/:name/delete', async (req, reply) => {
    const { name } = req.params as { name: string };
    deleteWebhook(name);
    audit(actorOf(req), 'webhook.delete', { name }, req.ip);
    return flashRedirect(reply, '/webhooks', { ok: `webhook "${name}" を削除しました。` });
  });

  app.post('/webhooks/:name/test', async (req, reply) => {
    const { name } = req.params as { name: string };
    const wh = getWebhookByName(name);
    if (!wh) return flashRedirect(reply, '/webhooks', { err: `webhook "${name}" が見つかりません。` });
    const result = await sendToDiscord(revealUrl(wh), {
      username: wh.default_username ?? undefined,
      avatar_url: wh.default_avatar_url ?? undefined,
      thread_id: wh.default_thread_id ?? undefined,
      allowed_mentions: { parse: [] },
      embeds: [
        {
          title: '✅ テスト送信',
          description: `Discord Webhook Manager for CMK から \`${name}\` 宛のテスト送信です。`,
          color: 0x57f287,
          timestamp: new Date().toISOString(),
        },
      ],
    });
    audit(actorOf(req), 'webhook.test', { name, ok: result.ok, status: result.status }, req.ip);
    return result.ok
      ? flashRedirect(reply, '/webhooks', { ok: `"${name}" へのテスト送信に成功しました。` })
      : flashRedirect(reply, '/webhooks', { err: `テスト送信に失敗しました: ${result.error}` });
  });

  // ---- compose -------------------------------------------------------------
  app.get('/compose', async (req, reply) => {
    const f = flash(req);
    const from = (req.query as { from?: string }).from;
    let initialPayload: Payload | null = null;
    let initialWebhook: string | null = null;
    if (from) {
      const job = getJob(from);
      if (job) {
        initialPayload = parsePayload(job);
        if (job.webhook_id !== null) initialWebhook = getWebhookById(job.webhook_id)?.name ?? null;
      }
    }
    return sendHtml(
      reply,
      composePage({
        webhooks: listWebhooks(),
        initialPayload,
        initialWebhook,
        notice: f.notice,
        error: f.error,
      }),
    );
  });

  app.post('/compose', async (req, reply) => {
    try {
      const payload = payloadFromForm(req.body);
      const targetType = str(req.body, 'target_type') || 'named';
      const when = str(req.body, 'when');
      let sendAt: string | undefined;
      if (when === 'later') {
        const wall = str(req.body, 'send_at');
        if (!wall) throw new ValidationError('送信日時を入力してください');
        sendAt = wallTimeToUtcIso(wall);
      }

      const { job } = createJob({
        webhookName: targetType === 'named' ? str(req.body, 'webhook') : undefined,
        webhookUrl: targetType === 'url' ? str(req.body, 'webhook_url') : undefined,
        payload,
        sendAt,
        source: 'ui',
      });
      audit(actorOf(req), 'message.create', { job: job.public_id, target: job.target_label }, req.ip);
      kick();
      return flashRedirect(reply, `/jobs/${job.public_id}`, {
        ok: sendAt
          ? `${formatLocal(sendAt)} の送信を予約しました。`
          : '送信キューに登録しました。数秒で反映されます。',
      });
    } catch (err) {
      logger.warn(`compose failed: ${(err as Error).message}`);
      return flashRedirect(reply, '/compose', { err: (err as Error).message });
    }
  });

  // ---- jobs ----------------------------------------------------------------
  app.get('/jobs', async (req, reply) => {
    const q = req.query as { status?: string; page?: string };
    const page = Math.max(Number(q.page ?? 0) || 0, 0);
    const f = flash(req);
    return sendHtml(
      reply,
      jobsPage({
        jobs: listJobs({ status: (q.status as JobStatus) || undefined, limit: 50, offset: page * 50 }),
        status: q.status ?? '',
        page,
        notice: f.notice,
        error: f.error,
      }),
    );
  });

  app.get('/jobs/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job) return flashRedirect(reply, '/jobs', { err: `ジョブ ${id} が見つかりません。` });
    const f = flash(req);
    return sendHtml(
      reply,
      jobDetailPage({ job, payload: parsePayload(job), notice: f.notice, error: f.error }),
    );
  });

  app.post('/jobs/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string };
    const ok = cancelJob(id);
    audit(actorOf(req), 'message.cancel', { job: id, ok }, req.ip);
    return flashRedirect(reply, `/jobs/${encodeURIComponent(id)}`, {
      ok: ok ? 'キャンセルしました。' : undefined,
      err: ok ? undefined : '待機中のジョブのみキャンセルできます。',
    });
  });

  app.post('/jobs/:id/retry', async (req, reply) => {
    const { id } = req.params as { id: string };
    const job = getJob(id);
    if (!job || job.status !== 'failed') {
      return flashRedirect(reply, `/jobs/${encodeURIComponent(id)}`, { err: '失敗したジョブのみ再送できます。' });
    }
    run(
      `UPDATE jobs SET status = 'queued', attempts = 0, next_attempt_at = ?, scheduled_at = ?,
       last_error = NULL, alerted = 0 WHERE id = ?`,
      new Date().toISOString(),
      new Date().toISOString(),
      job.id,
    );
    audit(actorOf(req), 'message.retry', { job: id }, req.ip);
    kick();
    return flashRedirect(reply, `/jobs/${encodeURIComponent(id)}`, { ok: '再送をキューに入れました。' });
  });

  // ---- schedules -----------------------------------------------------------
  app.get('/schedules', async (req, reply) => {
    const f = flash(req);
    return sendHtml(
      reply,
      schedulesPage({
        schedules: listSchedules(),
        webhooks: listWebhooks(),
        notice: f.notice,
        error: f.error,
      }),
    );
  });

  app.post('/schedules', async (req, reply) => {
    try {
      const payloadRaw = str(req.body, 'payload_json');
      const sch = createSchedule({
        name: str(req.body, 'name'),
        cron: str(req.body, 'cron'),
        webhookName: str(req.body, 'webhook'),
        payload: payloadRaw ? (JSON.parse(payloadRaw) as unknown) : {},
        enabled: str(req.body, 'enabled') !== '0',
      });
      audit(actorOf(req), 'schedule.create', { id: sch.public_id, cron: sch.cron }, req.ip);
      return flashRedirect(reply, '/schedules', {
        ok: `定期実行を登録しました。次回は ${formatLocal(sch.next_run_at)} です。`,
      });
    } catch (err) {
      return flashRedirect(reply, '/schedules', { err: (err as Error).message });
    }
  });

  app.post('/schedules/:id/toggle', async (req, reply) => {
    const { id } = req.params as { id: string };
    const current = getSchedule(id);
    if (!current) return flashRedirect(reply, '/schedules', { err: '見つかりませんでした。' });
    const updated = setScheduleEnabled(id, current.enabled !== 1);
    audit(actorOf(req), 'schedule.toggle', { id, enabled: updated?.enabled === 1 }, req.ip);
    return flashRedirect(reply, '/schedules', {
      ok: updated?.enabled === 1 ? '再開しました。' : '停止しました。',
    });
  });

  app.post('/schedules/:id/delete', async (req, reply) => {
    const { id } = req.params as { id: string };
    deleteSchedule(id);
    audit(actorOf(req), 'schedule.delete', { id }, req.ip);
    return flashRedirect(reply, '/schedules', { ok: '削除しました。' });
  });

  // ---- api keys ------------------------------------------------------------
  app.get('/apikeys', async (req, reply) => {
    const f = flash(req);
    return sendHtml(reply, apiKeysPage({ keys: listApiKeys(), notice: f.notice, error: f.error }));
  });

  app.post('/apikeys', async (req, reply) => {
    const label = str(req.body, 'label');
    if (!label) return flashRedirect(reply, '/apikeys', { err: 'ラベルを入力してください。' });
    const scopes = (str(req.body, 'scopes') || 'send').split(',').filter(Boolean) as Scope[];
    const { row, token } = createApiKey({
      label,
      scopes,
      allowRawUrl: checked(req.body, 'allow_raw_url'),
    });
    audit(actorOf(req), 'apikey.create', { id: row.id, label, scopes }, req.ip);
    // Rendered directly rather than redirected: the token is shown exactly once.
    return sendHtml(reply, apiKeysPage({ keys: listApiKeys(), freshToken: token }));
  });

  app.post('/apikeys/:id/revoke', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    revokeApiKey(id);
    audit(actorOf(req), 'apikey.revoke', { id }, req.ip);
    return flashRedirect(reply, '/apikeys', { ok: 'API キーを失効させました。' });
  });

  app.post('/apikeys/:id/delete', async (req, reply) => {
    const id = Number((req.params as { id: string }).id);
    deleteApiKey(id);
    audit(actorOf(req), 'apikey.delete', { id }, req.ip);
    return flashRedirect(reply, '/apikeys', { ok: 'API キーの記録を削除しました。' });
  });

  // ---- settings ------------------------------------------------------------
  app.get('/settings', async (req, reply) => {
    const f = flash(req);
    return sendHtml(
      reply,
      settingsPage({
        webhooks: listWebhooks(),
        alertWebhook: getAlertWebhookName(),
        audit: all<AuditEntry>('SELECT at, actor, action, detail_json, ip FROM audit_log ORDER BY id DESC LIMIT 50'),
        notice: f.notice,
        error: f.error,
      }),
    );
  });

  app.post('/settings/alert', async (req, reply) => {
    const name = str(req.body, 'alert_webhook');
    if (name && !getWebhookByName(name)) {
      return flashRedirect(reply, '/settings', { err: 'その webhook は存在しません。' });
    }
    setSetting(ALERT_SETTING_KEY, name);
    audit(actorOf(req), 'settings.alert', { name }, req.ip);
    return flashRedirect(reply, '/settings', {
      ok: name ? `失敗アラートの通知先を "${name}" にしました。` : '失敗アラートを無効にしました。',
    });
  });

  app.post('/settings/password', async (req, reply) => {
    const current = str(req.body, 'current');
    const next = str(req.body, 'next');
    const confirm = str(req.body, 'confirm');
    if (!verifyAdminPassword(current)) {
      return flashRedirect(reply, '/settings', { err: '現在のパスワードが違います。' });
    }
    if (next !== confirm) {
      return flashRedirect(reply, '/settings', { err: '新しいパスワードが一致しません。' });
    }
    try {
      setAdminPassword(next);
    } catch (err) {
      return flashRedirect(reply, '/settings', { err: (err as Error).message });
    }
    destroyAllSessions();
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    audit(actorOf(req), 'settings.password', {}, req.ip);
    return flashRedirect(reply, '/login', { err: 'パスワードを変更しました。新しいパスワードでログインしてください。' });
  });
}

/** Exposed for the settings view so it can show a friendly "now" reference. */
export const uiHelpers = { utcIsoToWallTime, getSetting };
