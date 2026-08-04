import { html, layout, raw } from '../lib/html.js';
import { jobTable, pageHeader, statCard } from './components.js';
import type { JobRow } from '../services/jobs.js';
import { formatLocal, tzLabel } from '../lib/time.js';

export interface DashboardData {
  queued: number;
  sent: number;
  failed: number;
  webhookCount: number;
  scheduleCount: number;
  upcoming: JobRow[];
  recent: JobRow[];
  alertWebhook?: string | undefined;
  notice?: string | null;
}

export function dashboardPage(d: DashboardData): string {
  return layout({
    title: 'ダッシュボード',
    active: 'dashboard',
    notice: d.notice ?? null,
    body: html`
      ${pageHeader(
        'ダッシュボード',
        html`<a href="/compose" class="btn btn-primary">新規送信</a>`,
      )}
      <div class="stats">
        ${statCard('待機中', d.queued, d.queued > 0 ? 'tone-info' : '')}
        ${statCard('送信済み', d.sent)}
        ${statCard('失敗', d.failed, d.failed > 0 ? 'tone-bad' : '')}
        ${statCard('登録 Webhook', d.webhookCount)}
        ${statCard('定期実行', d.scheduleCount)}
      </div>

      ${!d.alertWebhook
        ? html`<div class="flash flash-warn">
            失敗アラートの通知先が未設定です。<a href="/settings">設定</a>から通知先の named webhook
            を選ぶと、送信失敗時に Discord へ通知されます。
          </div>`
        : raw('')}

      <section>
        <h2>予定されている送信 (${tzLabel()})</h2>
        ${d.upcoming.length === 0
          ? html`<div class="empty">予約中の送信はありません。</div>`
          : html`<div class="table-wrap">
              <table>
                <thead>
                  <tr><th>ジョブID</th><th>宛先</th><th>予定日時</th><th></th></tr>
                </thead>
                <tbody>
                  ${d.upcoming.map(
                    (j) => html`<tr>
                      <td><a class="mono" href="/jobs/${j.public_id}">${j.public_id}</a></td>
                      <td>${j.target_label || '直接指定'}</td>
                      <td class="nowrap">${formatLocal(j.scheduled_at)}</td>
                      <td class="right">
                        <form method="post" action="/jobs/${j.public_id}/cancel" class="inline">
                          <button class="btn btn-sm btn-ghost">キャンセル</button>
                        </form>
                      </td>
                    </tr>`,
                  )}
                </tbody>
              </table>
            </div>`}
      </section>

      <section>
        <h2>最近の送信</h2>
        ${jobTable(d.recent)}
        <p class="right"><a href="/jobs">すべての履歴を見る →</a></p>
      </section>
    `,
  });
}
