# IRONLOG no Proxmox (LXC) + Nginx Proxy Manager

```
Internet ──443──▶ NPM (SSL, Let's Encrypt) ──http──▶ LXC "ironlog" :3000 (Node 24 + SQLite)
                                                      ├─ app (PWA) + catálogo de exercícios
                                                      ├─ API: passkeys, convites, sincronização, avisos push
                                                      └─ /admin (somente administradores)
```

O servidor é **uma LXC pequena** (1 vCPU, 512 MB, 4 GB de disco bastam para ~10 usuários). O banco é um único arquivo SQLite em `/var/lib/ironlog/ironlog.db`.

## 1. Criar a LXC (no host Proxmox)

```bash
pveam update
pveam available --section system | grep debian-13        # anote o nome exato do template
pveam download local debian-13-standard_<VERSAO>_amd64.tar.zst

pct create 210 local:vztmpl/debian-13-standard_<VERSAO>_amd64.tar.zst \
  --hostname ironlog --ostype debian --unprivileged 1 --features nesting=1 \
  --cores 1 --memory 512 --swap 256 --rootfs local-lvm:4 \
  --net0 name=eth0,bridge=vmbr0,ip=192.168.1.50/24,gw=192.168.1.1 \
  --nameserver 1.1.1.1 --onboot 1 --start 1
```

Ajuste o ID (`210`), o storage (`local-lvm`) e a rede. Use **IP fixo** (o NPM aponta para ele). `nesting=1` permite o endurecimento do systemd.

## 2. Instalar o IRONLOG

Copie o pacote para a LXC e instale (como root dentro da LXC):

```bash
# no host Proxmox:
pct push 210 ironlog-release.tar.gz /root/ironlog-release.tar.gz

# dentro da LXC (pct enter 210):
cd /root && tar xzf ironlog-release.tar.gz && cd ironlog
./deploy/install.sh --origin https://ironlog.edge.seg.br --bind 192.168.1.50
```

O script instala o Node 24 (repositório oficial NodeSource; o Node do Debian 13 é o 20, sem suporte), cria o usuário `ironlog`, instala as dependências, grava `/etc/ironlog/ironlog.env`, ativa o serviço e o **backup diário**, e testa `/api/health`.

> **O domínio não pode mudar depois.** A passkey fica presa ao domínio (`RP ID`). Trocar `ORIGIN` invalida todas as passkeys.

## 3. Proxy Host no Nginx Proxy Manager

