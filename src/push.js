import webpush from 'web-push';
import { getMeta, setMeta } from './db.js';
import { now, uuid, HOUR, bad, conflict } from './util.js';

// Web Push + agendador do aviso "Já terminou o treino?".
// O app informa quando o treino chegaria ao limite (fireAt); o servidor dispara mesmo com o app fechado
// e repete a cada ALERT_SNOOZE_MIN até ALERT_MAX_REPEATS, a menos que o app cancele (treino encerrado).
export function registerPush(app, { pushSender } = {}) {
  const { db, cfg } = app;
  let vapid = getMeta(db, 'vapid'); vapid = vapid ? JSON.parse(vapid) : null;
  if (!vapid) { vapid = webpush.generateVAPIDKeys(); setMeta(db, 'vapid', JSON.stringify(vapid)); }
  const send = pushSender || ((sub, payload, opts) =>
    webpush.sendNotification(sub, payload, { ...opts, vapidDetails: { subject: cfg.vapidSubject, publicKey: vapid.publicKey, privateKey: vapid.privateKey } }));

  async function notifyUser(userId, payload) {
    const subs = db.prepare('SELECT * FROM push_subs WHERE user_id=?').all(userId);
    let sent = 0, removed = 0;
    for (const s of subs) {
      try {
        await send({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
        sent++;
      } catch (e) {
        if (e && (e.statusCode === 404 || e.statusCode === 410)) { db.prepare('DELETE FROM push_subs WHERE id=?').run(s.id); removed++; }
        else app.log.warn({ err: e && e.message }, 'push falhou');
      }
    }
    return { sent, removed, devices: subs.length };
  }
  const ALERT = { type: 'workout-alert', title: 'Já terminou?', body: 'Lembre de encerrar seu treino no app.', url: '/', tag: 'ironlog-alert', vibrate: [400, 150, 400, 150, 800] };

  async function tick(t = now()) {
    const due = db.prepare('SELECT * FROM alerts WHERE fire_at<=?').all(t);
    for (const a of due) {
      const r = await notifyUser(a.user_id, ALERT);
      const repeats = a.repeats + 1;
      // sem aparelho que receba, não adianta repetir
      if (repeats >= cfg.alertMaxRepeats || r.devices === 0) db.prepare('DELETE FROM alerts WHERE user_id=?').run(a.user_id);
      else db.prepare('UPDATE alerts SET fire_at=?, repeats=?, updated_at=? WHERE user_id=?').run(t + cfg.alertSnoozeMin * 60e3, repeats, t, a.user_id);
    }
    return due.length;
  }
  app.decorate('push', { notifyUser, tick, publicKey: vapid.publicKey });

  app.get('/api/push/key', { preHandler: app.requireAuth }, async () => ({ publicKey: vapid.publicKey }));
  app.post('/api/push/subscribe', { preHandler: app.requireAuth }, async req => {
    const s = req.body && req.body.subscription;
    if (!s || typeof s.endpoint !== 'string' || !/^https:\/\//.test(s.endpoint) || s.endpoint.length > 1000 || !s.keys || typeof s.keys.p256dh !== 'string' || typeof s.keys.auth !== 'string') throw bad('Assinatura inválida');
    const n = db.prepare('SELECT COUNT(*) FROM push_subs WHERE user_id=? AND endpoint<>?').pluck().get(req.user.id, s.endpoint);
    if (n >= 10) throw conflict('Muitos dispositivos com aviso ativo');
    db.prepare(`INSERT INTO push_subs(id,user_id,endpoint,p256dh,auth,created_at,ua) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth, ua=excluded.ua`)
      .run(uuid(), req.user.id, s.endpoint, s.keys.p256dh, s.keys.auth, now(), String(req.headers['user-agent'] || '').slice(0, 200));
    return { ok: true };
  });
  app.delete('/api/push/subscribe', { preHandler: app.requireAuth }, async req => {
    db.prepare('DELETE FROM push_subs WHERE user_id=? AND endpoint=?').run(req.user.id, String(req.body?.endpoint || '')); return { ok: true };
  });
  app.put('/api/alert', { preHandler: app.requireAuth }, async req => {
    const f = req.body && req.body.fireAt, t = now();
    if (f === null) { db.prepare('DELETE FROM alerts WHERE user_id=?').run(req.user.id); return { ok: true, armed: false }; }
    if (!Number.isFinite(f) || f < t - 60e3 || f > t + 24 * HOUR) throw bad('Horário do aviso inválido');
    db.prepare(`INSERT INTO alerts(user_id,fire_at,repeats,updated_at) VALUES(?,?,0,?)
      ON CONFLICT(user_id) DO UPDATE SET fire_at=excluded.fire_at, repeats=0, updated_at=excluded.updated_at`).run(req.user.id, Math.floor(f), t);
    return { ok: true, armed: true };
  });
  app.post('/api/alert/test', { preHandler: app.requireAuth, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async req => {
    const r = await notifyUser(req.user.id, { type: 'test', title: 'IRONLOG', body: 'Aviso de teste: está funcionando! 💪', url: '/', tag: 'ironlog-test', vibrate: [300, 100, 300] });
    if (!r.devices) throw conflict('Nenhum dispositivo registrado para avisos');
    return r;
  });
}
