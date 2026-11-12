import { now, DAY, bad, HttpError } from './util.js';

// Sincronização por registro, "última escrita vence" (updatedAt). Só estas coleções sincronizam;
// a sessão em andamento (cronômetros) é do aparelho e NUNCA sobe.
export const SYNC_COLLS = new Set(['history', 'weight', 'measure', 'kv:workout', 'kv:settings', 'kv:goals', 'kv:customEx']);
const MAX_ITEM = 600 * 1024, MAX_CHANGES = 2000, PAGE = 500;

export function registerSync(app) {
  const { db, cfg } = app;
  const quota = cfg.userQuotaBytes || 50 * 1024 * 1024;

  app.get('/api/sync', { preHandler: app.requireAuth }, async req => {
    const since = Math.max(0, parseInt(req.query.since, 10) || 0);
    const rows = db.prepare('SELECT coll,key,data,updated_at,deleted,seq FROM records WHERE user_id=? AND seq>? ORDER BY seq LIMIT ?').all(req.user.id, since, PAGE + 1);
    const more = rows.length > PAGE; if (more) rows.length = PAGE;
    return {
      changes: rows.map(r => ({ coll: r.coll, key: r.key, data: r.deleted ? null : JSON.parse(r.data), updatedAt: r.updated_at, deleted: !!r.deleted, seq: r.seq })),
      more, seq: db.prepare('SELECT seq FROM users WHERE id=?').pluck().get(req.user.id)
    };
  });

  app.post('/api/sync', { preHandler: app.requireAuth }, async req => {
    const list = req.body && req.body.changes;
    if (!Array.isArray(list) || list.length > MAX_CHANGES) throw bad('Lote inválido');
    const uid = req.user.id, t = now(), rejected = [];
    let applied = 0;
    const used = db.prepare('SELECT COALESCE(SUM(LENGTH(data)),0) FROM records WHERE user_id=?').pluck().get(uid);
    let incoming = 0;
    const items = list.map(c => {
      if (!c || !SYNC_COLLS.has(c.coll) || typeof c.key !== 'string' || !c.key || c.key.length > 200 || !Number.isFinite(c.updatedAt)) throw bad('Registro inválido');
      const deleted = !!c.deleted; let json = null;
      if (!deleted) { json = JSON.stringify(c.data); if (json === undefined || json.length > MAX_ITEM) throw bad('Registro grande demais'); incoming += json.length; }
      return { coll: c.coll, key: c.key, json, deleted, updatedAt: Math.min(Math.floor(c.updatedAt), t + DAY) };
    });
    if (used + incoming > quota) throw new HttpError(413, 'Cota de armazenamento excedida');
    const get = db.prepare('SELECT updated_at FROM records WHERE user_id=? AND coll=? AND key=?');
    const up = db.prepare(`INSERT INTO records(user_id,coll,key,data,updated_at,deleted,seq) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(user_id,coll,key) DO UPDATE SET data=excluded.data, updated_at=excluded.updated_at, deleted=excluded.deleted, seq=excluded.seq`);
    const bump = db.prepare('UPDATE users SET seq=seq+1 WHERE id=? RETURNING seq').pluck();
    db.transaction(() => {
      for (const c of items) {
        const ex = get.get(uid, c.coll, c.key);
        if (ex && ex.updated_at > c.updatedAt) { rejected.push({ coll: c.coll, key: c.key, reason: 'newer' }); continue; }
        up.run(uid, c.coll, c.key, c.json, c.updatedAt, c.deleted ? 1 : 0, bump.get(uid)); applied++;
      }
    })();
    return { applied, rejected, seq: db.prepare('SELECT seq FROM users WHERE id=?').pluck().get(uid) };
  });
}
