# AI / 開発者向け連携メモ — Discord Webhook Manager for CMK

このページだけを読めば、この転送サーバー経由の Discord Webhook 送信を実装できます。
AI エージェントにコンテキストとして渡すことを想定した内容です。

---

## 概要

Discord へ直接 Webhook を叩く代わりに、このサーバーの REST API を呼びます。
利点: Webhook URL を持たなくてよい / 予約送信ができる / 失敗時に自動リトライされる /
送信履歴が残る / 誤爆メンションが既定で抑止される。

```
あなたのコード ──HTTPS──▶ https://dwm-pkg-v2.tesatech.net/api/v1 ──▶ Discord
```

- **ベース URL**: `https://dwm-pkg-v2.tesatech.net/api/v1`
- **認証**: `Authorization: Bearer dwm_xxxxxxxx`（管理者から受け取ってください）
- **Content-Type**: `application/json`
- **レート制限**: APIキーあたり 120 リクエスト/分（超過は 429）
- **タイムゾーン**: 日時は ISO8601 で送ります。オフセット付き（`+09:00`）を推奨

> API キーは秘密情報です。環境変数やシークレットストアに置き、リポジトリやログに出さないでください。

---

## 最短の例

```bash
curl -X POST https://dwm-pkg-v2.tesatech.net/api/v1/messages \
  -H "Authorization: Bearer $DWM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"webhook":"cmk-announce","payload":{"content":"ビルドが完了しました"}}'
```

レスポンス `202 Accepted`:

```json
{ "id": "job_0msf0tsvja58fefdeed", "status": "queued", "scheduled_at": "2026-08-05T00:00:00.000Z" }
```

送信はキュー経由なので、既定では「受け付けた」時点で返ります。実際に届いたかまで確認したい場合は
`"wait": true` を付けると最大10秒待ち、`status` が `sent` か `failed` で返ります。

---

## POST /api/v1/messages

### リクエスト

| フィールド | 型 | 必須 | 説明 |
|---|---|---|---|
| `webhook` | string | ※ | 登録済み named webhook の名前。**通常はこちらを使う** |
| `webhook_url` | string | ※ | Discord の Webhook URL を直接指定。キーの設定により拒否される場合あり |
| `send_at` | string | | ISO8601。省略すると即時。過去日時は即時扱い |
| `idempotency_key` | string | | 同じキーの2回目以降は新規送信せず既存ジョブを返す（最大190文字） |
| `wait` | boolean | | `true` で結果確定まで最大10秒待つ |
| `payload` | object | ✓ | Discord の Webhook 実行ペイロード（下記） |

※ `webhook` と `webhook_url` はどちらか一方が必須。両方指定はエラー。

### payload

| フィールド | 型 | 説明 |
|---|---|---|
| `content` | string | 本文。2,000字まで |
| `embeds` | array | Embed。最大10個、合計6,000字 |
| `username` | string | 表示名の上書き（80字） |
| `avatar_url` | string | アイコンの上書き |
| `thread_id` | string | スレッド/フォーラムへ投稿する場合の ID |
| `thread_name` | string | フォーラムに新規スレッドを立てる場合の名前 |
| `allowed_mentions` | object | **省略時は `{"parse":[]}` が自動付与され、メンションは一切飛びません** |
| `flags` | number | `4` = Embed 抑制, `4096` = 通知なし |

`content` と `embeds` の両方が空だと 400 になります。

### embed の構造

```jsonc
{
  "title": "第107回 コミックマーケット 準備スケジュール",  // 256字
  "description": "搬入・設営の各担当は下記の時間に集合してください。", // 4096字
  "url": "https://example.com/detail",          // タイトルのリンク先
  "color": "#5865F2",                            // "#RRGGBB" / "5865F2" / 5793266 のいずれでも可
  "timestamp": "2026-08-10T12:00:00Z",           // ISO8601
  "author":    { "name": "コミックマーケット準備会", "url": "…", "icon_url": "…" },
  "footer":    { "text": "自動送信", "icon_url": "…" },
  "thumbnail": { "url": "https://…/thumb.png" },
  "image":     { "url": "https://…/banner.png" },
  "fields": [                                    // 最大25個
    { "name": "設営日", "value": "12/29 (日) 8:00 集合", "inline": true },
    { "name": "会場",   "value": "東京ビッグサイト 東7ホール", "inline": true }
  ]
}
```

制限（超えると 400、送信前にクライアント側でも切り詰めることを推奨）:

