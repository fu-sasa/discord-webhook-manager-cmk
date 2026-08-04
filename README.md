# Discord Webhook Manager for CMK

コミックマーケット準備会向けの、Discord Webhook スケジューリング＆転送サーバーです。

- 登録済みの **named webhook** に名前で送信、または Webhook URL を直接指定して送信
- **即時送信**と**日時指定の予約送信**、**cron による定期実行**
- Embed ビルダー付きの WebUI と、同じ機能を提供する **REST API**
- **Discord アカウントでログイン**（OAuth2）。管理者が許可したメールアドレスのみ
- 送信失敗時の自動リトライと Discord へのアラート通知

## クイックスタート（サーバー）

```bash
git clone https://github.com/fu-sasa/discord-webhook-manager-cmk.git /opt/dwm
sudo /opt/dwm/deploy/install.sh
```

Node.js の導入、サービスユーザー作成、`.env` 生成、systemd 登録、日次バックアップの設定までを行い、
初回の緊急用パスワードを一度だけ表示します。公開は Cloudflare Tunnel の Public Hostname を
`127.0.0.1:8080` に向けて追加してください（[運用マニュアル](docs/OPERATIONS.md)参照）。

続いて Discord ログインを設定します。

```bash
sudo /opt/dwm/deploy/set-discord-auth.sh
```

Discord 開発者ポータルでアプリを作り、Redirect URI に
`https://<公開URL>/auth/discord/callback` を登録したうえで、Client ID / Secret と初期管理者の
メールアドレスを入力してください。以降は WebUI の「管理者」画面から追加・削除できます。

## ローカル開発

```bash
npm install
cp .env.example .env   # APP_SECRET は openssl rand -hex 32 で生成
npm run build && npm start
```

`http://127.0.0.1:8080` で WebUI が開きます。ローカルの HTTP で試す場合は `.env` の
`COOKIE_SECURE=0` にしてください。

## API の例

```bash
curl -X POST https://webhook-manager-cmk.uslog.tech/api/v1/messages \
  -H "Authorization: Bearer dwm_..." \
  -H "Content-Type: application/json" \
  -d '{
        "webhook": "cmk-announce",
        "send_at": "2026-08-10T21:00:00+09:00",
        "idempotency_key": "announce-2026-08-10",
        "payload": {
          "content": "お知らせです",
          "embeds": [{ "title": "第107回 コミックマーケット", "color": "#5865F2" }]
        }
      }'
```

## ドキュメント

| | |
|---|---|
| [仕様書](docs/SPEC.md) | アーキテクチャ、データモデル、API 仕様、セキュリティ設計 |
| [運用マニュアル](docs/OPERATIONS.md) | 導入・公開設定・監視・バックアップ・障害対応 |
| [利用者マニュアル](docs/USER_GUIDE.md) | WebUI の使い方 |
| [AI 向け連携メモ](docs/AI_INTEGRATION.md) | このサーバー経由の送信を実装する AI / 開発者向けの要点 |

## 構成

```
src/
  config.ts            環境変数の読み込みと検証
  db/                  SQLite 接続とスキーマ（node:sqlite、ネイティブ依存なし）
  lib/                 暗号処理・時刻/cron・バリデーション・HTML テンプレート
  services/            管理者 / Discord OAuth / named webhook / APIキー
                       / ジョブ / 定期実行 / 送信 / アラート
  scheduler/worker.ts  キューの実行、リトライ、cron 展開
  routes/              REST API と WebUI
  views/               サーバーサイドレンダリングの各画面
public/                CSS と Embed ビルダー
deploy/                install.sh / update.sh / systemd ユニット / バックアップ
```

## ライセンス

コミックマーケット準備会内部利用を想定した非公開プロジェクトです。
