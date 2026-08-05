#!/usr/bin/env bash
# Consistent online backup of the SQLite database, keeping 14 days of history.
# `VACUUM INTO` is safe to run against a live WAL database.
set -euo pipefail

# Run from a directory the service user can always read. Invoked manually as
# `sudo -u dwm .../backup.sh` from /root, the retention `find` below otherwise
# dies with "Failed to restore initial working directory".
cd /

DB=${DWM_DB:-/var/lib/dwm/dwm.db}
DEST=${DWM_BACKUP_DIR:-/var/backups/dwm}
KEEP_DAYS=${DWM_BACKUP_KEEP_DAYS:-14}

mkdir -p "$DEST"
STAMP=$(date +%Y%m%d-%H%M%S)
OUT="$DEST/dwm-$STAMP.db"

sqlite3 "$DB" "VACUUM INTO '$OUT'"
gzip -f "$OUT"
echo "backup written: $OUT.gz"

find "$DEST" -name 'dwm-*.db.gz' -mtime "+$KEEP_DAYS" -delete