| 項目 | 上限 |
|---|---|
| `content` | 2,000 |
| `embeds` | 10個 / 合計 6,000字 |
| `title`, `author.name`, `fields[].name` | 256 |
| `description` | 4,096 |
| `fields[].value` | 1,024 |
| `fields` | 25個 |
| `footer.text` | 2,048 |
| `username` | 80 |

合計6,000字の対象は `title` + `description` + `footer.text` + `author.name` + 各 `field.name`/`value` です。

### メンションを飛ばしたい場合のみ

```json
"allowed_mentions": { "parse": ["everyone", "roles", "users"] }
```

特定ロールだけなら `{"parse": [], "roles": ["1234567890"]}` のように指定します。
**明示しない限り誰にも通知されません。** 意図しない全体通知の事故を防ぐための既定です。

### ファイル添付

対応していません。画像は公開 URL を `embed.image.url` などに指定してください。

---

## その他のエンドポイント

| メソッド | パス | 説明 |
|---|---|---|
| `GET` | `/messages/:id` | 状態取得。`?include=payload` で送信内容も返る |
| `GET` | `/messages?status=failed&limit=20` | 履歴。`status` `webhook` `limit` `offset` |
| `DELETE` | `/messages/:id` | 待機中ジョブのキャンセル |
| `GET` | `/webhooks` | 送信可能な named webhook の一覧（URL は返りません） |
| `POST` | `/webhooks` | named webhook の登録（`manage` スコープ必要） |
| `PATCH` `DELETE` | `/webhooks/:name` | 更新・削除（`manage`） |
| `GET` `POST` `PATCH` `DELETE` | `/schedules` `/schedules/:id` | cron による定期実行 |
| `GET` | `/me` | 自分のキーのスコープ確認 |
| `GET` | `/healthz` | 認証不要の死活確認 |

### named webhook の登録（manage スコープ）

```bash
curl -X POST https://dwm-pkg-v2.tesatech.net/api/v1/webhooks \
  -H "Authorization: Bearer $DWM_API_KEY" -H "Content-Type: application/json" \
  -d '{"name":"my-service","label":"連携サービス通知","url":"https://discord.com/api/webhooks/…","tags":"bot"}'
```

`url` は `https://discord.com/api/webhooks/<id>/<token>` 形式のみ受け付けます（SSRF 対策）。
登録後の応答に URL は含まれず、マスクされた `url_hint` のみが返ります。

### 定期実行の登録

```json
POST /api/v1/schedules
{ "name": "週次リマインド", "cron": "0 9 * * 1", "tz": "Asia/Tokyo",
  "webhook": "cmk-announce", "payload": { "content": "今週の予定です" } }
```

---

## エラーハンドリング

```json
{ "error": { "code": "invalid_request", "message": "embeds.0.description: String must contain at most 4096 character(s)" } }
```

| HTTP | code | 対処 |
|---|---|---|
| 400 | `invalid_request` | 入力が不正。`message` を読んで修正。**リトライしても直りません** |
| 401 | `unauthorized` | キーが無い / 無効 / 失効。管理者に確認 |
| 403 | `forbidden` | スコープ不足、または URL 直接指定が許可されていないキー |
| 404 | `not_found` | ジョブや webhook が存在しない |
| 409 | `conflict` / `not_cancelable` | name の重複、または待機中でないジョブのキャンセル |
| 429 | `rate_limited` | 少し待って再送。指数バックオフ推奨 |
| 5xx | `internal_error` | 時間をおいて再送。`idempotency_key` を付けていれば二重送信になりません |

**Discord 側のエラーは API のレスポンスには現れません。** 送信はキュー経由なので、Discord が
拒否した場合はジョブが `failed` になります。確実に確認したいときは `wait: true` を使うか、
`GET /messages/:id` をポーリングしてください。

---

## 実装上の推奨

1. **`webhook`（名前）で指定する。** URL を自分のコードに持たない
2. **`idempotency_key` を付ける。** 再実行やリトライで同じ告知が二重投稿されるのを防げます。
   「意味のある単位」で決めるのがコツです（例: `deploy-2026-08-05-v1.2.3`, `daily-report-2026-08-05`）
3. **`allowed_mentions` は触らない。** メンションが必要なときだけ明示する
4. **4xx はリトライしない。** 429 と 5xx のみ指数バックオフでリトライ
5. **長文は送信前に切り詰める。** 上限超過は 400 になります
6. **キーは環境変数から読む。** ハードコードしない

---

## コードサンプル

### TypeScript / JavaScript

