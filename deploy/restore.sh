#!/usr/bin/env bash
# Restaura um backup:  restore.sh /var/backups/ironlog/daily/ironlog-AAAAMMDD-HHMMSS.db.gz
# Executar como root dentro da LXC. O banco atual é guardado como .pre-restore.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Execute como root."; exit 1; }
FILE="${1:-}"; [ -f "$FILE" ] || { echo "Uso: $0 <arquivo .db.gz>"; exit 2; }
DB="${DB_FILE:-/var/lib/ironlog/ironlog.db}"

if [ -f "$FILE.sha256" ]; then ( cd "$(dirname "$FILE")" && sha256sum -c "$(basename "$FILE").sha256" ) || { echo "Checksum não confere. Abortando."; exit 1; }; fi
TMP="$(mktemp /tmp/ironlog-restore-XXXXXX.db)"; trap 'rm -f "$TMP"' EXIT
gunzip -c "$FILE" > "$TMP"
[ "$(sqlite3 "$TMP" 'PRAGMA integrity_check;')" = "ok" ] || { echo "Backup corrompido. Abortando."; exit 1; }
echo "Backup íntegro: $(sqlite3 "$TMP" 'SELECT COUNT(*) FROM users;') usuário(s)."

systemctl stop ironlog.service
if [ -f "$DB" ]; then mv "$DB" "$DB.pre-restore.$(date +%s)"; fi
rm -f "$DB-wal" "$DB-shm"
install -o ironlog -g ironlog -m 0600 "$TMP" "$DB"
systemctl start ironlog.service
sleep 2; systemctl is-active --quiet ironlog.service && echo "Restaurado e em execução." || { echo "O serviço não subiu: journalctl -u ironlog -n 50"; exit 1; }
