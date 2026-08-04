import { html, layout, raw } from '../lib/html.js';
import { jobTable, pageHeader, statusBadge } from './components.js';
import { STATUS_LABEL, type JobRow, type JobStatus } from '../services/jobs.js';
import { formatLocal, tzLabel } from '../lib/time.js';
import type { Payload } from '../lib/validate.js';

const STATUSES: JobStatus[] = ['queued', 'sending', 'sent', 'failed', 'canceled'];

export function jobsPage(opts: {
  jobs: JobRow[];
  status?: string;
  page: number;
  notice?: string | null;
  error?: string | null;
}): string {
  const { jobs, status = '', page } = opts;
  return layout({
    title: '送信履歴',
    active: 'jobs',
    notice: opts.notice ?? null,
    error: opts.error ?? null,
    body: html`
      ${pageHeader('送信履歴')}
      <form method="get" action="/jobs" class="filter-bar">
        <label>
          状態
          <select name="status" onchange="this.form.submit()">
            <option value="">すべて</option>
            ${STATUSES.map(
              (s) => html`<option value="${s}" ${status === s ? raw('selected') : raw('')}>${STATUS_LABEL[s]}</option>`,
            )}
          </select>
        </label>
        <noscript><button class="btn btn-sm">絞り込む</button></noscript>
      </form>

      ${jobTable(jobs)}

      <div class="pager">
        ${page > 0
          ? html`<a class="btn btn-sm" href="/jobs?status=${status}&page=${page - 1}">← 前へ</a>`
          : raw('')}
        ${jobs.length >= 50
          ? html`<a class="btn btn-sm" href="/jobs?status=${status}&page=${page + 1}">次へ →</a>`
          : raw('')}
      </div>
    `,
  });
}

export function jobDetailPage(opts: {
  job: JobRow;
  payload: Payload;
  notice?: string | null;
  error?: string | null;
}): string {
  const j = opts.job;
  return layout({
    title: `ジョブ ${j.public_id}`,
    active: 'jobs',
    notice: opts.notice ?? null,
    error: opts.error ?? null,
    body: html`
      ${pageHeader(
        html`ジョブ <span class="mono">${j.public_id}</span>`,
        html`<a class="btn btn-ghost" href="/jobs">履歴へ戻る</a>`,
      )}

      <section class="card">
        <dl class="kv">
          <dt>状態</dt><dd>${statusBadge(j.status)}</dd>
          <dt>宛先</dt><dd>${j.target_label || '直接指定'} <span class="mono hint">${j.url_hint}</span></dd>
          <dt>予定日時 (${tzLabel()})</dt><dd>${formatLocal(j.scheduled_at)}</dd>
          <dt>送信日時 (${tzLabel()})</dt><dd>${formatLocal(j.sent_at)}</dd>
          <dt>試行回数</dt><dd>${j.attempts}</dd>
          ${j.next_attempt_at && j.status === 'queued'
            ? html`<dt>次回試行</dt><dd>${formatLocal(j.next_attempt_at)}</dd>`
            : raw('')}
          <dt>HTTP</dt><dd>${j.response_status ?? '-'}</dd>
          <dt>Discord メッセージID</dt><dd class="mono">${j.discord_message_id ?? '-'}</dd>
          <dt>冪等キー</dt><dd class="mono">${j.idempotency_key ?? '-'}</dd>
          <dt>実行元</dt><dd class="mono">${j.source}</dd>
          <dt>作成日時 (${tzLabel()})</dt><dd>${formatLocal(j.created_at)}</dd>
        </dl>
        ${j.last_error ? html`<div class="flash flash-err mono wrap">${j.last_error}</div>` : raw('')}

        <div class="actions">
          ${j.status === 'queued'
            ? html`<form method="post" action="/jobs/${j.public_id}/cancel" class="inline">
                <button class="btn btn-danger">キャンセル</button>
              </form>`
            : raw('')}
          ${j.status === 'failed'
            ? html`<form method="post" action="/jobs/${j.public_id}/retry" class="inline">
                <button class="btn">今すぐ再送する</button>
              </form>`
            : raw('')}
          <a class="btn" href="/compose?from=${j.public_id}">この内容で新規作成</a>
        </div>
      </section>

      <section class="card">
        <h2>ペイロード</h2>
        <pre class="code">${JSON.stringify(opts.payload, null, 2)}</pre>
      </section>
    `,
  });
}
