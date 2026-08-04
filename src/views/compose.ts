import { html, jsonScript, layout, raw } from '../lib/html.js';
import { pageHeader } from './components.js';
import type { NamedWebhookRow } from '../services/webhooks.js';
import { tzLabel } from '../lib/time.js';
import type { Payload } from '../lib/validate.js';

export interface ComposePageData {
  webhooks: NamedWebhookRow[];
  /** Pre-filled payload when duplicating an existing job. */
  initialPayload?: Payload | null;
  initialWebhook?: string | null;
  initialSendAt?: string | null;
  notice?: string | null;
  error?: string | null;
}

export function composePage(d: ComposePageData): string {
  const enabled = d.webhooks.filter((w) => w.enabled === 1);
  return layout({
    title: '送信',
    active: 'compose',
    notice: d.notice ?? null,
    error: d.error ?? null,
    scripts: ['/static/compose.js'],
    body: html`
      ${pageHeader('メッセージ送信')}
      <noscript>
        <div class="flash flash-warn">
          JavaScript が無効です。本文のみのプレーンテキスト送信は可能ですが、Embed
          ビルダーとプレビューは動作しません。
        </div>
      </noscript>

      <form method="post" action="/compose" id="compose-form" class="compose">
        <div class="compose-main">
          <section class="card">
            <h2>宛先</h2>
            <div class="radio-row">
              <label class="radio">
                <input type="radio" name="target_type" value="named" checked />
                登録済み webhook から選ぶ
              </label>
              <label class="radio">
                <input type="radio" name="target_type" value="url" />
                Webhook URL を直接指定
              </label>
            </div>
            <div data-target="named">
              ${enabled.length === 0
                ? html`<div class="flash flash-warn">
                    有効な named webhook がありません。<a href="/webhooks">Webhook</a> から登録してください。
                  </div>`
                : html`<select name="webhook" id="webhook-select">
                    ${enabled.map(
                      (w) => html`<option value="${w.name}" ${d.initialWebhook === w.name ? raw('selected') : raw('')}>
                        ${w.name}${w.label ? ` — ${w.label}` : ''}
                      </option>`,
                    )}
                  </select>`}
            </div>
            <div data-target="url" hidden>
              <input name="webhook_url" type="url" placeholder="https://discord.com/api/webhooks/…" />
              <small>discord.com / discordapp.com の webhook エンドポイントのみ受け付けます。</small>
            </div>
          </section>

          <section class="card">
            <div class="section-head">
              <h2>本文</h2>
              <label class="switch">
                <input type="checkbox" id="json-mode" />
                JSON を直接編集
              </label>
            </div>

            <div id="builder-pane">
              <label>
                content（プレーンテキスト・2000字まで）
                <textarea name="content" id="content" rows="4" maxlength="2000"
                  placeholder="本文。Embed だけを送る場合は空欄で構いません。"></textarea>
                <small class="counter" id="content-count">0 / 2000</small>
              </label>

              <div class="section-head">
                <h3>Embed</h3>
                <button type="button" class="btn btn-sm" id="add-embed">＋ Embed を追加</button>
              </div>
              <div id="embeds"></div>
              <div class="hint" id="embed-budget"></div>
            </div>

            <div id="json-pane" hidden>
              <label>
                payload JSON（Discord の webhook 実行ペイロードそのもの）
                <textarea name="payload_json" id="payload-json" rows="18" spellcheck="false"></textarea>
                <small
                  >content / embeds / username / avatar_url / allowed_mentions / thread_id / flags
                  が使えます。</small
                >
              </label>
              <div id="json-error" class="flash flash-err" hidden></div>
            </div>
          </section>

          <section class="card">
            <h2>オプション</h2>
            <div class="form-grid">
              <label>
                表示名の上書き (username)
                <input name="username" id="username" maxlength="80" placeholder="webhook の既定値を使用" />
              </label>
              <label>
                アイコン URL の上書き
                <input name="avatar_url" id="avatar_url" type="url" placeholder="webhook の既定値を使用" />
              </label>
              <label>
                スレッドID (thread_id)
                <input name="thread_id" id="thread_id" placeholder="フォーラム/スレッドに投稿する場合" />
              </label>
              <div class="checks">
                <label class="check">
                  <input type="checkbox" name="allow_everyone" id="allow_everyone" />
                  <span>@everyone / @here / ロールメンションを有効にする</span>
                </label>
                <label class="check">
                  <input type="checkbox" name="silent" id="silent" />
                  <span>通知なしで送信する (silent)</span>
                </label>
              </div>
            </div>
          </section>

          <section class="card">
            <h2>送信タイミング</h2>
            <div class="radio-row">
              <label class="radio">
                <input type="radio" name="when" value="now" checked />
                今すぐ送信
              </label>
              <label class="radio">
                <input type="radio" name="when" value="later" ${d.initialSendAt ? raw('checked') : raw('')} />
                日時を指定して予約
              </label>
            </div>
            <div data-when="later" ${d.initialSendAt ? raw('') : raw('hidden')}>
              <label>
                送信日時（${tzLabel()}）
                <input type="datetime-local" name="send_at" value="${d.initialSendAt ?? ''}" />
              </label>
            </div>
          </section>

          <div class="actions">
            <button type="submit" class="btn btn-primary btn-lg" id="submit-btn">送信する</button>
            <span class="hint">送信前にプレビューをご確認ください。</span>
          </div>
        </div>

        <aside class="compose-preview">
          <h2>プレビュー</h2>
          <div class="discord-preview" id="preview"></div>
          <p class="hint">
            Discord の見た目に近づけた簡易プレビューです。Markdown
            の一部やカスタム絵文字は再現されません。
          </p>
        </aside>

        <input type="hidden" name="payload" id="payload-field" />
      </form>

      <script id="initial-payload" type="application/json">${jsonScript(d.initialPayload ?? null)}</script>
    `,
  });
}
