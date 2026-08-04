#!/usr/bin/env bash
# Add a SECOND Cloudflare Tunnel connector to this host, for a zone that lives in
# a different Cloudflare account than the existing tunnel.
#
# Why not just swap the token: this host's SSH access is proxied by the existing
# `cloudflared.service`. Replacing its token tears down that route and locks you
# out. Two connectors run side by side without interfering — each is an outbound
# connection to its own account.
#
# Usage (token is read from stdin so it never lands in shell history):
#   sudo /opt/dwm/deploy/add-tunnel.sh uslog
#   <paste the token, press Enter>
set -euo pipefail

NAME=${1:-uslog}
UNIT="cloudflared-${NAME}"
TOKEN_FILE="/etc/cloudflared/token-${NAME}"
METRICS=${METRICS:-127.0.0.1:20242}
UNIT_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/${UNIT}.service"

log() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
die() { printf '\033[1;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "root で実行してください (sudo $0 $NAME)"
command -v cloudflared >/dev/null || die "cloudflared が見つかりません"
[ -f "$UNIT_SRC" ] || die "ユニットファイルが見つかりません: $UNIT_SRC"

# Record the pre-existing connector so we can prove we did not disturb it.
PREEXISTING=$(systemctl is-active cloudflared 2>/dev/null || true)
log "既存 cloudflared.service の状態: ${PREEXISTING}（これは変更しません）"

if [ -f "$TOKEN_FILE" ]; then
  log "$TOKEN_FILE は既に存在します。上書きします。"
fi

echo
echo "Cloudflare ダッシュボードで発行したトンネルトークンを貼り付けて Enter を押してください。"
echo "（'eyJ...' で始まる長い文字列。cloudflared install の後ろに出てくる部分だけ）"
printf '> '
read -r TOKEN
[ -n "$TOKEN" ] || die "トークンが空です"

# Validate before writing: a bad token would leave a crash-looping unit behind.
log "トークンを検証しています"
python3 - "$TOKEN" <<'PY' || die "トークンの形式が不正です。貼り付け内容を確認してください。"
import base64, json, sys
raw = sys.argv[1].strip()
raw += '=' * (-len(raw) % 4)
try:
    d = json.loads(base64.urlsafe_b64decode(raw))
except Exception as e:
    print("decode failed:", e)
    sys.exit(1)
missing = [k for k in ("a", "t", "s") if not d.get(k)]
if missing:
    print("missing fields:", missing)
    sys.exit(1)
print("  account tag:", d["a"])
print("  tunnel id  :", d["t"])
PY

install -d -m 0755 /etc/cloudflared
printf '%s' "$TOKEN" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
chown root:root "$TOKEN_FILE"
unset TOKEN

log "systemd ユニットを設置しています (${UNIT})"
install -m 0644 "$UNIT_SRC" "/etc/systemd/system/${UNIT}.service"
systemctl daemon-reload
systemctl enable --now "$UNIT"

sleep 5
if ! systemctl is-active --quiet "$UNIT"; then
  systemctl status "$UNIT" --no-pager -l || true
  die "${UNIT} の起動に失敗しました。上のログを確認してください。"
fi

# The whole point of this script is that the SSH path survives.
NOW=$(systemctl is-active cloudflared 2>/dev/null || true)
if [ "$PREEXISTING" = "active" ] && [ "$NOW" != "active" ]; then
  die "既存 cloudflared.service が停止しました。SSH 経路が失われている可能性があります。"
fi

echo
log "接続状況"
journalctl -u "$UNIT" -n 15 --no-pager -o cat | grep -Ei 'registered|connection|error|failed' || true

echo
echo "────────────────────────────────────────────────────────────────────"
echo " 2本目のコネクタを追加しました"
echo "────────────────────────────────────────────────────────────────────"
echo " 新しいトンネル : ${UNIT}.service  (token: ${TOKEN_FILE})"
echo " 既存トンネル   : cloudflared.service = ${NOW}  ← SSH 経路。触っていません"
echo
echo " 次の作業: Cloudflare ダッシュボードでこの新しいトンネルに"
echo " Public Hostname を追加してください。"
echo "     Subdomain : webhook-manager-cmk"
echo "     Domain    : uslog.tech"
echo "     Type      : HTTP"
echo "     URL       : localhost:8080"
echo "────────────────────────────────────────────────────────────────────"
