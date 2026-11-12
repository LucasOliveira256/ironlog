#!/usr/bin/env bash
# Backup consistente do SQLite (sem parar o serviço), com verificação, rotação e cópia opcional.
# Uso: backup.sh            (lê as variáveis de /etc/ironlog/ironlog.env via systemd)
set -euo pipefail
umask 077

DB="${DB_FILE:-${DATA_DIR:-/var/lib/ironlog}/ironlog.db}"
DEST="${BACKUP_DIR:-/var/backups/ironlog}"
KEEP_DAYS="${KEEP_DAYS:-14}"
KEEP_WEEKS="${KEEP_WEEKS:-8}"
STAMP="$(date +%Y%m%d-%H%M%S)"

log() { echo "[backup] $*"; }
[ -f "$DB" ] || { log "ERRO: banco não encontrado em $DB"; exit 1; }
command -v sqlite3 >/dev/null || { log "ERRO: instale o pacote sqlite3"; exit 1; }
mkdir -p "$DEST/daily" "$DEST/weekly"

TMP="$(mktemp "$DEST/.tmp-XXXXXX.db")"
trap 'rm -f "$TMP" "$TMP.gz"' EXIT

# .backup usa a API de backup online do SQLite: gera uma cópia íntegra mesmo com o servidor escrevendo
sqlite3 "$DB" ".timeout 10000" ".backup '$TMP'"

# só aceita o backup se o banco copiado estiver íntegro
CHECK="$(sqlite3 "$TMP" 'PRAGMA integrity_check;')"
if [ "$CHECK" != "ok" ]; then log "ERRO: integrity_check falhou: $CHECK"; exit 1; fi
USERS="$(sqlite3 "$TMP" 'SELECT COUNT(*) FROM users;' 2>/dev/null || echo '?')"

OUT="$DEST/daily/ironlog-$STAMP.db.gz"
gzip -9 -c "$TMP" > "$OUT.part"
( cd "$DEST/daily" && sha256sum "ironlog-$STAMP.db.gz.part" | sed "s/\.part//" > "ironlog-$STAMP.db.gz.sha256" )
mv "$OUT.part" "$OUT"
log "ok: $OUT ($(du -h "$OUT" | cut -f1), $USERS usuário(s))"

# domingo: guarda também na pasta semanal
if [ "$(date +%u)" = "7" ]; then
  cp -p "$OUT" "$DEST/weekly/" && cp -p "$OUT.sha256" "$DEST/weekly/"
  log "cópia semanal guardada"
fi

# rotação
find "$DEST/daily"  -type f -name 'ironlog-*' -mtime +"$KEEP_DAYS"          -delete
find "$DEST/weekly" -type f -name 'ironlog-*' -mtime +"$((KEEP_WEEKS * 7))" -delete

# cópia extra (opcional): REMOTE_COPY=usuario@host:/pasta/
if [ -n "${REMOTE_COPY:-}" ]; then
  if command -v rsync >/dev/null; then rsync -a --delete-after "$DEST/" "$REMOTE_COPY" && log "cópia remota ok" || log "AVISO: cópia remota falhou"
  else log "AVISO: rsync não instalado; cópia remota ignorada"; fi
fi
