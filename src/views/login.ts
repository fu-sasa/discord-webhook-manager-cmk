import { html, layout, raw } from '../lib/html.js';

export interface LoginPageOptions {
  error?: string | null;
  notice?: string | null;
  discordEnabled: boolean;
  passwordEnabled: boolean;
}

const DISCORD_MARK = raw(
  `<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor">
     <path d="M20.32 4.57A19.8 19.8 0 0 0 15.43 3c-.21.38-.46.9-.63 1.31a18.3 18.3 0 0 0-5.6 0C9.03 3.9 8.77 3.38 8.56 3a19.7 19.7 0 0 0-4.9 1.57C.56 9.2-.28 13.7.14 18.14a19.9 19.9 0 0 0 6.05 3.08c.49-.67.92-1.38 1.3-2.13-.72-.27-1.4-.6-2.05-.99.17-.13.34-.26.5-.4a14.2 14.2 0 0 0 12.12 0c.17.14.34.27.5.4-.65.39-1.34.72-2.05 1 .37.74.8 1.45 1.29 2.12a19.9 19.9 0 0 0 6.06-3.08c.5-5.15-.85-9.6-3.54-13.57ZM8.02 15.44c-1.18 0-2.15-1.09-2.15-2.42 0-1.34.95-2.43 2.15-2.43s2.17 1.1 2.15 2.43c0 1.33-.95 2.42-2.15 2.42Zm7.96 0c-1.18 0-2.15-1.09-2.15-2.42 0-1.34.95-2.43 2.15-2.43s2.17 1.1 2.15 2.43c0 1.33-.94 2.42-2.15 2.42Z"/>
   </svg>`,
);

export function loginPage(opts: LoginPageOptions): string {
  const { error, notice, discordEnabled, passwordEnabled } = opts;
  return layout({
    title: 'ログイン',
    chrome: false,
    body: html`<div class="login-wrap">
      <div class="card login-card">
        <h1>Discord Webhook Manager<span>for CMK</span></h1>

        ${notice ? html`<div class="flash flash-ok">${notice}</div>` : ''}
        ${error ? html`<div class="flash flash-err">${error}</div>` : ''}

        ${discordEnabled
          ? html`<p class="muted">管理者として登録された Discord アカウントでログインしてください。</p>
              <a href="/auth/discord" class="btn btn-discord btn-block">
                ${DISCORD_MARK}
                <span>Discord でログイン</span>
              </a>`
          : html`<div class="flash flash-warn">
              Discord ログインが未設定です。サーバーで
              <code>deploy/set-discord-auth.sh</code> を実行して設定してください。
            </div>`}

        ${passwordEnabled
          ? html`<details class="emergency">
              <summary>緊急用パスワードでログイン</summary>
              <p class="hint">
                Discord ログインが使えないときのための予備手段です。通常は上のボタンを使ってください。
              </p>
              <form method="post" action="/login">
                <label>
                  管理パスワード
                  <input type="password" name="password" autocomplete="current-password" required />
                </label>
                <button type="submit" class="btn btn-block">ログイン</button>
              </form>
            </details>`
          : raw('')}
      </div>
    </div>`,
  });
}
