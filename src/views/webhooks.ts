import { html, layout, raw } from '../lib/html.js';
import { emptyState, pageHeader } from './components.js';
import type { NamedWebhookRow } from '../services/webhooks.js';
import { formatLocal } from '../lib/time.js';

export function webhooksPage(opts: {
  webhooks: NamedWebhookRow[];
  notice?: string | null;
  error?: string | null;
}): string {
  const { webhooks } = opts;
  return layout({
    title: 'Webhook',
    active: 'webhooks',
    notice: opts.notice ?? null,
    error: opts.error ?? null,
    body: html`
      ${pageHeader('named webhook')}
      <p class="muted">
        よく使う Discord Webhook に名前を付けて登録します。登録後は送信時に
        <code>webhook: "name"</code> と指定するだけで送れます。URL は暗号化して保存され、画面や API
        には二度と表示されません。
      </p>

      ${webhooks.length === 0
        ? emptyState('まだ登録がありません。下のフォームから追加してください。')
        : html`<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>name</th><th>表示名</th><th>URL</th><th>タグ</th>
                  <th>状態</th><th>更新</th><th></th>
                </tr>
              </thead>
              <tbody>
                ${webhooks.map(
                  (w) => html`<tr>
                    <td class="mono strong">${w.name}</td>
                    <td>${w.label || '-'}</td>
                    <td class="mono hint">${w.url_hint}</td>
                    <td>${w.tags ? w.tags.split(',').map((t) => html`<span class="tag">${t}</span>`) : '-'}</td>
                    <td>
                      ${w.enabled === 1
                        ? html`<span class="badge badge-sent">有効</span>`
                        : html`<span class="badge badge-canceled">無効</span>`}
                    </td>
                    <td class="nowrap hint">${formatLocal(w.updated_at)}</td>
                    <td class="right nowrap">
                      <form method="post" action="/webhooks/${w.name}/test" class="inline">
                        <button class="btn btn-sm">テスト送信</button>
                      </form>
                      <a class="btn btn-sm" href="/webhooks/${w.name}">編集</a>
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`}

      <section class="card">
        <h2>新規登録</h2>
        <form method="post" action="/webhooks" class="form-grid">
          <label>
            name <span class="req">必須</span>
            <input name="name" required pattern="[a-z0-9][a-z0-9_-]*" maxlength="64"
              placeholder="cmk-announce" />
            <small>英小文字・数字・ハイフン・アンダースコア。API から指定する識別子です。</small>
          </label>
          <label>
            表示名
            <input name="label" maxlength="120" placeholder="コミケ準備会 お知らせチャンネル" />
          </label>
          <label class="span2">
            Webhook URL <span class="req">必須</span>
            <input name="url" required type="url" placeholder="https://discord.com/api/webhooks/…" />
            <small>Discord のチャンネル設定 → 連携サービス → ウェブフック から取得できます。</small>
          </label>
          <label>
            既定の表示名 (username)
            <input name="default_username" maxlength="80" placeholder="準備会bot" />
          </label>
          <label>
            既定のアイコン URL
            <input name="default_avatar_url" type="url" placeholder="https://…/icon.png" />
          </label>
          <label>
            既定のスレッドID
            <input name="default_thread_id" pattern="\\d*" placeholder="（フォーラム/スレッド投稿時のみ）" />
          </label>
          <label>
            タグ
            <input name="tags" maxlength="200" placeholder="announce, staff" />
          </label>
          <label class="span2">
            メモ
            <textarea name="note" rows="2" maxlength="2000" placeholder="用途や連絡先など"></textarea>
          </label>
          <div class="span2 right">
            <button type="submit" class="btn btn-primary">登録する</button>
          </div>
        </form>
      </section>
    `,
  });
}

export function webhookEditPage(opts: {
  webhook: NamedWebhookRow;
  notice?: string | null;
  error?: string | null;
}): string {
  const w = opts.webhook;
  return layout({
    title: `Webhook: ${w.name}`,
    active: 'webhooks',
    notice: opts.notice ?? null,
    error: opts.error ?? null,
    body: html`
      ${pageHeader(`webhook: ${w.name}`, html`<a href="/webhooks" class="btn btn-ghost">一覧へ戻る</a>`)}
      <section class="card">
        <form method="post" action="/webhooks/${w.name}" class="form-grid">
          <label>
            表示名
            <input name="label" maxlength="120" value="${w.label}" />
          </label>
          <label>
            状態
            <select name="enabled">
              <option value="1" ${w.enabled === 1 ? raw('selected') : raw('')}>有効</option>
              <option value="0" ${w.enabled === 0 ? raw('selected') : raw('')}>無効（送信不可）</option>
            </select>
          </label>
          <label class="span2">
            Webhook URL の差し替え
            <input name="url" type="url" placeholder="変更しない場合は空欄のまま" />
            <small>現在: <code>${w.url_hint}</code>（保存済み URL は表示できません）</small>
          </label>
          <label>
            既定の表示名
            <input name="default_username" maxlength="80" value="${w.default_username ?? ''}" />
          </label>
          <label>
            既定のアイコン URL
            <input name="default_avatar_url" type="url" value="${w.default_avatar_url ?? ''}" />
          </label>
          <label>
            既定のスレッドID
            <input name="default_thread_id" value="${w.default_thread_id ?? ''}" />
          </label>
          <label>
            タグ
            <input name="tags" maxlength="200" value="${w.tags}" />
          </label>
          <label class="span2">
            メモ
            <textarea name="note" rows="3" maxlength="2000">${w.note}</textarea>
          </label>
          <div class="span2 right">
            <button type="submit" class="btn btn-primary">保存</button>
          </div>
        </form>
      </section>

      <section class="card danger">
        <h2>削除</h2>
        <p class="muted">
          削除すると、この webhook を宛先にしている予約ジョブと定期実行も送信できなくなります。
        </p>
        <form method="post" action="/webhooks/${w.name}/delete"
          onsubmit="return confirm('${w.name} を削除します。よろしいですか？')">
          <button class="btn btn-danger">この webhook を削除する</button>
        </form>
      </section>
    `,
  });
}
