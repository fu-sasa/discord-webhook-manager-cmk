#!/usr/bin/env bash
# Configure Discord OAuth2 login for an existing install.
#
# Prerequisites, on https://discord.com/developers/applications :
#   1. Create (or open) an application
#   2. OAuth2 -> Redirects -> add exactly:
#        https://webhook-manager-cmk.uslog.tech/auth/discord/callback
#   3. Copy the Client ID, and reset/copy the Client Secret
#
# Usage:
#   sudo /opt/dwm/deploy/set-discord-auth.sh
# Values are read interactively so the secret never lands in shell history.
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/dwm}
ENV_FILE="$APP_DIR/.env"
SERVICE=discord-webhook-manager

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root で実行してください (sudo $0)"
[ -f "$ENV_FILE" ] || die "$ENV_FILE がありません。先に install.sh を実行してください。"

BASE_URL=$(grep -E '^PUBLIC_BASE_URL=' "$ENV_FILE" | cut -d= -f2-)
[ -n "$BASE_URL" ] || die "PUBLIC_BASE_URL が .env にありません"

echo
echo "Discord 開発者ポータルで、この Redirect URI を登録しておいてください:"
echo "    ${BASE_URL}/auth/discord/callback"
echo

printf 'Client ID: '
read -r CLIENT_ID
[ -n "$CLIENT_ID" ] || die "Client ID が空です"
case "$CLIENT_ID" in
  *[!0-9]*) die "Client ID は数字のみです（貼り付け内容を確認してください）" ;;
esac

# -s keeps the secret off the screen; it is still only ever written to .env.
printf 'Client Secret: '
read -rs CLIENT_SECRET
echo
[ -n "$CLIENT_SECRET" ] || die "Client Secret が空です"

printf '初期管理者のメールアドレス (Discord に登録済みのもの、空欄可): '
read -r ADMIN_EMAIL

# Rewrite in place, preserving everything else. Adds the key if absent.
set_env() {
  local key=$1 value=$2
  if grep -qE "^${key}=" "$ENV_FILE"; then
    # `value` can contain / and & — use a control character as the delimiter.
    sed -i "s\001^${key}=.*\001${key}=${value}\001" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$value" >> "$ENV_FILE"
  fi
}

log ".env を更新しています"
cp -a "$ENV_FILE" "${ENV_FILE}.bak.$(date +%Y%m%d-%H%M%S)"
set_env DISCORD_CLIENT_ID "$CLIENT_ID"
set_env DISCORD_CLIENT_SECRET "$CLIENT_SECRET"
[ -n "$ADMIN_EMAIL" ] && set_env BOOTSTRAP_ADMIN_EMAIL "$ADMIN_EMAIL"
unset CLIENT_SECRET

chown dwm:dwm "$ENV_FILE"
chmod 600 "$ENV_FILE"
chmod 600 "${ENV_FILE}".bak.* 2>/dev/null || true

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
echo " 動作確認できたら、管理者ページから「緊急用パスワードログイン」を"
echo " 無効にすることをおすすめします。"
echo "────────────────────────────────────────────────────────────────────"
