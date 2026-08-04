# 仕様書 — Discord Webhook Manager for CMK

最終更新: 2026-08-05 / バージョン 1.0.0

## 1. 目的と背景

Discord の Webhook URL は、それ自体が「そのチャンネルに投稿できる権限」そのものです。各所に URL を配って
直接叩く運用は、流出リスクと管理不能状態を同時に招きます。また Discord の Webhook には予約送信の機能が
ありません。

本システムは次の3点を解決します。

1. Webhook URL を1か所に暗号化して集約し、以後は**名前**で参照する
2. **即時 / 予約 / 定期**の送信手段を提供する
3. **人（WebUI）と機械（API）**の双方に同じ送信経路を提供し、履歴を一元管理する

## 2. 全体構成

```
                  ┌──────────────────────────── uslog-pkg-v2 (Ubuntu 26.04 LXC) ───┐
  ブラウザ ─┐      │                                                                │
            ├─→ Cloudflare Tunnel ─→ 127.0.0.1:8080  systemd: discord-webhook-manager│
  外部システム┘     │                          │                                     │
  (API/AI)         │                          ├── Fastify   WebUI + REST API        │
                   │                          ├── Scheduler 5秒ごとにキューを処理    │
                   │                          └── SQLite    /var/lib/dwm/dwm.db     │
                   └──────────────────────────────────┬─────────────────────────────┘
                                                      ↓ HTTPS
                                              discord.com/api/webhooks/...
```

- プロセスは1つ。Web サーバーとスケジューラを同一プロセス内で動かします（ジョブの取り合いが起きないため、
  分散ロックが不要になります）
- 待ち受けは `127.0.0.1` 固定。外部公開は Cloudflare Tunnel 経由のみ
- 常駐 `cloudflared` はトークン方式で、公開ホスト名の割り当ては Cloudflare 側のダッシュボードで管理されます

### 技術スタック

| 層 | 採用 | 理由 |
|---|---|---|
| ランタイム | Node.js 24 (>=22.13) | `node:sqlite` が同梱され、ネイティブビルドが不要 |
| 言語 | TypeScript 5.7（strict） | 実行前に型でミスを潰す |
| HTTP | Fastify 5 | 軽量・高速、cookie/rate-limit/static の公式プラグイン |
| DB | SQLite (WAL) | 単一プロセス・小規模用途に最適。バックアップがファイルコピー1つ |
| 画面 | サーバーサイドレンダリング（TS テンプレートリテラル） | ビルド成果物が1つで済み、更新手順が単純 |
| cron | cron-parser 5 | タイムゾーン対応の次回実行時刻計算 |

依存パッケージは意図的に最小限（実行時7個）に抑えています。

## 3. データモデル

SQLite。マイグレーションは `src/db/schema.ts` に追記式で定義し、起動時に自動適用されます。

### named_webhooks — 登録済み Webhook

| カラム | 型 | 説明 |
|---|---|---|
| `name` | TEXT UNIQUE | 識別子。`[a-z0-9][a-z0-9_-]*`、64文字まで |
| `label` | TEXT | 人が読む表示名 |
| `url_enc` | BLOB | **AES-256-GCM で暗号化**した Webhook URL |
| `url_hint` | TEXT | `.../webhooks/1398…56/••••wXyZ` のマスク表記 |
| `default_username` / `default_avatar_url` / `default_thread_id` | TEXT | 送信時の既定値 |
| `tags` | TEXT | カンマ区切り |
| `enabled` | INTEGER | 0 で送信不可 |

平文 URL は**一度保存すると画面にも API にも二度と現れません**。差し替えは上書き登録で行います。

### jobs — 送信ジョブ

1回の送信が1行です。即時送信も予約送信も、cron から生まれた送信もすべて同じテーブルに入ります。

