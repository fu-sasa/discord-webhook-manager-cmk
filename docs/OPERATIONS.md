# 運用マニュアル — Discord Webhook Manager for CMK

対象: サーバーを管理する人

## 0. 環境の要点

| 項目 | 値 |
|---|---|
| ホスト | `uslog-pkg-v2`（Ubuntu 26.04 LXC / 4GB RAM） |
| 接続 | `ssh uslog-pkg-v2`（`~/.ssh/config` で cloudflared 経由に設定済み） |
| 認証情報 | root パスワードはパスワード管理ツールを参照（この文書には記載しません） |
| 公開 URL | `https://webhook-manager-cmk.uslog.tech` |
| アプリ | `/opt/dwm`（root 所有・読み取り専用運用） |
| データ | `/var/lib/dwm/dwm.db`（`dwm` ユーザー所有） |
| バックアップ | `/var/backups/dwm/dwm-YYYYMMDD-HHMMSS.db.gz`（14日保持） |
| サービス | `discord-webhook-manager.service`, `dwm-backup.timer` |
| 待ち受け | `127.0.0.1:8080`（外部から直接は到達できません） |

## 1. 初回インストール

```bash
ssh uslog-pkg-v2
git clone https://github.com/fu-sasa/discord-webhook-manager-cmk.git /opt/dwm
/opt/dwm/deploy/install.sh
```

スクリプトが行うこと:

1. Node.js 24 を NodeSource から導入（既に 22 以上があればスキップ）
2. `sqlite3` / `git` / `curl` を導入
3. システムユーザー `dwm` とデータ・バックアップディレクトリを作成
4. `npm ci` → `npm run build` → 開発用依存を削除
5. `.env` を生成（`APP_SECRET` と管理パスワードをランダム生成）
6. systemd ユニットを登録して起動、日次バックアップタイマーを有効化
7. ヘルスチェックを実行し、**管理パスワードを一度だけ表示**

> 表示された管理パスワードは必ず控えてください。以後は再表示できません。忘れた場合は §7 の手順で
> リセットします。ログイン後、設定画面から任意のパスワードに変更してください。

### 1-1. Cloudflare Tunnel に公開ホスト名を追加（手動作業）

このサーバーの `cloudflared` はトークン方式で、経路は Cloudflare 側で管理されています。
サーバー内の設定変更だけでは公開できません。

**トンネルは、自分と同じ Cloudflare アカウントのゾーンにしかルートを作れません。**
`uslog.tech` は既存トンネル（`tesatech.net` 側のアカウント）とは別アカウントのゾーンなので、
`uslog.tech` を持つアカウントで**2本目のトンネルを作成**します。

> **既存トンネルのトークンを差し替えてはいけません。** このホストの SSH は既存の
> `cloudflared.service` が中継しています。差し替えるとその経路が消え、Proxmox の
> コンソール以外から入れなくなります。2本のコネクタは互いに干渉せず並走できます。

#### 手順 A — Cloudflare 側（`uslog.tech` のアカウントで）

