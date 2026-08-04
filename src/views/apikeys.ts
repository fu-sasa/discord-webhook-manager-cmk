import { html, layout, raw } from '../lib/html.js';
import { emptyState, pageHeader } from './components.js';
import type { ApiKeyRow } from '../services/apikeys.js';
import { formatLocal } from '../lib/time.js';
import { config } from '../config.js';

export function apiKeysPage(opts: {
  keys: ApiKeyRow[];
  /** Shown exactly once, right after creation. */
  freshToken?: string | null;
  notice?: string | null;
  error?: string | null;
}): string {
  return layout({
    title: 'APIキー',
    active: 'apikeys',
    notice: opts.notice ?? null,
    error: opts.error ?? null,
    body: html`
      ${pageHeader('API キー')}

      ${opts.freshToken
        ? html`<div class="card token-card">
            <h2>API キーを発行しました</h2>
            <p class="strong">
              この値が表示されるのはこの一度きりです。今すぐ控えてください。
            </p>
            <pre class="code token">${opts.freshToken}</pre>
            <p class="hint">使用例:</p>
            <pre class="code">curl -X POST ${config.publicBaseUrl}/api/v1/messages \\
  -H "Authorization: Bearer ${opts.freshToken}" \\
  -H "Content-Type: application/json" \\
  -d '{"webhook":"cmk-announce","payload":{"content":"テスト送信"}}'</pre>
          </div>`
        : raw('')}

      ${opts.keys.length === 0
        ? emptyState('発行済みの API キーはありません。')
        : html`<div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>ラベル</th><th>プレフィックス</th><th>スコープ</th>
                  <th>URL直接指定</th><th>最終利用</th><th>作成</th><th>状態</th><th></th>
                </tr>
              </thead>
              <tbody>
                ${opts.keys.map(
                  (k) => html`<tr class="${k.disabled_at ? 'row-disabled' : ''}">
                    <td class="strong">${k.label}</td>
                    <td class="mono">${k.prefix}…</td>
                    <td>${k.scopes.split(',').map((s) => html`<span class="tag">${s}</span>`)}</td>
                    <td>${k.allow_raw_url === 1 ? '許可' : '不可'}</td>
                    <td class="nowrap hint">${formatLocal(k.last_used_at)}</td>
                    <td class="nowrap hint">${formatLocal(k.created_at)}</td>
                    <td>
                      ${k.disabled_at
                        ? html`<span class="badge badge-canceled">失効</span>`
                        : html`<span class="badge badge-sent">有効</span>`}
                    </td>
                    <td class="right nowrap">
                      ${k.disabled_at
                        ? html`<form method="post" action="/apikeys/${k.id}/delete" class="inline"
                            onsubmit="return confirm('この記録を完全に削除します。よろしいですか？')">
                            <button class="btn btn-sm btn-danger">削除</button>
                          </form>`
                        : html`<form method="post" action="/apikeys/${k.id}/revoke" class="inline"
                            onsubmit="return confirm('${k.label} を失効させます。このキーを使う連携は停止します。')">
                            <button class="btn btn-sm btn-danger">失効させる</button>
                          </form>`}
                    </td>
                  </tr>`,
                )}
              </tbody>
            </table>
          </div>`}

      <section class="card">
        <h2>新規発行</h2>
        <form method="post" action="/apikeys" class="form-grid">
          <label>
            ラベル <span class="req">必須</span>
            <input name="label" required maxlength="120" placeholder="サイト連携bot" />
            <small>どのシステムに渡したキーか分かる名前を付けてください。</small>
          </label>
          <label>
            スコープ
            <select name="scopes">
              <option value="send">send（送信のみ）</option>
              <option value="send,manage">send + manage（webhook / 定期実行の登録も可能）</option>
            </select>
          </label>
          <div class="span2">
            <label class="check">
              <input type="checkbox" name="allow_raw_url" checked />
              <span>Webhook URL の直接指定を許可する（オフにすると named webhook 宛のみ送信可）</span>
            </label>
          </div>
          <div class="span2 right">
            <button type="submit" class="btn btn-primary">発行する</button>
          </div>
        </form>
      </section>
    `,
  });
}
