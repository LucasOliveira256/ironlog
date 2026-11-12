#!/usr/bin/env bash
# Instalação do IRONLOG numa LXC Debian 13. Executar como root, de dentro da pasta extraída do pacote:
#   tar xzf ironlog-release.tar.gz && cd ironlog && ./deploy/install.sh [--bind IP] [--origin https://dominio]
set -euo pipefail

ORIGIN="https://ironlog.edge.seg.br"; BIND=""; NODE_MAJOR=24
while [ $# -gt 0 ]; do case "$1" in
  --origin) ORIGIN="${2:?}"; shift 2;;
  --bind)   BIND="${2:?}"; shift 2;;
  --node)   NODE_MAJOR="${2:?}"; shift 2;;
  *) echo "Opção desconhecida: $1"; exit 2;;
esac; done

[ "$(id -u)" = 0 ] || { echo "Execute como root."; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
[ -f "$SRC/src/server.js" ] && [ -f "$SRC/package.json" ] || { echo "Rode de dentro do pacote (faltam src/ e package.json)."; exit 1; }
say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }

. /etc/os-release
[ "${ID:-}" = "debian" ] || echo "AVISO: testado no Debian 13; sistema detectado: ${PRETTY_NAME:-?}"

say "Pacotes base"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg sqlite3 rsync sudo >/dev/null

say "Node.js ${NODE_MAJOR} (repositório oficial NodeSource; o do Debian 13 é o 20, já sem suporte)"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 22 ]; then
  install -d -m 0755 /etc/apt/keyrings
  curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key | gpg --dearmor --yes -o /etc/apt/keyrings/nodesource.gpg
  echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_${NODE_MAJOR}.x nodistro main" > /etc/apt/sources.list.d/nodesource.list
  apt-get update -qq && apt-get install -y -qq nodejs >/dev/null
fi
echo "node $(node -v)"

say "Usuário e pastas"
id ironlog >/dev/null 2>&1 || useradd --system --home-dir /var/lib/ironlog --shell /usr/sbin/nologin ironlog
install -d -o ironlog -g ironlog -m 0750 /var/lib/ironlog /var/backups/ironlog
install -d -o root -g ironlog -m 0750 /etc/ironlog
install -d -o root -g root -m 0755 /opt/ironlog

say "Aplicativo em /opt/ironlog"
rsync -a --delete --exclude node_modules --exclude '.git' "$SRC/" /opt/ironlog/
chown -R root:root /opt/ironlog
chmod +x /opt/ironlog/deploy/*.sh /opt/ironlog/deploy/ironlogctl
cd /opt/ironlog
if ! npm ci --omit=dev --no-audit --no-fund; then
  echo "Binário pronto do SQLite indisponível; instalando compilador e tentando de novo…"
  apt-get install -y -qq build-essential python3 >/dev/null
  npm ci --omit=dev --no-audit --no-fund
fi

say "Configuração (/etc/ironlog/ironlog.env)"
if [ ! -f /etc/ironlog/ironlog.env ]; then
  [ -n "$BIND" ] || BIND="$(hostname -I | awk '{print $1}')"
  sed -e "s#^ORIGIN=.*#ORIGIN=${ORIGIN}#" -e "s#__BIND_IP__#${BIND}#" /opt/ironlog/deploy/ironlog.env.example > /etc/ironlog/ironlog.env
  chown root:ironlog /etc/ironlog/ironlog.env; chmod 0640 /etc/ironlog/ironlog.env
  echo "criado (ORIGIN=${ORIGIN}, HOST=${BIND})"
else echo "já existe — mantido"; fi

say "Serviços (systemd)"
install -m 0644 /opt/ironlog/deploy/ironlog.service /etc/systemd/system/
install -m 0644 /opt/ironlog/deploy/ironlog-backup.service /opt/ironlog/deploy/ironlog-backup.timer /etc/systemd/system/
install -m 0755 /opt/ironlog/deploy/ironlogctl /usr/local/bin/ironlogctl
systemctl daemon-reload
systemctl enable --now ironlog.service ironlog-backup.timer

say "Verificação"
. /etc/ironlog/ironlog.env
for _ in $(seq 1 20); do
  if curl -fsS "http://${HOST}:${PORT}/api/health" >/dev/null 2>&1; then OK=1; break; fi; sleep 1
done
if [ "${OK:-0}" = 1 ]; then echo "Servidor respondendo em http://${HOST}:${PORT}"; else echo "O servidor não respondeu. Veja: journalctl -u ironlog -n 50 --no-pager"; exit 1; fi

cat <<MSG

Pronto. Próximos passos:

  1) No Nginx Proxy Manager, crie o Proxy Host (veja deploy/README.md):
       ${ORIGIN#https://}  →  http://${HOST}:${PORT}   (SSL + Force SSL)

  2) Crie o primeiro administrador (convite de uso único, válido por 24 h):
       ironlogctl bootstrap-admin "Seu Nome"
     Abra o link no celular e crie a passkey.

  3) Painel de administração (somente admin logado):  ${ORIGIN}/admin

  Backup diário às 03:30:  systemctl list-timers ironlog-backup.timer
  Teste agora:             systemctl start ironlog-backup.service && journalctl -u ironlog-backup -n 5 --no-pager
MSG
