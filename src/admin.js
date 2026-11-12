import { audit } from './db.js';
import { now, uuid, sha256, token, HOUR, bad, forbidden, notFound, conflict } from './util.js';
import fs from 'node:fs';

export function registerAdmin(app) {
  const { db, cfg } = app;
  const A = { preHandler: app.requireAdmin };
  const log = (req, action, target, detail) => audit(db, req.user.id, action, target, req.ip, detail);
  const adminsLeft = exceptId => db.prepare("SELECT COUNT(*) FROM users WHERE role='admin' AND disabled=0 AND id<>?").pluck().get(exceptId || '');

  app.get('/api/admin/overview', A, async () => {
    const t = now();
    const users = db.prepare(`SELECT u.id,u.name,u.role,u.disabled,u.created_at,u.last_seen_at,
      (SELECT COUNT(*) FROM credentials c WHERE c.user_id=u.id) AS passkeys,
      (SELECT COUNT(*) FROM records r WHERE r.user_id=u.id AND r.deleted=0) AS records,
      (SELECT COALESCE(SUM(LENGTH(data)),0) FROM records r WHERE r.user_id=u.id) AS bytes,
      (SELECT COUNT(*) FROM push_subs p WHERE p.user_id=u.id) AS push,
      (SELECT COUNT(*) FROM sessions s WHERE s.user_id=u.id AND s.expires_at>?) AS sessions
      FROM users u ORDER BY u.created_at`).all(t).map(u => ({
      id: u.id, name: u.name, role: u.role, disabled: !!u.disabled, createdAt: u.created_at, lastSeenAt: u.last_seen_at,
      passkeys: u.passkeys, records: u.records, bytes: u.bytes, push: u.push, sessions: u.sessions,
      credentials: db.prepare('SELECT id,label,device_type,backed_up,created_at,last_used_at FROM credentials WHERE user_id=? ORDER BY created_at').all(u.id)
        .map(c => ({ id: c.id, label: c.label, deviceType: c.device_type, backedUp: !!c.backed_up, createdAt: c.created_at, lastUsedAt: c.last_used_at }))
    }));
    const invites = db.prepare(`SELECT i.id,i.label,i.role,i.user_id,i.created_at,i.expires_at,i.used_at,i.revoked_at,u.name AS user_name
      FROM invites i LEFT JOIN users u ON u.id=i.user_id ORDER BY i.created_at DESC LIMIT 100`).all().map(i => ({
      id: i.id, label: i.label, role: i.role, userId: i.user_id, userName: i.user_name, createdAt: i.created_at, expiresAt: i.expires_at,
      status: i.revoked_at ? 'revogado' : i.used_at ? 'usado' : i.expires_at < t ? 'expirado' : 'pendente' }));
    let dbSize = 0; try { dbSize = fs.statSync(cfg.dbFile).size; } catch (_) {}
    return { users, invites, dbSize, maxPasskeys: cfg.maxPasskeys, serverTime: t };
  });

  app.post('/api/admin/invites', A, async req => {
    const { label, role = 'user', userId = null } = req.body || {};
    const hours = Math.min(Math.max(Number(req.body?.hours) || cfg.inviteHours, 1), 24 * 14);
    if (!['user', 'admin'].includes(role)) throw bad('Papel inválido');
    let lbl = String(label || '').trim().slice(0, 60);
    if (userId) { const u = db.prepare('SELECT name FROM users WHERE id=?').get(userId); if (!u) throw notFound('Usuário não existe'); lbl = lbl || u.name; }
    if (!lbl) throw bad('Informe um nome para o convite');
    const raw = token(32), id = uuid(), t = now();
    db.prepare('INSERT INTO invites(id,token_hash,label,role,user_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id, sha256(raw), lbl, userId ? 'user' : role, userId, req.user.id, t, t + hours * HOUR);
    log(req, userId ? 'invite.recovery' : 'invite.created', userId || id, { label: lbl, role, hours });
    return { id, token: raw, url: `${cfg.origin}/?invite=${raw}`, expiresAt: t + hours * HOUR };   // o token só aparece agora
  });
  app.delete('/api/admin/invites/:id', A, async req => {
    const r = db.prepare('UPDATE invites SET revoked_at=? WHERE id=? AND used_at IS NULL AND revoked_at IS NULL').run(now(), req.params.id);
    if (!r.changes) throw notFound('Convite não encontrado ou já usado'); log(req, 'invite.revoked', req.params.id); return { ok: true };
  });

  const userOr404 = id => db.prepare('SELECT * FROM users WHERE id=?').get(id) || (() => { throw notFound('Usuário não encontrado'); })();
  app.post('/api/admin/users/:id/disable', A, async req => {
    const u = userOr404(req.params.id);
    if (u.id === req.user.id) throw forbidden('Você não pode desativar a si mesmo');
    if (u.role === 'admin' && !adminsLeft(u.id)) throw conflict('Precisa existir ao menos um administrador ativo');
    db.prepare('UPDATE users SET disabled=1 WHERE id=?').run(u.id); db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id);
    db.prepare('DELETE FROM alerts WHERE user_id=?').run(u.id); log(req, 'user.disabled', u.id); return { ok: true };
  });
  app.post('/api/admin/users/:id/enable', A, async req => { const u = userOr404(req.params.id); db.prepare('UPDATE users SET disabled=0 WHERE id=?').run(u.id); log(req, 'user.enabled', u.id); return { ok: true }; });
  app.post('/api/admin/users/:id/role', A, async req => {
    const u = userOr404(req.params.id), role = req.body?.role; if (!['user', 'admin'].includes(role)) throw bad('Papel inválido');
    if (u.role === 'admin' && role === 'user' && !adminsLeft(u.id)) throw conflict('Precisa existir ao menos um administrador ativo');
    db.prepare('UPDATE users SET role=? WHERE id=?').run(role, u.id); log(req, 'user.role', u.id, { role }); return { ok: true };
  });
  app.post('/api/admin/users/:id/revoke-sessions', A, async req => {
    const u = userOr404(req.params.id); const r = db.prepare('DELETE FROM sessions WHERE user_id=?').run(u.id); log(req, 'user.sessions.revoked', u.id); return { revoked: r.changes };
  });
  app.delete('/api/admin/users/:id/passkeys/:cid', A, async req => {
    const u = userOr404(req.params.id);
    const r = db.prepare('DELETE FROM credentials WHERE id=? AND user_id=?').run(req.params.cid, u.id); if (!r.changes) throw notFound('Passkey não encontrada');
    log(req, 'passkey.removed.admin', u.id); return { ok: true };
  });
  app.delete('/api/admin/users/:id', A, async req => {
    const u = userOr404(req.params.id);
    if (u.id === req.user.id) throw forbidden('Você não pode apagar a si mesmo');
    if (u.role === 'admin' && !adminsLeft(u.id)) throw conflict('Precisa existir ao menos um administrador ativo');
    if ((req.body && req.body.confirm) !== u.name) throw bad('Digite o nome exato do usuário para confirmar');
    db.prepare('DELETE FROM users WHERE id=?').run(u.id); log(req, 'user.deleted', u.id, { name: u.name }); return { ok: true };
  });
  app.get('/api/admin/users/:id/export', A, async (req, reply) => {
    const u = userOr404(req.params.id);
    const recs = db.prepare('SELECT coll,key,data,updated_at,deleted FROM records WHERE user_id=? ORDER BY seq').all(u.id)
      .map(r => ({ coll: r.coll, key: r.key, data: r.deleted ? null : JSON.parse(r.data), updatedAt: r.updated_at, deleted: !!r.deleted }));
    log(req, 'user.exported', u.id);
    reply.header('content-disposition', `attachment; filename="ironlog-${u.name.replace(/[^\w-]+/g, '_')}.json"`);
    return { user: { id: u.id, name: u.name }, exportedAt: now(), records: recs };
  });
  app.get('/api/admin/audit', A, async req => {
    const n = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), 500);
    return { rows: db.prepare(`SELECT a.ts,a.action,a.ip,a.detail,a.target,u.name AS actor FROM audit a LEFT JOIN users u ON u.id=a.actor ORDER BY a.id DESC LIMIT ?`).all(n) };
  });
}
