import { html, layout, raw } from '../lib/html.js';
import { emptyState, pageHeader } from './components.js';
import type { ScheduleRow } from '../services/schedules.js';
import type { NamedWebhookRow } from '../services/webhooks.js';
import { formatLocal, tzLabel } from '../lib/time.js';

export function schedulesPage(opts: {
  schedules: ScheduleRow[];
  webhooks: NamedWebhookRow[];
  notice?: string | null;
  error?: string | null;
}): string {
  const enabled = opts.webhooks.filter((w) => w.enabled === 1);
  return layout({
    title: '定期実行',
    active: 'schedules',
    notice: opts.notice ?? null,
    error: opts.error ?? null,
    body: html`
      ${pageHeader('定期実行 (cron)')}
      <p class="muted">
        cron 式で繰り返し送信を登録します。時刻は ${tzLabel()} で解釈されます。<br />
        例: <code>0 9 * * 1</code> 毎週月曜 9:00 ／ <code>30 8 1 * *</code> 毎月1日 8:30 ／
        <code>*/30 * * * *</code> 30分ごと
      </p>

      ${opts.schedules.length === 0
        ? emptyState('登録されている定期実行はありません。')
        : html`<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>名前</th><th>cron</th><th>宛先</th>
                  <th>次回 (${tzLabel()})</th><th>前回</th><th>状態</th><th></th>
                </tr>
              </thead>
              <tbody>
                ${opts.schedules.map(
                  (s) => html`<tr>
                    <td class="strong">${s.name}</td>
                    <td class="mono">${s.cron}</td>
                    <td class="mono hint">${s.url_hint}</td>
                    <td class="nowrap">${formatLocal(s.next_run_at)}</td>
                    <td class="nowrap hint">${formatLocal(s.last_run_at)}</td>
                    <td>
                      ${s.enabled === 1
                        ? html`<span class="badge badge-sent">有効</span>`
                        : html`<span class="badge badge-canceled">停止中</span>`}
                    </td>
                    <td class="right nowrap">
                      <form method="post" action="/schedules/${s.public_id}/toggle" class="inline">
                        <button class="btn btn-sm">${s.enabled === 1 ? '停止' : '再開'}</button>
                      </form>
                      <form method="post" action="/schedules/${s.public_id}/delete" class="inline"
                        onsubmit="return confirm('この定期実行を削除します。よろしいですか？')">
                        <button class="btn btn-sm btn-danger">削除</button>
                      </form>
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`}

      <section class="card">
        <h2>新規登録</h2>
        ${enabled.length === 0
          ? html`<div class="flash flash-warn">
              先に <a href="/webhooks">named webhook</a> を登録してください。
            </div>`
          : html`<form method="post" action="/schedules" class="form-grid">
              <label>
                名前 <span class="req">必須</span>
                <input name="name" required maxlength="120" placeholder="週次リマインド" />
              </label>
              <label>
                cron 式 <span class="req">必須</span>
                <input name="cron" required maxlength="120" placeholder="0 9 * * 1" />
                <small>分 時 日 月 曜日（${tzLabel()} 基準）</small>
              </label>
              <label>
                宛先 webhook <span class="req">必須</span>
                <select name="webhook" required>
                  ${enabled.map((w) => html`<option value="${w.name}">${w.name}${w.label ? ` — ${w.label}` : ''}</option>`)}
                </select>
              </label>
              <label>
                状態
                <select name="enabled">
                  <option value="1">有効</option>
                  <option value="0">停止中で登録</option>
                </select>
              </label>
              <label class="span2">
                payload JSON <span class="req">必須</span>
                <textarea name="payload_json" rows="10" required spellcheck="false"
                  placeholder='{"content":"定例のお知らせです","embeds":[{"title":"今週の予定","description":"…","color":"#5865F2"}]}'></textarea>
                <small>
                  <a href="/compose">送信画面</a>の「JSON を直接編集」で内容を組み立ててから貼り付けると簡単です。
                </small>
              </label>
              <div class="span2 right">
                <button type="submit" class="btn btn-primary">登録する</button>
              </div>
            </form>`}
      </section>
      ${raw('')}
    `,
  });
}