1. [Cloudflare Zero Trust](https://one.dash.cloudflare.com/) を **`uslog.tech` を持つアカウント**で開く
   （右上のアカウント切り替えで、ゾーン一覧に `uslog.tech` が見える方を選ぶ）
2. **Networks → Tunnels → Create a tunnel** → **Cloudflared** を選択
3. 名前を `uslog-pkg-v2-web` などにして **Save tunnel**
4. インストール手順の画面が出るので、**コマンドは実行せずトークンだけコピー**します。
   `cloudflared service install eyJhIjoi....` の `eyJ` 以降の長い文字列が該当部分です
5. いったんこの画面のまま **Next** に進み、Public Hostname を設定

   | 項目 | 値 |
   |---|---|
   | Subdomain | `webhook-manager-cmk` |
   | Domain | `uslog.tech` |
   | Type | `HTTP` |
   | URL | `127.0.0.1:8080` |

> **URL 欄はホストとポートの両方**を入れてください。`8080` だけだと cloudflared は
> それをホスト名とみなし、`dial tcp: lookup 8080: no such host` で **502** になります。
> `localhost:8080` でも動きますが、このホストは `::1` で待ち受けていないため IPv6 を試して
> 失敗してから IPv4 に落ちます。`127.0.0.1:8080` が確実です。

#### 手順 B — サーバー側（2本目のコネクタを追加）

```bash
ssh uslog-pkg-v2
/opt/dwm/deploy/add-tunnel.sh uslog
# プロンプトが出たらトークンを貼り付けて Enter
```

スクリプトはトークンの形式を検証してから `/etc/cloudflared/token-uslog` に 600 で保存し、
`cloudflared-uslog.service` を起動します。**既存の `cloudflared.service` には一切触れず**、
処理の最後にそれがまだ `active` であることを確認します（落ちていたらエラー終了）。

メトリクスポートは既存が 20241、新規は 20242 に固定してあるので衝突しません。

#### 手順 C — 確認

```bash
systemctl status cloudflared cloudflared-uslog   # 両方 active であること
curl -s https://webhook-manager-cmk.uslog.tech/healthz
```

数十秒で JSON が返れば完了です。

> **切り分け**: `healthz` が返らないときは、まずサーバー上で
> `curl -s http://127.0.0.1:8080/healthz` を試します。ローカルで応答するならアプリは正常で、
> 原因は Cloudflare 側（Public Hostname の未設定、URL 欄の書式誤り、別アカウントのトンネルに設定した）です。
>
> コネクタが実際に受け取っている設定は次で確認できます。`service` が
> `http://127.0.0.1:8080` になっているかを見てください。
>
> ```bash
> journalctl -u cloudflared-uslog | grep 'Updated to new configuration' | tail -1
> ```

> **推奨**: 同じ画面で **Access → Applications** にこのホスト名を登録し、メール認証などで
> アプリ全体を保護すると二重防御になります。その場合、API を使う外部システム向けには
> `/api/` パスをバイパスするポリシー、または Service Token を発行してください（Access を
> 通さないと API リクエストがログイン画面に飛ばされます）。

### 1-2. Discord ログインの設定

WebUI のログインは Discord OAuth2 です。許可リストに登録されたメールアドレスの Discord
アカウントだけがログインできます。

#### Discord 開発者ポータル側

1. [Discord Developer Portal](https://discord.com/developers/applications) → **New Application**
   （既存のアプリでも可）
2. **OAuth2** → **Redirects** → **Add Redirect** に次を**完全一致**で登録して保存

   ```
   https://webhook-manager-cmk.uslog.tech/auth/discord/callback
   ```

3. 同じ画面の **Client ID** をコピー、**Client Secret** は **Reset Secret** で発行してコピー

> Bot を作る必要はありません。使うのは OAuth2 の `identify` と `email` スコープだけで、
> サーバーへの参加やメッセージ権限は要求しません。

#### サーバー側

```bash
ssh uslog-pkg-v2
/opt/dwm/deploy/set-discord-auth.sh
```

Client ID / Client Secret / 初期管理者メールアドレスを対話で入力します。Secret は画面に表示されず、
シェル履歴にも残りません。`.env` はタイムスタンプ付きでバックアップされてから更新され、
最後にサービスが再起動されます。

#### 確認

```bash
journalctl -u discord-webhook-manager -n 20 --no-pager | grep -i 'discord login'
```

`discord login enabled (redirect https://.../auth/discord/callback)` が出れば設定済みです。
ブラウザで公開 URL を開き、「Discord でログイン」から入れることを確認してください。

<br>

**初期管理者について**: `BOOTSTRAP_ADMIN_EMAIL` は「管理者が0人のとき」だけ効きます。
すでに誰か登録されている状態で書き換えても何も起きません。2人目以降は WebUI の
「管理者」画面から追加してください。

**締め出し対策**: 緊急用パスワードログインは既定で有効です。Discord ログインが確実に動くことを
確認するまでは無効にしないでください。無効化した後に締め出された場合は §7 を参照してください。

## 2. 日常運用

### 状態確認

```bash
systemctl status discord-webhook-manager
curl -s http://127.0.0.1:8080/healthz
```

`healthz` は認証不要で、待機中ジョブ数と失敗数を返します。

```json
{"status":"ok","version":"1.0.0","queued":3,"failed":0,"time":"2026-08-05T00:00:00.000Z"}
```

### ログ

```bash
journalctl -u discord-webhook-manager -f          # 追従
journalctl -u discord-webhook-manager --since today
journalctl -u discord-webhook-manager -p err      # エラーのみ
```

主なログ行:

| 内容 | 意味 |
|---|---|
| `job job_xxx sent (name)` | 送信成功 |
| `job job_xxx attempt N/5 failed …; retrying in Ns` | リトライ待ち |
| `job job_xxx failed: …` | 最終的に失敗（アラートが飛びます） |
| `job job_xxx rate limited, retrying in Ns` | Discord のレート制限に当たった |
| `schedule sch_xxx (名前) fired` | 定期実行がジョブを生成 |
| `recovered N job(s) left in 'sending'` | 前回の異常終了から復帰した |

### 再起動 / 停止

```bash
systemctl restart discord-webhook-manager
systemctl stop discord-webhook-manager
```

停止中の予約は失われません。24時間以内であれば再起動後に送信されます（それを超えたものは
「misfire」として送信されず失敗扱いになります）。

## 3. 更新

```bash
ssh uslog-pkg-v2
/opt/dwm/deploy/update.sh
```

バックアップ → `git pull` → `npm ci` → ビルド → 再起動 → ヘルスチェック まで行います。
DB マイグレーションは起動時に自動適用されます。

## 4. バックアップと復旧

### 取得

日次 04:15 に自動取得されます。手動で取る場合:

```bash
sudo -u dwm /opt/dwm/deploy/backup.sh
ls -lh /var/backups/dwm/
```

### 復旧

```bash
systemctl stop discord-webhook-manager
gunzip -c /var/backups/dwm/dwm-20260805-041500.db.gz > /tmp/restore.db
sudo -u dwm cp /tmp/restore.db /var/lib/dwm/dwm.db
rm -f /var/lib/dwm/dwm.db-wal /var/lib/dwm/dwm.db-shm
systemctl start discord-webhook-manager
```

> **重要**: `/opt/dwm/.env` も必ず別途保管してください。`APP_SECRET` を失うと、
> DB を復旧しても保存済みの Webhook URL を復号できず、named webhook の再登録が必要になります。

### 別ホストへの移設

`/opt/dwm/.env` と `/var/lib/dwm/dwm.db` の2つを持っていけば、そのまま同じ状態で動きます。

## 5. 監視のすすめ

- **失敗アラート**: WebUI の「設定」で通知先の named webhook を指定してください。未設定だと
  ダッシュボードに警告が出ます
- **外形監視**: `https://webhook-manager-cmk.uslog.tech/healthz` を Uptime 監視に登録
- **キュー滞留**: `healthz` の `queued` が想定より大きい状態が続く場合はスケジューラの停止を疑います

## 6. トラブルシュート

| 症状 | 確認 | 対処 |
|---|---|---|
| サービスが起動しない | `journalctl -u discord-webhook-manager -n 50` | `APP_SECRET` が64桁の16進か、ポート 8080 が空いているかを確認 |
| `failed to start: listen EADDRINUSE` | `ss -tlnp \| grep 8080` | 旧プロセスを停止するか `.env` の `PORT` を変更 |
| 公開 URL に繋がらない | `curl http://127.0.0.1:8080/healthz` | ローカルで応答するなら Cloudflare の Public Hostname 設定側の問題 |
| ログインできない | — | §7 の復旧手順 |
| Discord ログインで「クライアントIDまたはシークレットが正しくありません」 | `.env` の `DISCORD_*` | `set-discord-auth.sh` で再設定。Secret は Reset して取り直す |
| Discord ログインで「Redirect URI が一致しません」 | 開発者ポータルの Redirects | `${PUBLIC_BASE_URL}/auth/discord/callback` を完全一致で登録 |
| 「管理者として登録されていません」 | `journalctl` の `login denied for …` | そのアドレスを「管理者」画面で追加。Discord 側の確認済みアドレスか要確認 |
| ログインしてもすぐ弾かれる | ブラウザの Cookie | HTTP で検証中なら `.env` の `COOKIE_SECURE=0`（本番は必ず `1`） |
| 送信が `failed` HTTP 404 | ジョブ詳細のエラー欄 | Discord 側で Webhook が削除されています。URL を再発行して差し替え |
| 送信が `failed` HTTP 401/403 | 同上 | Webhook のトークンが無効。URL を差し替え |
| 送信が `failed` HTTP 400 | 同上 | ペイポードが Discord に拒否されています。Embed の文字数や画像 URL を確認 |
| `misfire` で失敗した | — | サービスが24時間以上停止していました。必要なら再送してください |
| 予約が実行されない | `systemctl status` | スケジューラはアプリ内で動くため、サービスが止まっていれば実行されません |

### 手動で DB を覗く

```bash
sudo -u dwm sqlite3 /var/lib/dwm/dwm.db \
  "SELECT public_id, status, target_label, scheduled_at, last_error FROM jobs ORDER BY id DESC LIMIT 20;"
```

## 7. ログインできなくなったときの復旧

### 誰も管理者としてログインできない

管理者を直接 DB に追加します（メールアドレスは小文字で）。

```bash
sudo -u dwm sqlite3 /var/lib/dwm/dwm.db \
  "INSERT INTO admins (email, label, added_by, created_at)
   VALUES ('someone@example.com', '復旧用', 'cli', datetime('now'));"
```

現在の登録状況の確認:

```bash
sudo -u dwm sqlite3 -header -column /var/lib/dwm/dwm.db \
  "SELECT id, email, label, last_login_at FROM admins;"
```

### 緊急用パスワードログインを無効にしたまま締め出された

```bash
sudo -u dwm sqlite3 /var/lib/dwm/dwm.db \
  "UPDATE settings SET value='1' WHERE key='password_login_enabled';"
```

反映は即時です（再起動不要）。

### 緊急用パスワードを忘れた

DB のハッシュを削除すると、次回起動時に `.env` の `ADMIN_PASSWORD`（または自動生成値）で
初期化されます。

```bash
systemctl stop discord-webhook-manager
sudo -u dwm sqlite3 /var/lib/dwm/dwm.db "DELETE FROM settings WHERE key='admin_password_hash';"
# .env の ADMIN_PASSWORD を希望のパスワード（12文字以上）に書き換える
systemctl start discord-webhook-manager
journalctl -u discord-webhook-manager -n 20   # 自動生成の場合はここに1回だけ表示されます
```

### 全セッションを強制ログアウト

```bash
sudo -u dwm sqlite3 /var/lib/dwm/dwm.db "DELETE FROM sessions;"
```

## 8. シークレットの管理方針

| 対象 | 保管場所 | 備考 |
|---|---|---|
| サーバー root パスワード | パスワード管理ツール | この文書・リポジトリには記載しない |
| `APP_SECRET` | `/opt/dwm/.env` + パスワード管理ツール | 失うと Webhook URL を復号できない |
| `DISCORD_CLIENT_SECRET` | `/opt/dwm/.env` + パスワード管理ツール | 漏れた場合は開発者ポータルで Reset Secret → `set-discord-auth.sh` で再設定 |
| 緊急用パスワード | パスワード管理ツール | 設定画面から変更可能。Discord が使えないときの唯一の入口 |
| API キー | 発行時に受け取った側で保管 | 再表示不可。紛失時は失効させて再発行 |
| Discord Webhook URL | 本システム内（暗号化） | 平文は Discord の管理画面から再取得 |

`.env` と DB はどちらも `git` の管理外です（`.gitignore` 済み）。

## 9. 定期的に見るとよいもの

- **管理者一覧**: 異動・退任した人が残っていないか。最終ログインが古い人は棚卸し
- **設定 → 操作ログ**: 誰がいつ何を変更したか（`login.denied` が続いていれば設定ミスか不正試行）
- **APIキー → 最終利用**: 使われていないキーは失効させる
- **Webhook 一覧**: 使わなくなったものは無効化または削除
- **送信履歴（失敗で絞り込み）**: 恒常的に失敗している宛先がないか
