import type { Payload } from '../lib/validate.js';

export interface SendResult {
  ok: boolean;
  status: number;
  messageId?: string;
  error?: string;
  /** Set when Discord asked us to back off (429). */
  retryAfterMs?: number;
  /** Whether retrying the same request could plausibly succeed. */
  retryable: boolean;
}

const SEND_TIMEOUT_MS = 15_000;

/**
 * Execute a Discord webhook.
 *
 * `wait=true` makes Discord return the created message so we can record its id,
 * which is what lets a later feature edit or delete an already-sent message.
 */
export async function sendToDiscord(webhookUrl: string, payload: Payload): Promise<SendResult> {
  const { thread_id: threadId, ...body } = payload;

  let url: URL;
  try {
    url = new URL(webhookUrl);
  } catch {
    return { ok: false, status: 0, error: 'Webhook URL が不正です', retryable: false };
  }
  url.searchParams.set('wait', 'true');
  if (threadId) url.searchParams.set('thread_id', threadId);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'DiscordWebhookManagerCMK (+https://github.com/fu-sasa/discord-webhook-manager-cmk, 1.0)',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
    });
  } catch (err) {
    // Network failure / timeout — always worth another attempt.
    return {
      ok: false,
      status: 0,
      error: `送信に失敗しました (network): ${(err as Error).message}`,
      retryable: true,
    };
  }

  const text = await res.text().catch(() => '');
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = undefined;
  }

  if (res.ok) {
    const messageId =
      parsed && typeof parsed === 'object' && 'id' in parsed
        ? String((parsed as { id: unknown }).id)
        : undefined;
    return { ok: true, status: res.status, messageId, retryable: false };
  }

  if (res.status === 429) {
    const fromBody =
      parsed && typeof parsed === 'object' && 'retry_after' in parsed
        ? Number((parsed as { retry_after: unknown }).retry_after)
        : NaN;
    const fromHeader = Number(res.headers.get('retry-after'));
    const seconds = Number.isFinite(fromBody) ? fromBody : Number.isFinite(fromHeader) ? fromHeader : 5;
    return {
      ok: false,
      status: 429,
      error: 'Discord にレート制限されました',
      retryAfterMs: Math.min(Math.max(seconds * 1000, 1000), 15 * 60 * 1000),
      retryable: true,
    };
  }

  return {
    ok: false,
    status: res.status,
    error: describeError(res.status, parsed, text),
    // 5xx is transient on Discord's side; other 4xx will fail identically forever.
    retryable: res.status >= 500,
  };
}

function describeError(status: number, parsed: unknown, text: string): string {
  let detail = text.slice(0, 500);
  if (parsed && typeof parsed === 'object') {
    const o = parsed as Record<string, unknown>;
    if (typeof o['message'] === 'string') detail = o['message'];
    if (o['errors']) detail += ` ${JSON.stringify(o['errors']).slice(0, 400)}`;
  }
  const hint =
    status === 401 || status === 403
      ? '（Webhook のトークンが無効か、削除された可能性があります）'
      : status === 404
        ? '（Webhook が存在しません。削除されたか URL が誤っています）'
        : status === 400
          ? '（ペイロードが Discord に拒否されました）'
          : '';
  return `HTTP ${status}: ${detail}${hint}`;
}
