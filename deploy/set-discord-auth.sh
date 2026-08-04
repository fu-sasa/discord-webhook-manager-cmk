#!/usr/bin/env bash
# Configure Discord OAuth2 login for an existing install.
#
# Prerequisites, on https://discord.com/developers/applications :
#   1. Create (or open) an application
#   2. OAuth2 -> Redirects -> add exactly:
#        <PUBLIC_BASE_URL>/auth/discord/callback
#   3. Copy the Client ID, and reset/copy the Client Secret
#
# Usage:
#   sudo /opt/dwm/deploy/set-discord-auth.sh
#
# Values are echoed back for verification before anything is written — a
# mistyped or partially-pasted secret is the most common cause of the
# `invalid_client` failure, and it is invisible until you try to log in.
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/dwm}
ENV_FILE="$APP_DIR/.env"
SERVICE=discord-webhook-manager

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m警告:\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root で実行してください (sudo $0)"
[ -f "$ENV_FILE" ] || die "$ENV_FILE がありません。先に install.sh を実行してください。"

BASE_URL=$(grep -E '^PUBLIC_BASE_URL=' "$ENV_FILE" | head -1 | cut -d= -f2-)
[ -n "$BASE_URL" ] || die "PUBLIC_BASE_URL が .env にありません"

# Terminals send bracketed-paste markers (ESC[200~ … ESC[201~) around pasted
# text, and `read` happily captures them. Strip those, any other control
# characters, surrounding quotes and whitespace.
sanitise() {
  printf '%s' "$1" \
    | sed -e 's/\x1b\[20[01]~//g' -e 's/\x1b\[[0-9;]*[a-zA-Z]//g' \
    | tr -d '[:cntrl:]' \
    | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' \
          -e 's/^["'"'"']//' -e 's/["'"'"']$//'
}

echo
echo "════════════════════════════════════════════════════════════════════"
echo " Discord 開発者ポータルで、この Redirect URI を登録しておいてください"
echo "     ${BASE_URL}/auth/discord/callback"
echo "════════════════════════════════════════════════════════════════════"
echo

# ---- Client ID -------------------------------------------------------------
printf 'Client ID (数字のみ): '
read -r RAW_ID
CLIENT_ID=$(sanitise "$RAW_ID")
[ -n "$CLIENT_ID" ] || die "Client ID が空です"
case "$CLIENT_ID" in
  *[!0-9]*) die "Client ID に数字以外が含まれています: '$CLIENT_ID'" ;;
