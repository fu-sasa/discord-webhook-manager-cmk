import { html, layout, raw } from '../lib/html.js';
import { pageHeader } from './components.js';
import type { NamedWebhookRow } from '../services/webhooks.js';
import { config } from '../config.js';
import { formatLocal, tzLabel } from '../lib/time.js';

export interface AuditEntry {
  at: string;
  actor: string;
  action: string;
  detail_json: string;
  ip: string;
}

export function settingsPage(opts: {
  webhooks: NamedWebhookRow[];
  alertWebhook?: string | undefined;
  audit: AuditEntry[];
  notice?: string | null;
  error?: string | null;
}): string {
  return layout({
    title: '設定',
    active: 'settings',
    notice: opts.notice ?? null,
    error: opts.error ?? null,
    body: html`
      ${pageHeader('設定')}

      <section class="card">
        <h2>失敗アラートの通知先</h2>
        <p class="muted">
          リトライを使い切ったジョブが出たときに、ここで選んだ named webhook へ通知します。
          運用チーム用の低頻度チャンネルを指定してください。
        </p>
        <form method="post" action="/settings/alert" class="form-inline">
          <select name="alert_webhook">
            <option value="">（通知しない）</option>
            ${opts.webhooks.map(
              (w) => html`<option value="${w.name}" ${opts.alertWebhook === w.name ? raw('selected') : raw('')}>
                ${w.name}${w.label ? ` — ${w.label}` : ''}
              </option>`,
            )}
          </select>
          <button class="btn btn-primary">保存</button>
        </form>
      </section>

      <section class="card">
        <h2>管理パスワードの変更</h2>
        <form method="post" action="/settings/password" class="form-grid">
          <label>
            現在のパスワード
            <input type="password" name="current" required autocomplete="current-password" />
          </label>
          <label>
            新しいパスワード（12文字以上）
            <input type="password" name="next" required minlength="12" autocomplete="new-password" />
          </label>
          <label>
            新しいパスワード（確認）
            <input type="password" name="confirm" required minlength="12" autocomplete="new-password" />
          </label>
          <div class="span2 right">
            <button class="btn btn-primary">変更する</button>
          </div>
          <p class="span2 hint">変更すると、開いている全てのセッションがログアウトされます。</p>
        </form>
      </section>

      <section class="card">
        <h2>稼働情報</h2>
        <dl class="kv">
          <dt>公開 URL</dt><dd class="mono">${config.publicBaseUrl}</dd>
          <dt>待ち受け</dt><dd class="mono">${config.host}:${config.port}</dd>
          <dt>タイムゾーン</dt><dd>${config.displayTimezone} (${tzLabel()})</dd>
          <dt>スケジューラ間隔</dt><dd>${config.schedulerTickMs} ms</dd>
          <dt>最大試行回数</dt><dd>${config.maxAttempts}</dd>
          <dt>misfire 猶予</dt><dd>${Math.round(config.misfireGraceSeconds / 3600)} 時間</dd>
          <dt>データベース</dt><dd class="mono">${config.databasePath}</dd>
        </dl>
        <p class="hint">これらは <code>.env</code> で変更し、サービス再起動で反映されます。</p>
      </section>

      <section class="card">
        <h2>操作ログ（直近50件）</h2>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>日時 (${tzLabel()})</th><th>実行者</th><th>操作</th><th>詳細</th><th>IP</th></tr>
            </thead>
            <tbody>
              ${opts.audit.map(
                (a) => html`<tr>
                  <td class="nowrap hint">${formatLocal(a.at)}</td>
                  <td>${a.actor}</td>
                  <td class="mono">${a.action}</td>
                  <td class="mono hint wrap">${a.detail_json}</td>
                  <td class="mono hint">${a.ip}</td>
                </tr>`,
              )}
            </tbody>
          </table>
        </div>
      </section>
    `,
  });
}
