import { html, layout, raw } from '../lib/html.js';
import { emptyState, pageHeader } from './components.js';
import { displayName, type AdminRow } from '../services/admins.js';
import { formatLocal, tzLabel } from '../lib/time.js';

export interface AdminsPageOptions {
  admins: AdminRow[];
  /** id of the admin viewing the page; null for an emergency-password session. */
  currentAdminId: number | null;
  discordEnabled: boolean;
  passwordLoginEnabled: boolean;
  notice?: string | null;
  error?: string | null;
}

export function adminsPage(opts: AdminsPageOptions): string {
  const { admins, currentAdminId, discordEnabled, passwordLoginEnabled } = opts;
  return layout({
    title: '管理者',
    active: 'admins',
    notice: opts.notice ?? null,
    error: opts.error ?? null,
    body: html`
      ${pageHeader('管理者')}
      <p class="muted">
        ここに登録されたメールアドレスの Discord アカウントだけがログインできます。
        照合には Discord 側で<strong>確認済み</strong>のメールアドレスが使われます。
      </p>

      ${!discordEnabled
        ? html`<div class="flash flash-warn">
            Discord ログインが未設定のため、ここに追加してもまだログインできません。サーバーで
            <code>deploy/set-discord-auth.sh</code> を実行してください。
          </div>`
        : raw('')}

      ${admins.length === 0
        ? emptyState('管理者が登録されていません。下のフォームから追加してください。')
        : html`<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th></th><th>メールアドレス</th><th>Discord</th><th>メモ</th>
                  <th>追加者</th><th>最終ログイン (${tzLabel()})</th><th></th>
                </tr>
              </thead>
              <tbody>
                ${admins.map(
                  (a) => html`<tr>
                    <td>
                      ${a.avatar_url
                        ? html`<img class="avatar" src="${a.avatar_url}" alt="" width="28" height="28" />`
                        : html`<span class="avatar avatar-blank"></span>`}
                    </td>
                    <td class="mono strong">
                      ${a.email}
                      ${a.id === currentAdminId ? html`<span class="tag">あなた</span>` : raw('')}
                    </td>
                    <td>
                      ${a.discord_user_id
                        ? html`${displayName(a)}<div class="hint mono">${a.discord_user_id}</div>`
                        : html`<span class="hint">未ログイン</span>`}
                    </td>
                    <td>${a.label || '-'}</td>
                    <td class="hint">${a.added_by}</td>
                    <td class="nowrap hint">${formatLocal(a.last_login_at)}</td>
                    <td class="right nowrap">
                      ${a.id === currentAdminId
                        ? html`<span class="hint">—</span>`
                        : html`<form method="post" action="/admins/${a.id}/delete" class="inline"
                            onsubmit="return confirm('${a.email} の管理者権限を削除します。この操作でログイン中のセッションも即座に無効になります。よろしいですか？')">
                            <button class="btn btn-sm btn-danger">削除</button>
                          </form>`}
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`}

      <section class="card">
        <h2>管理者を追加</h2>
        <form method="post" action="/admins" class="form-grid">
          <label>
            メールアドレス <span class="req">必須</span>
            <input name="email" type="email" required maxlength="200" placeholder="someone@example.com" />
            <small>
              その人の <strong>Discord アカウントに登録されているメールアドレス</strong>を入力してください。
              別のアドレスだとログインできません。
            </small>
          </label>
          <label>
            メモ
            <input name="label" maxlength="120" placeholder="準備会 広報担当" />
          </label>
          <div class="span2 right">
            <button type="submit" class="btn btn-primary">追加する</button>
          </div>
        </form>
      </section>

      <section class="card ${passwordLoginEnabled ? 'danger' : ''}">
        <h2>緊急用パスワードログイン</h2>
        <p class="muted">
          Discord ログインが使えないときの予備手段です。現在は
          ${passwordLoginEnabled
            ? html`<strong>有効</strong>（ログイン画面に「緊急用パスワードでログイン」が表示されます）`
            : html`<strong>無効</strong>（Discord ログインのみ）`}。
        </p>
        ${passwordLoginEnabled
          ? html`<p class="hint">
                Discord ログインが正常に動くことを確認できたら、無効にすることをおすすめします。
                無効化後にログインできなくなった場合は、サーバーで
                <code>sqlite3 /var/lib/dwm/dwm.db "UPDATE settings SET value='1' WHERE key='password_login_enabled'"</code>
                を実行すれば戻せます。
              </p>
              <form method="post" action="/admins/password-login" class="inline">
                <input type="hidden" name="enabled" value="0" />
                <button class="btn btn-danger">パスワードログインを無効にする</button>
              </form>`
          : html`<form method="post" action="/admins/password-login" class="inline">
              <input type="hidden" name="enabled" value="1" />
              <button class="btn">パスワードログインを有効にする</button>
            </form>`}
      </section>
    `,
  });
}
