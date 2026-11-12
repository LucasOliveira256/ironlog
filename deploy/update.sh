#!/usr/bin/env bash
# Atualiza o IRONLOG a partir de um pacote novo (mantém configuração e dados; faz backup antes).
#   tar xzf ironlog-release.tar.gz && cd ironlog && ./deploy/update.sh
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Execute como root."; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$SRC/src/server.js" ] || { echo "Rode de dentro do pacote."; exit 1; }

echo "==> Backup antes de atualizar"
runuser -u ironlog -- bash -c 'set -a; . /etc/ironlog/ironlog.env; set +a; /opt/ironlog/deploy/backup.sh' || echo "AVISO: backup falhou (primeira instalação?)"

echo "==> Copiando arquivos"
rsync -a --delete --exclude node_modules "$SRC/" /opt/ironlog/
chmod +x /opt/ironlog/deploy/*.sh /opt/ironlog/deploy/ironlogctl
( cd /opt/ironlog && npm ci --omit=dev --no-audit --no-fund )
install -m 0644 /opt/ironlog/deploy/ironlog.service /opt/ironlog/deploy/ironlog-backup.service /opt/ironlog/deploy/ironlog-backup.timer /etc/systemd/system/
systemctl daemon-reload
systemctl restart ironlog.service

. /etc/ironlog/ironlog.env
for _ in $(seq 1 20); do curl -fsS "http://${HOST}:${PORT}/api/health" >/dev/null 2>&1 && { echo "Atualizado e respondendo."; exit 0; }; sleep 1; done
echo "O servidor não respondeu após atualizar. journalctl -u ironlog -n 50"; exit 1