esac
if [ ${#CLIENT_ID} -lt 17 ] || [ ${#CLIENT_ID} -gt 20 ]; then
  warn "Client ID が ${#CLIENT_ID} 桁です（通常は 18〜19 桁）。"
fi

# ---- Client Secret ---------------------------------------------------------
echo
echo "Client Secret を貼り付けてください。"
echo "入力内容はそのまま画面に表示されます（正しく貼れたか確認するためです）。"
echo "  ・Discord のシークレットは 32 文字、英数字と - _ のみです"
echo "  ・「Reset Secret」直後にコピーした値を使ってください"
printf 'Client Secret: '
read -r RAW_SECRET
CLIENT_SECRET=$(sanitise "$RAW_SECRET")
[ -n "$CLIENT_SECRET" ] || die "Client Secret が空です"

if [ ${#RAW_SECRET} -ne ${#CLIENT_SECRET} ]; then
  warn "貼り付けに余分な文字が含まれていたため除去しました（${#RAW_SECRET} → ${#CLIENT_SECRET} 文字）。"
fi
case "$CLIENT_SECRET" in
  *[!A-Za-z0-9_-]*) die "Client Secret に使用できない文字が含まれています。貼り付け直してください。" ;;
esac
if [ ${#CLIENT_SECRET} -ne 32 ]; then
  warn "Client Secret が ${#CLIENT_SECRET} 文字です。Discord のシークレットは通常 32 文字です。"
  warn "先頭や末尾が欠けている / 余分な文字が付いている可能性があります。"
fi

# ---- Bootstrap admin -------------------------------------------------------
echo
printf '初期管理者のメールアドレス (Discord に登録済みのもの、空欄可): '
read -r RAW_EMAIL
ADMIN_EMAIL=$(sanitise "$RAW_EMAIL")

# ---- Confirm ---------------------------------------------------------------
echo
echo "────────────────────────────────────────────────────────────────────"
echo " この内容で保存します。Discord の画面と1文字ずつ見比べてください。"
echo "────────────────────────────────────────────────────────────────────"
printf ' Client ID     : %s   (%d 文字)\n' "$CLIENT_ID" "${#CLIENT_ID}"
printf ' Client Secret : %s   (%d 文字)\n' "$CLIENT_SECRET" "${#CLIENT_SECRET}"
printf ' 初期管理者    : %s\n' "${ADMIN_EMAIL:-（設定しない）}"
printf ' Redirect URI  : %s/auth/discord/callback\n' "$BASE_URL"
echo "────────────────────────────────────────────────────────────────────"
printf 'この内容で保存しますか? [y/N]: '
read -r CONFIRM
case "$CONFIRM" in
  [yY]|[yY][eE][sS]) ;;
  *) echo "中止しました。.env は変更していません。"; exit 1 ;;
esac

# ---- Write -----------------------------------------------------------------
# Rewritten via a temp file rather than `sed -i`: the values are arbitrary
# strings and escaping them into a sed expression is a trap.
set_env() {
  local key=$1 value=$2 tmp
  tmp=$(mktemp "${ENV_FILE}.XXXXXX")
  chmod 600 "$tmp"
  grep -vE "^${key}=" "$ENV_FILE" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > "$ENV_FILE"   # keeps the original owner and mode
  rm -f "$tmp"
}

BACKUP="${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
cp -a "$ENV_FILE" "$BACKUP"
chmod 600 "$BACKUP"
log "バックアップ: $BACKUP"

log ".env を更新しています"
set_env DISCORD_CLIENT_ID "$CLIENT_ID"
set_env DISCORD_CLIENT_SECRET "$CLIENT_SECRET"
[ -n "$ADMIN_EMAIL" ] && set_env BOOTSTRAP_ADMIN_EMAIL "$ADMIN_EMAIL"

chown dwm:dwm "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Prove the file really holds what we intended before restarting.
WROTE_ID=$(grep -E '^DISCORD_CLIENT_ID=' "$ENV_FILE" | cut -d= -f2-)
WROTE_SECRET=$(grep -E '^DISCORD_CLIENT_SECRET=' "$ENV_FILE" | cut -d= -f2-)
[ "$WROTE_ID" = "$CLIENT_ID" ] || die ".env への書き込みが一致しません (Client ID)"
[ "$WROTE_SECRET" = "$CLIENT_SECRET" ] || die ".env への書き込みが一致しません (Client Secret)"
log "書き込みを検証しました（ID ${#WROTE_ID} 文字 / Secret ${#WROTE_SECRET} 文字）"

log "サービスを再起動しています"
systemctl restart "$SERVICE"
sleep 3
systemctl is-active --quiet "$SERVICE" || {
  journalctl -u "$SERVICE" -n 30 --no-pager -o cat
  die "起動に失敗しました"
}

journalctl -u "$SERVICE" -n 20 --no-pager -o cat | grep -i 'discord login' || true

echo
echo "────────────────────────────────────────────────────────────────────"
echo " Discord ログインを設定しました"
echo "────────────────────────────────────────────────────────────────────"
echo " ログイン : ${BASE_URL}/login"
echo " 管理者   : ${BASE_URL}/admins  で追加・削除できます"
echo
echo " うまくいかない場合は、失敗の理由がログイン画面に表示されます。"
echo " 詳細ログ: journalctl -u ${SERVICE} -n 30 | grep -i discord"
echo
echo " 動作確認できたら、管理者ページから「緊急用パスワードログイン」を"
echo " 無効にすることをおすすめします。"
echo "────────────────────────────────────────────────────────────────────"
