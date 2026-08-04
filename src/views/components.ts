import { html, raw, type Raw } from '../lib/html.js';
import { STATUS_LABEL, type JobRow, type JobStatus } from '../services/jobs.js';
import { formatLocal, tzLabel } from '../lib/time.js';

export function statusBadge(status: JobStatus): Raw {
  return html`<span class="badge badge-${status}">${STATUS_LABEL[status]}</span>`;
}

export function pageHeader(title: string | Raw, actions?: Raw): Raw {
  return html`<div class="page-head">
    <h1>${title}</h1>
    ${actions ?? raw('')}
  </div>`;
}

export function emptyState(message: string): Raw {
  return html`<div class="empty">${message}</div>`;
}

export function jobRow(job: JobRow): Raw {
  return html`<tr>
    <td><a href="/jobs/${job.public_id}" class="mono">${job.public_id}</a></td>
    <td>${statusBadge(job.status)}</td>
    <td>${job.target_label || '直接指定'}<div class="hint mono">${job.url_hint}</div></td>
    <td class="nowrap">${formatLocal(job.scheduled_at)}</td>
    <td class="nowrap">${formatLocal(job.sent_at)}</td>
    <td class="nowrap">${job.attempts}</td>
    <td class="src">${job.source}</td>
  </tr>`;
}

export function jobTable(jobs: JobRow[]): Raw {
  if (jobs.length === 0) return emptyState('該当する送信はありません。');
  return html`<div class="table-wrap">
    <table>
      <thead>
        <tr>
          <th>ジョブID</th>
          <th>状態</th>
          <th>宛先</th>
          <th>予定 (${tzLabel()})</th>
          <th>送信 (${tzLabel()})</th>
          <th>試行</th>
          <th>実行元</th>
        </tr>
      </thead>
      <tbody>
        ${jobs.map(jobRow)}
      </tbody>
    </table>
  </div>`;
}

export function statCard(label: string, value: string | number, tone = ''): Raw {
  return html`<div class="stat ${tone}">
    <div class="stat-value">${value}</div>
    <div class="stat-label">${label}</div>
  </div>`;
}