| カラム | 説明 |
|---|---|
| `public_id` | 外部公開ID（`job_...`）。API と URL で使う |
| `target_type` | `named` / `url` |
| `webhook_id` / `url_enc` | 宛先。named の場合は**送信時に解決**する（後述） |
| `payload_json` | 正規化済みの Discord ペイロード |
| `scheduled_at` | 送信予定時刻（UTC ISO8601） |
| `status` | `queued` / `sending` / `sent` / `failed` / `canceled` |
| `attempts` / `next_attempt_at` | リトライ制御 |
| `response_status` / `last_error` / `discord_message_id` | 結果 |
| `idempotency_key` | 部分ユニークインデックスで重複送信を防止 |
| `source` | `ui` / `api:<キーID>` / `schedule:<ID>` |

> **named 宛先を送信時に解決する理由**: Webhook URL を差し替えたとき、差し替え前に予約したジョブも
> 新しい URL で届きます。ジョブ作成時に URL を焼き付けると、URL 再発行のたびに予約が壊れます。

### schedules — 定期実行

cron 式・タイムゾーン・ペイロードを保持し、`next_run_at` が到来するとジョブを1件生成します。

### その他

- `api_keys` — ラベル、SHA-256 ハッシュ、スコープ、URL 直接指定の可否
- `sessions` — サーバー側セッション（失効可能）
- `audit_log` — 全ての変更操作
- `login_attempts` — IP 単位のロックアウト判定用
- `settings` — 管理パスワードハッシュ、アラート通知先

## 4. 送信仕様

### バリデーション（Discord の制限に準拠）

| 項目 | 上限 |
|---|---|
| `content` | 2,000 文字 |
| `embeds` | 10 個、かつ全 Embed の合計 6,000 文字 |
| `embed.title` / `author.name` / `field.name` | 256 文字 |
| `embed.description` | 4,096 文字 |
| `field.value` | 1,024 文字 |
| `fields` | 25 個 |
| `footer.text` | 2,048 文字 |
| `username` | 80 文字 |

- `color` は `#5865F2` / `5865F2` / 整数のいずれでも受け付け、内部で整数に正規化します
- 画像・リンク系の URL は http(s) のみ
- `content` と `embeds` の両方が空のリクエストは 400 で拒否します

### メンション事故の防止

`allowed_mentions` を明示しない限り **`{"parse": []}` を自動付与**します。つまり本文に `@everyone` と
書いても既定では誰にも通知されません。WebUI では「@everyone / @here / ロールメンションを有効にする」
チェックボックス、API では `allowed_mentions` の明示指定が opt-in になります。

### SSRF 対策

Webhook URL の直接指定は、次の正規表現に一致するものだけを受け付けます。

```
^https://(canary\.|ptb\.)?(discord|discordapp)\.com/api(/v\d{1,2})?/webhooks/(\d{5,25})/([A-Za-z0-9_-]{20,120})$
```

これにより、API キーを持つ相手であっても本サーバーを任意ホストへの HTTP 中継に使うことはできません。
さらに API キーごとに「URL 直接指定を許可しない（named 宛のみ）」設定が可能です。

### スケジューラの挙動

5秒ごとに次を実行します。

1. `next_run_at` が到来した定期実行をジョブ化し、次回時刻を進める
2. `scheduled_at <= 現在` かつ `next_attempt_at <= 現在` の `queued` ジョブを最大10件取得し、
   `sending` に遷移させて試行回数を +1
3. Discord へ POST（`?wait=true` を付け、返却されたメッセージIDを記録）
4. 結果に応じて状態遷移
5. 期限切れセッションとログイン試行履歴を掃除

| 応答 | 扱い |
|---|---|
| 2xx | `sent`。`discord_message_id` を記録 |
| 429 | `retry_after` 秒後に再キュー。**試行回数を消費しない**（サーバー側の都合であってジョブの失敗ではないため） |
| 5xx / ネットワーク・タイムアウト | 30秒 → 2分 → 10分 → 30分 → 2時間 のバックオフで最大5回 |
| 429 以外の 4xx | 即 `failed`。同じ内容を再送しても結果は変わらないため |