```ts
const BASE = 'https://dwm-pkg-v2.tesatech.net/api/v1';

interface SendOptions {
  webhook: string;
  content?: string;
  embeds?: unknown[];
  sendAt?: Date;
  idempotencyKey?: string;
  wait?: boolean;
}

export async function sendDiscord(opts: SendOptions) {
  const res = await fetch(`${BASE}/messages`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.DWM_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      webhook: opts.webhook,
      send_at: opts.sendAt?.toISOString(),
      idempotency_key: opts.idempotencyKey,
      wait: opts.wait ?? false,
      payload: {
        ...(opts.content ? { content: opts.content } : {}),
        ...(opts.embeds ? { embeds: opts.embeds } : {}),
      },
    }),
  });

  const body = await res.json();
  if (!res.ok) {
    throw new Error(`[${body.error?.code}] ${body.error?.message}`);
  }
  return body as { id: string; status: string };
}

// 使用例: 明日 21:00 (JST) に告知を予約
await sendDiscord({
  webhook: 'cmk-announce',
  idempotencyKey: 'announce-2026-08-10',
  sendAt: new Date('2026-08-10T21:00:00+09:00'),
  embeds: [{
    title: '第107回 コミックマーケット',
    description: 'サークル参加申込の受付を開始しました。',
    color: '#5865F2',
    fields: [{ name: '締切', value: '2026-09-15 23:59', inline: true }],
  }],
});
```

### Python

```python
import os
import requests

BASE = "https://dwm-pkg-v2.tesatech.net/api/v1"
HEADERS = {
    "Authorization": f"Bearer {os.environ['DWM_API_KEY']}",
    "Content-Type": "application/json",
}


def send_discord(webhook, content=None, embeds=None, send_at=None,
                 idempotency_key=None, wait=False):
    payload = {}
    if content:
        payload["content"] = content
    if embeds:
        payload["embeds"] = embeds

    body = {"webhook": webhook, "payload": payload, "wait": wait}
    if send_at:
        body["send_at"] = send_at.isoformat()
    if idempotency_key:
        body["idempotency_key"] = idempotency_key

    res = requests.post(f"{BASE}/messages", json=body, headers=HEADERS, timeout=30)
    data = res.json()
    if not res.ok:
        err = data.get("error", {})
        raise RuntimeError(f"[{err.get('code')}] {err.get('message')}")
    return data


send_discord(
    "cmk-announce",
    embeds=[{
        "title": "日次レポート",
        "description": "本日の処理件数: 1,204 件",
        "color": "#57F287",
    }],
    idempotency_key="daily-report-2026-08-05",
)
```

### シェル（CI などから）

```bash
send_discord() {
  curl -sS -X POST "https://dwm-pkg-v2.tesatech.net/api/v1/messages" \
    -H "Authorization: Bearer $DWM_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$(jq -n --arg w "$1" --arg c "$2" --arg k "$3" \
          '{webhook:$w, idempotency_key:$k, payload:{content:$c}}')"
}

send_discord "cmk-announce" "デプロイが完了しました ($GITHUB_SHA)" "deploy-$GITHUB_SHA"
```

---

## 動作確認のしかた

```bash
# 1. キーが有効か
curl -H "Authorization: Bearer $DWM_API_KEY" https://dwm-pkg-v2.tesatech.net/api/v1/me

# 2. 送信できる宛先を確認
curl -H "Authorization: Bearer $DWM_API_KEY" https://dwm-pkg-v2.tesatech.net/api/v1/webhooks

# 3. 実際に届くところまで同期で確認
curl -X POST https://dwm-pkg-v2.tesatech.net/api/v1/messages \
  -H "Authorization: Bearer $DWM_API_KEY" -H "Content-Type: application/json" \
  -d '{"webhook":"<上で得た name>","wait":true,"payload":{"content":"疎通テスト"}}'
# -> {"status":"sent", "discord_message_id":"...", "response_status":200}
```

`status` が `failed` の場合は `last_error` に Discord からの応答が入っています。

---

## AI エージェント向けの注意

- **勝手に `@everyone` を有効にしないこと。** ユーザーが明示的に「全体通知して」と指示した場合のみ
  `allowed_mentions` を指定してください
- **同じ内容を繰り返し送らないこと。** 再実行され得る処理には必ず `idempotency_key` を付けます
- **`webhook_url` を組み立てないこと。** 宛先は必ず `webhook`（名前）で指定します。名前が分からなければ
  `GET /webhooks` で一覧を取得してユーザーに選ばせてください
- **400 エラーを握りつぶしてリトライしないこと。** 内容の不備なので、エラーメッセージを提示して
  修正するか、ユーザーに確認してください
- **送信は取り消せません。** 予約送信（`send_at`）は待機中ならキャンセルできますが、即時送信は
  一度キューに入ると止められません。ユーザーの確認を取ってから呼び出してください