| Aba | Campo | Valor |
|---|---|---|
| Details | Domain Names | `ironlog.edge.seg.br` |
| | Scheme / Forward Host / Port | `http` / `192.168.1.50` / `3000` |
| | Block Common Exploits | ligado |
| | Cache Assets / Websockets | desligados (não precisa) |
| SSL | SSL Certificate | *Request a new SSL Certificate* (Let's Encrypt) |
| | Force SSL, HTTP/2, HSTS | ligados |
| Advanced | Custom Nginx Configuration | `client_max_body_size 6m;` |

Pré-requisitos: registro DNS (`A`/`AAAA`) de `ironlog.edge.seg.br` para o IP público do NPM e portas 80/443 encaminhadas até ele (ou validação DNS-01).

**Restrinja a porta 3000** para aceitar conexões só do IP do NPM (firewall do Proxmox na LXC: *Datacenter → Firewall* ou *LXC → Firewall*, regra `IN ACCEPT TCP dport 3000 source <IP-do-NPM>` e depois `IN DROP`). O servidor confia no `X-Forwarded-For` do NPM, então ele não deve ficar acessível a outras máquinas.

Teste: `https://ironlog.edge.seg.br/api/health` deve responder `{"ok":true,...}`.

## 4. Primeiro administrador

Dentro da LXC:

```bash
ironlogctl bootstrap-admin "Seu Nome"
```

Abra o link impresso **no celular**, toque em *Criar passkey* e confirme com biometria/PIN. O link é de uso único e vale 24 h. Depois acesse `https://ironlog.edge.seg.br/admin`.

O `/admin` só existe para administradores logados (para os demais responde 404). Não há endpoint aberto para criar contas: **toda conta nasce de um convite**.

## 5. Dia a dia

| Tarefa | Como |
|---|---|
| Convidar alguém | `/admin` → *Convites* → nome → *Gerar convite* → copiar/compartilhar o link (uso único) |
| Pessoa perdeu o celular | `/admin` → usuário → *Remover* a passkey perdida → *Convite de recuperação* → enviar o link |
| Segundo aparelho | No app: *Ajustes → Conta → Adicionar outro aparelho* (gera um link de 15 min) |
| Bloquear alguém | `/admin` → *Desativar* (as sessões caem na hora) |
| Ver o que aconteceu | `/admin` → *Auditoria* |
| Sem acesso ao navegador | `ironlogctl invite "Nome"`, `ironlogctl recover "Nome"`, `ironlogctl users` |
| Logs | `journalctl -u ironlog -f` |

Cada conta tem no máximo **2 passkeys** (configurável por `MAX_PASSKEYS`).

## 6. Backup e restauração

O backup roda sozinho **todo dia às 03:30** (`ironlog-backup.timer`): usa a API de backup do SQLite (consistente mesmo com o servidor escrevendo), confere `PRAGMA integrity_check`, gera `.sha256`, mantém 14 diários e 8 semanais (domingo) em `/var/backups/ironlog`.

```bash
systemctl list-timers ironlog-backup.timer                 # próximo horário
systemctl start ironlog-backup.service                     # rodar agora
journalctl -u ironlog-backup -n 10 --no-pager              # resultado
ls -lh /var/backups/ironlog/daily/
```

**Restaurar** (como root; o banco atual é preservado como `.pre-restore.<timestamp>`):

```bash
/opt/ironlog/deploy/restore.sh /var/backups/ironlog/daily/ironlog-AAAAMMDD-HHMMSS.db.gz
```

**Cópia para fora da LXC** (recomendado: a LXC e o backup moram no mesmo disco). Defina em `/etc/ironlog/ironlog.env`:

```
REMOTE_COPY=usuario@servidor-de-backup:/pasta/ironlog/
```

(exige `rsync` e chave SSH do usuário `ironlog`; ou use *Backup* do Proxmox/PBS para a LXC inteira.)

## 7. Atualizar

```bash
# copie o pacote novo para a LXC, extraia e:
cd /root/ironlog && ./deploy/update.sh
```

Faz backup, troca o código, reinstala dependências e reinicia. Configuração e dados ficam intocados. O navegador atualiza o app sozinho (o service worker renova o cache a cada versão).

## 8. Avisos no celular ("já terminou o treino?")

O servidor dispara uma notificação push mesmo com o app fechado, e repete a cada 30 min (até 4 vezes) enquanto o treino não for encerrado. Para funcionar:

- Em **Ajustes → Conta → Avisos no celular**, toque em *Ativar* e permita as notificações. Use *Testar aviso* para conferir.
- **Brave:** ele bloqueia push por padrão. Ative *Usar serviços do Google para mensagens push* em `brave://settings/privacy` (ou use o Chrome).
- **iPhone:** só funciona com o app instalado na tela de início (iOS 16.4+).
- Vibração e som seguem as configurações de notificação do Android para o app.

## 9. Segurança (resumo)

- Sem senhas: login só por **passkey** (biometria/PIN do aparelho obrigatória).
- Cadastro só com **convite de uso único**; o token não é guardado em claro (só o hash).
- Sessão em cookie `HttpOnly; Secure; SameSite=Lax`; escritas exigem cabeçalho próprio e `Origin` do site (anti-CSRF).
- Limite de tentativas em login, convites e avisos; auditoria de eventos sensíveis.
- Serviço sem privilégios, com sistema de arquivos somente leitura exceto `/var/lib/ironlog`.
- O app (HTML/JS) é público; **os dados** só saem para quem está autenticado, e cada usuário só vê os próprios.

## 10. Problemas comuns

| Sintoma | Causa provável / solução |
|---|---|
| `systemctl status ironlog` mostra `226/NAMESPACE` | LXC sem `nesting=1`, ou comente as linhas `Protect*`/`Private*` da unit |
| Login: "O navegador recusou" | Endereço diferente do `ORIGIN` (precisa ser HTTPS e idêntico) |
| 502 no NPM | Serviço parado (`systemctl status ironlog`) ou `HOST` do env diferente do IP que o NPM usa |
| Todos os cadastros "somem" após trocar domínio | Passkeys são presas ao domínio; volte o `ORIGIN` ou gere novos convites |
| Aviso de treino não chega | Veja a seção 8 (Brave/permissão); *Testar aviso* mostra o erro |
| `npm ci` falha ao baixar o SQLite | O `install.sh` instala o compilador e tenta de novo sozinho |
