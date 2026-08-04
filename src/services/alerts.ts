import { getSetting, run } from '../db/index.js';
import { config } from '../config.js';
import { formatLocal } from '../lib/time.js';
import { getWebhookByName, revealUrl } from './webhooks.js';
import { sendToDiscord } from './discord.js';
import type { JobRow } from './jobs.js';
import { logger } from '../lib/logger.js';

export const ALERT_SETTING_KEY = 'alert_webhook_name';

export function getAlertWebhookName(): string | undefined {
  const name = getSetting(ALERT_SETTING_KEY);
  return name && name.trim() ? name.trim() : undefined;
}

/**
 * Notify the operator that a job gave up. Sent directly (not queued) so a
 * broken queue cannot swallow its own alarm; failures here are logged only,
 * never retried, so an unreachable alert webhook can't wedge the scheduler.
 */
export async function alertJobFailure(job: JobRow): Promise<void> {
  if (job.alerted === 1) return;
  // Mark first: an alert that fails to send is better than an alert storm.
  run('UPDATE jobs SET alerted = 1 WHERE id = ?', job.id);

  const name = getAlertWebhookName();
  if (!name) return;
  const wh = getWebhookByName(name);
  if (!wh || wh.enabled !== 1) {
    logger.warn(`alert webhook "${name}" is missing or disabled — skipping alert for ${job.public_id}`);
    return;
  }

  const jobUrl = `${config.publicBaseUrl}/jobs/${job.public_id}`;
  const result = await sendToDiscord(revealUrl(wh), {
    username: 'Webhook Manager',
    allowed_mentions: { parse: [] },
    embeds: [
      {
        title: '⚠️ Webhook 送信に失敗しました',
        description: `ジョブ \`${job.public_id}\` が ${job.attempts} 回の試行後に失敗しました。`,
        color: 0xed4245,
        fields: [
          { name: '宛先', value: `${job.target_label || '直接指定'}\n\`${job.url_hint}\``, inline: false },
          { name: '予定日時', value: formatLocal(job.scheduled_at), inline: true },
          { name: 'HTTP', value: String(job.response_status ?? '-'), inline: true },
          { name: 'エラー', value: '```\n' + (job.last_error ?? '不明').slice(0, 900) + '\n```', inline: false },
          { name: '詳細', value: jobUrl, inline: false },
        ],
        timestamp: new Date().toISOString(),
      },
    ],
  });

  if (!result.ok) {
    logger.error(`failed to deliver failure alert for ${job.public_id}: ${result.error}`);
  }
}
