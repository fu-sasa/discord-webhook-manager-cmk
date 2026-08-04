#!/usr/bin/env bash
# Pull the latest code, rebuild and restart. Run as root on the server.
set -euo pipefail

APP_DIR=/opt/dwm
SERVICE=discord-webhook-manager

[ "$(id -u)" -eq 0 ] || { echo "root で実行してください" >&2; exit 1; }

cd "$APP_DIR"
echo "==> 更新前バックアップ"
./deploy/backup.sh || echo "（バックアップに失敗しましたが続行します）"

echo "==> git pull"
git pull --ff-only

echo "==> 依存関係とビルド"
npm ci --no-audit --no-fund
npm run build
npm prune --omit=dev --no-audit --no-fund
chown -R root:root "$APP_DIR"
chown dwm:dwm "$APP_DIR/.env"

echo "==> 再起動"
systemctl restart "$SERVICE"
sleep 3
systemctl is-active --quiet "$SERVICE" || { systemctl status "$SERVICE" --no-pager -l; exit 1; }
curl -fsS http://127.0.0.1:8080/healthz && echo
echo "==> 完了"
