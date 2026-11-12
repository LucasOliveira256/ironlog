#!/usr/bin/env node
// Administração pelo console da LXC:  ironlogctl <comando>
import { loadConfig } from './config.js';
import { openDb, audit, getMeta } from './db.js';
import { now, uuid, sha256, token, HOUR } from './util.js';

const cfg = loadConfig(); const db = openDb(cfg.dbFile);
const [cmd, ...rest] = process.argv.slice(2);
const flag = (n, d) => { const i = rest.indexOf('--' + n); if (i < 0) return d; const v = rest[i + 1]; rest.splice(i, v && !v.startsWith('--') ? 2 : 1); return v && !v.startsWith('--') ? v : true; };
const hours = Number(flag('hours', 0)) || null, force = !!flag('force', false), asAdmin = !!flag('admin', false);
const name = rest.join(' ').trim();

function makeInvite({ label, role, userId, h }) {
  const raw = token(32), t = now(), ttl = (h || cfg.inviteHours) * HOUR;
  db.prepare('INSERT INTO invites(id,token_hash,label,role,user_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)').run(uuid(), sha256(raw), label, role, userId || null, null, t, t + ttl);
  audit(db, null, userId ? 'invite.recovery.cli' : 'invite.created.cli', userId || label, null, { role });
  console.log(`\nConvite criado para: ${label}${role === 'admin' ? ' (ADMINISTRADOR)' : ''}\nVálido até: ${new Date(t + ttl).toLocaleString('pt-BR')}\nUso único. Abra no celular:\n\n  ${cfg.origin}/?invite=${raw}\n`);
}
const findUser = q => db.prepare('SELECT * FROM users WHERE id=? OR name=? COLLATE NOCASE').get(q, q);

switch (cmd) {
  case 'bootstrap-admin': {
    if (!name) { console.error('Uso: ironlogctl bootstrap-admin "Seu Nome" [--hours 24]'); process.exit(2); }
    const n = db.prepare("SELECT COUNT(*) FROM users WHERE role='admin'").pluck().get();
    if (n && !force) { console.error(`Já existe ${n} administrador. Para criar outro convite de admin use --force.`); process.exit(1); }
    makeInvite({ label: name, role: 'admin', h: hours || 24 }); break;
  }
  case 'invite':
    if (!name) { console.error('Uso: ironlogctl invite "Nome" [--hours 72] [--admin]'); process.exit(2); }
    makeInvite({ label: name, role: asAdmin ? 'admin' : 'user', h: hours }); break;
  case 'recover': {
    const u = findUser(name); if (!u) { console.error('Usuário não encontrado: ' + name); process.exit(1); }
    makeInvite({ label: u.name, role: u.role, userId: u.id, h: hours || 24 });
    console.log(`Se ${u.name} já tem ${cfg.maxPasskeys} passkeys, remova a perdida no painel /admin antes de usar o convite.`); break;
  }
  case 'users': {
    for (const u of db.prepare('SELECT u.*, (SELECT COUNT(*) FROM credentials c WHERE c.user_id=u.id) p FROM users u ORDER BY created_at').all())
      console.log(`${u.role.padEnd(5)} ${u.disabled ? 'DESATIVADO ' : '           '}${u.name.padEnd(24)} passkeys:${u.p}  último acesso: ${u.last_seen_at ? new Date(u.last_seen_at).toLocaleString('pt-BR') : '—'}  ${u.id}`);
    break;
  }
  case 'revoke-sessions': {
    const u = findUser(name); if (!u) { console.error('Usuário não encontrado'); process.exit(1); }
    console.log('Sessões revogadas:', db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id).changes); break;
  }
  case 'vapid': { const v = getMeta(db, 'vapid'); console.log(v ? JSON.parse(v).publicKey : '(será gerada na primeira execução do servidor)'); break; }
  default:
    console.log(`IRONLOG — comandos:
  bootstrap-admin "Nome" [--hours 24] [--force]   cria o convite do primeiro administrador
  invite "Nome" [--hours 72] [--admin]            convite para novo usuário
  recover "Nome|id" [--hours 24]                  convite para nova passkey de quem perdeu o aparelho
  users                                           lista usuários
  revoke-sessions "Nome|id"                       derruba todas as sessões do usuário
  vapid                                           chave pública do push`);
}
db.close();
