import { html, layout } from '../lib/html.js';

export function loginPage(error?: string | null): string {
  return layout({
    title: 'ログイン',
    chrome: false,
    body: html`<div class="login-wrap">
      <form method="post" action="/login" class="card login-card">
        <h1>Discord Webhook Manager<span>for CMK</span></h1>
        <p class="muted">管理パスワードを入力してください。</p>
        ${error ? html`<div class="flash flash-err">${error}</div>` : ''}
        <label>
          パスワード
          <input type="password" name="password" autocomplete="current-password" required autofocus />
        </label>
        <button type="submit" class="btn btn-primary btn-block">ログイン</button>
      </form>
    </div>`,
  });
}