**取りこぼしの扱い（misfire）**: 停止していた間に過ぎた予約は、`MISFIRE_GRACE_SECONDS`（既定24時間）
以内であれば復帰後に送信します。それを超えたものは「30時間遅れの告知」が害になり得るため送信せず
`failed` にします。

**プロセス異常終了からの復帰**: `sending` のまま残ったジョブは起動時に `queued` へ戻します。
重複送信の可能性はありますが、告知が黙って消えるより望ましいと判断しています。

**失敗アラート**: リトライを使い切ったジョブが出たら、設定した named webhook へ Embed で通知します。
アラート自体はキューを通さず直接送信し、失敗してもログに残すだけでリトライしません（アラートの
失敗がキューを詰まらせないため）。1ジョブにつき1回だけ通知します。

## 5. REST API

ベース URL: `https://webhook-manager-cmk.uslog.tech/api/v1`
認証: `Authorization: Bearer dwm_...`
レート制限: APIキーごとに 120 リクエスト/分

| メソッド | パス | スコープ | 説明 |
|---|---|---|---|
| POST | `/messages` | send | 送信（即時 / 予約） |
| GET | `/messages` | send | 履歴一覧（`status`, `webhook`, `limit`, `offset`） |
| GET | `/messages/:id` | send | 状態取得（`?include=payload` で本文も） |
| DELETE | `/messages/:id` | send | 待機中ジョブのキャンセル |
| GET | `/webhooks` | send | named webhook 一覧（URL は返しません） |
| GET | `/webhooks/:name` | send | 単体取得 |
| POST | `/webhooks` | manage | **named webhook の登録** |
| PATCH | `/webhooks/:name` | manage | 更新（URL 差し替え含む） |
| DELETE | `/webhooks/:name` | manage | 削除 |
| GET | `/schedules` | send | 定期実行の一覧 |
| POST | `/schedules` | manage | 定期実行の登録 |
| PATCH | `/schedules/:id` | manage | 有効/無効の切り替え |
| DELETE | `/schedules/:id` | manage | 削除 |
| GET | `/me` | send | キー自身の情報 |
| GET | `/healthz` | 認証不要 | 稼働確認とキュー深度 |

### POST /messages

```jsonc
{
  "webhook": "cmk-announce",         // または "webhook_url": "https://discord.com/api/webhooks/..."
  "send_at": "2026-08-10T21:00:00+09:00",  // 省略で即時
  "idempotency_key": "announce-2026-08-10", // 任意。同じキーの2回目は既存ジョブを返す
  "wait": false,                      // true で最大10秒、結果が確定するまで待つ
  "payload": {
    "content": "本文",
    "username": "準備会bot",
    "avatar_url": "https://…/icon.png",
    "thread_id": "1234567890",
    "flags": 4096,                    // 4096 = 通知なし, 4 = Embed 抑制
    "allowed_mentions": { "parse": [] },
    "embeds": [ { "title": "…", "description": "…", "color": "#5865F2",
                  "fields": [{ "name": "日時", "value": "12/29 8:00", "inline": true }],
                  "footer": { "text": "…" }, "timestamp": "2026-08-10T12:00:00Z" } ]
  }
}
```

レスポンス（202 / `wait:true` かつ送信済みなら 200）:

```json
{
  "id": "job_0msf0tsvja58fefdeed",
  "status": "queued",
  "target": { "type": "named", "name": "cmk-announce", "url_hint": ".../webhooks/1398…56/••••wXyZ" },
  "scheduled_at": "2026-08-10T12:00:00.000Z",
  "sent_at": null, "attempts": 0, "response_status": null,
  "discord_message_id": null, "last_error": null,
  "idempotency_key": "announce-2026-08-10", "source": "api:3"
}
```

### エラー形式

```json
{ "error": { "code": "invalid_request", "message": "…", "details": [ … ] } }
```

