import { currentUser } from './request-context.js';

/**
 * Tiny escaping-by-default template helper. Interpolated values are HTML-escaped
 * unless explicitly wrapped in `raw()`, so forgetting to escape is not possible
 * by accident.
 */
export class Raw {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function raw(value: string): Raw {
  return new Raw(value);
}

export function esc(value: unknown): string {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function render(value: unknown): string {
  if (value === null || value === undefined || value === false) return '';
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return esc(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): Raw {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) out += render(values[i]) + (strings[i + 1] ?? '');
  return new Raw(out);
}

/** Safe JSON for embedding in a <script> block. */
export function jsonScript(value: unknown): Raw {
  return raw(JSON.stringify(value ?? null).replaceAll('<', '\\u003c').replaceAll('\u2028', '\\u2028'));
}

export type NavKey =
  | 'dashboard'
  | 'compose'
  | 'webhooks'
  | 'jobs'
  | 'schedules'
  | 'apikeys'
  | 'admins'
  | 'settings'
  | 'none';

const NAV: { key: NavKey; href: string; label: string }[] = [
  { key: 'dashboard', href: '/', label: 'ダッシュボード' },
  { key: 'compose', href: '/compose', label: '送信' },
  { key: 'webhooks', href: '/webhooks', label: 'Webhook' },
  { key: 'jobs', href: '/jobs', label: '送信履歴' },
  { key: 'schedules', href: '/schedules', label: '定期実行' },
  { key: 'apikeys', href: '/apikeys', label: 'APIキー' },
  { key: 'admins', href: '/admins', label: '管理者' },
  { key: 'settings', href: '/settings', label: '設定' },
];

export interface CurrentUser {
  name: string;
  avatarUrl?: string | null;
  /** Shown when the session came from the emergency password rather than Discord. */
  emergency?: boolean;
}

export interface LayoutOptions {
  title: string;
  active?: NavKey;
  body: Raw;
  /** Flash messages rendered above the page body. */
  notice?: string | null;
  error?: string | null;
  scripts?: string[];
  chrome?: boolean;
  user?: CurrentUser | null;
}

export function layout(opts: LayoutOptions): string {
  const { title, active = 'none', body, notice, error, scripts = [], chrome = true } = opts;
  // Pages don't thread the identity through; it comes from the request context.
  const user = opts.user !== undefined ? opts.user : currentUser();
  const nav = chrome
    ? html`<nav class="nav">
        <a class="brand" href="/">Discord Webhook Manager <span>for CMK</span></a>
        <div class="nav-links">
          ${NAV.map(
            (item) =>
              html`<a href="${item.href}" class="${item.key === active ? 'active' : ''}"
                >${item.label}</a
              >`,
          )}
        </div>
        ${user
          ? html`<div class="nav-user" title="${user.emergency ? '緊急用パスワードでログイン中' : user.name}">
              ${user.avatarUrl
                ? html`<img class="avatar" src="${user.avatarUrl}" alt="" width="26" height="26" />`
                : html`<span class="avatar avatar-blank"></span>`}
              <span class="nav-user-name">${user.name}</span>
              ${user.emergency ? html`<span class="tag tag-warn">緊急</span>` : raw('')}
            </div>`
          : raw('')}
        <form method="post" action="/logout" class="nav-logout">
          <button type="submit" class="btn btn-ghost">ログアウト</button>
        </form>
      </nav>`
    : raw('');

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(title)} | Discord Webhook Manager for CMK</title>
<link rel="stylesheet" href="/static/app.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><text y='26' font-size='26'>📮</text></svg>">
</head>
<body class="${chrome ? '' : 'bare'}">
${nav}
<main class="container">
${notice ? html`<div class="flash flash-ok">${notice}</div>` : ''}
${error ? html`<div class="flash flash-err">${error}</div>` : ''}
${body}
</main>
${scripts.map((s) => `<script src="${esc(s)}" defer></script>`).join('\n')}
</body>
</html>`;
}