| コード | HTTP | 意味 |
|---|---|---|
| `unauthorized` | 401 | トークンが無い・無効・失効 |
| `forbidden` | 403 | スコープ不足 |
| `invalid_request` | 400 | 入力またはペイロードが不正 |
| `not_found` | 404 | 対象が存在しない |
| `conflict` | 409 | name の重複 |
| `not_cancelable` | 409 | 待機中でないジョブのキャンセル |
| `rate_limited` | 429 | APIキーのレート上限 |
| `internal_error` | 500 | サーバー内部エラー |

## 6. セキュリティ設計

| 項目 | 実装 |
|---|---|
| 管理者認証 | パスワード1つ。scrypt (N=16384, r=8, p=1) でハッシュ化して保存 |
| セッション | サーバー側で発行・失効可能。httpOnly / SameSite=Lax / Secure クッキー、既定7日 |
| 総当たり対策 | IP 単位で15分に10回失敗するとロックアウト |
| CSRF | SameSite=Lax により他サイトからの POST でクッキーが送られない |
| Webhook URL | AES-256-GCM。鍵は `APP_SECRET` から HKDF で用途別に導出 |
| API キー | SHA-256 で保存。平文は発行時の1回だけ表示 |
| SSRF | Discord の webhook エンドポイントのみ許可 |
| XSS | テンプレートが既定でエスケープし、プレビューは `textContent` で描画 |
| ネットワーク | `127.0.0.1` バインド。到達経路は Cloudflare Tunnel のみ |
| プロセス | 専用システムユーザー、systemd で `ProtectSystem=strict` ほかの制限 |
| コード領域 | `/opt/dwm` は root 所有。サービスユーザーは自分のコードを書き換えられない |
| 監査 | 全ての変更操作を `audit_log` に記録し、設定画面で閲覧可能 |

### 鍵の取り扱い

`APP_SECRET` を紛失・変更すると、保存済みの Webhook URL は復号できなくなります（named webhook の
再登録が必要）。`.env` はバックアップ対象に含め、パスワード管理ツールにも控えてください。

## 7. 設定項目（`.env`）

| 変数 | 既定 | 説明 |
|---|---|---|
| `APP_SECRET` | （必須） | 32バイトの16進。暗号鍵とクッキー署名の元 |
| `ADMIN_PASSWORD` | — | 初回起動時のみ使用。未設定なら自動生成しログに1回出力 |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | 待ち受け |
| `PUBLIC_BASE_URL` | — | アラート通知内のリンクに使用 |
| `DATABASE_PATH` | `./data/dwm.db` | SQLite ファイル |
| `TZ_DISPLAY` | `Asia/Tokyo` | 画面表示と cron の基準 |
| `SCHEDULER_TICK_MS` | `5000` | キュー確認間隔 |
| `SCHEDULER_BATCH` | `10` | 1回に処理する最大ジョブ数 |
| `MISFIRE_GRACE_SECONDS` | `86400` | 遅延許容時間 |
| `MAX_ATTEMPTS` | `5` | 最大試行回数 |
| `SESSION_TTL_SECONDS` | `604800` | セッション有効期間 |
| `COOKIE_SECURE` | `1` | HTTP で検証する場合のみ `0` |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

## 8. 制限事項と今後の拡張余地

**現時点で未対応**

- ファイル添付（Embed の画像は URL 指定のみ）
- 1ジョブでの複数宛先への一斉送信
- メッセージテンプレート機能
- 送信済みメッセージの編集・削除（`discord_message_id` は保持しているため後付け可能）
- Webhook 単位の権限分離（API キーは全 named webhook に送信できます）

**設計上の上限**

- 単一プロセス・単一 SQLite のため、水平スケールはしません。想定規模（1日あたり数百件程度）では
  十分ですが、大量配信用途には向きません
- スケジューラの精度は tick 間隔（既定5秒）です。秒単位の厳密性は保証しません
