import {
  generateRegistrationOptions, verifyRegistrationResponse,
  generateAuthenticationOptions, verifyAuthenticationResponse
} from '@simplewebauthn/server';
import { audit } from './db.js';
import { now, uuid, sha256, token, b64u, fromB64u, HOUR, DAY, bad, denied, forbidden, conflict, notFound } from './util.js';

export const COOKIE = 'ironlog_sid';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const CHALLENGE_TTL = 5 * 60e3;
const authLimit = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
const inviteLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

export function registerAuth(app) {
  const { db, cfg } = app;

  // ── sessão ──
  app.decorateRequest('user', null);
  app.decorateRequest('sidHash', null);
  const setCookie = (reply, raw) => reply.setCookie(COOKIE, raw, {
    httpOnly: true, secure: cfg.secureCookies, sameSite: 'lax', path: '/', maxAge: cfg.sessionDays * 86400
  });
  function createSession(req, reply, userId) {
    const raw = token(32), t = now();
    db.prepare('INSERT INTO sessions(id_hash,user_id,created_at,expires_at,last_seen_at,ua,ip) VALUES(?,?,?,?,?,?,?)')
      .run(sha256(raw), userId, t, t + cfg.sessionDays * DAY, t, String(req.headers['user-agent'] || '').slice(0, 200), req.ip);
    db.prepare('UPDATE users SET last_seen_at=? WHERE id=?').run(t, userId);
    setCookie(reply, raw);
  }
  app.addHook('onRequest', async (req, reply) => {
    // proteção CSRF: toda escrita na API exige cabeçalho próprio e Origin do próprio site
    if (!SAFE.has(req.method) && req.url.startsWith('/api/')) {
      if (req.headers['x-ironlog'] !== '1') throw forbidden('Cabeçalho ausente');
      const o = req.headers.origin; if (o && o !== cfg.origin) throw forbidden('Origem inválida');
    }
    const raw = req.cookies && req.cookies[COOKIE]; if (!raw) return;
    const h = sha256(raw), t = now();
    const r = db.prepare(`SELECT s.last_seen_at AS seen, u.* FROM sessions s JOIN users u ON u.id=s.user_id
                          WHERE s.id_hash=? AND s.expires_at>? AND u.disabled=0`).get(h, t);
    if (!r) { reply.clearCookie(COOKIE, { path: '/' }); return; }
    req.user = { id: r.id, name: r.name, role: r.role }; req.sidHash = h;
    if (t - r.seen > 10 * 60e3) {   // sessão deslizante
      db.prepare('UPDATE sessions SET last_seen_at=?, expires_at=? WHERE id_hash=?').run(t, t + cfg.sessionDays * DAY, h);
      db.prepare('UPDATE users SET last_seen_at=? WHERE id=?').run(t, r.id);
      setCookie(reply, raw);
    }
  });
  app.decorate('requireAuth', async req => { if (!req.user) throw denied('Faça login'); });
  app.decorate('requireAdmin', async req => { if (!req.user) throw denied('Faça login'); if (req.user.role !== 'admin') throw forbidden('Apenas administradores'); });

  // ── convites ──
  function findInvite(rawToken) {
    if (!rawToken || typeof rawToken !== 'string') return null;
    const inv = db.prepare('SELECT * FROM invites WHERE token_hash=?').get(sha256(rawToken.trim()));
    if (!inv || inv.used_at || inv.revoked_at || inv.expires_at < now()) return null;
    return inv;
  }
  const newChallenge = (kind, challenge, extra = {}) => {
    const id = uuid();
    db.prepare('INSERT INTO challenges(id,kind,challenge,user_id,invite_id,name,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, kind, challenge, extra.userId || null, extra.inviteId || null, extra.name || null, now() + CHALLENGE_TTL);
    return id;
  };
  function takeChallenge(id, kind) {            // uso único
    const c = db.prepare('SELECT * FROM challenges WHERE id=? AND kind=?').get(String(id || ''), kind);
    if (c) db.prepare('DELETE FROM challenges WHERE id=?').run(c.id);
    if (!c || c.expires_at < now()) throw bad('Desafio expirado. Tente de novo.');
    return c;
  }
  const credRows = userId => db.prepare('SELECT id, transports FROM credentials WHERE user_id=?').all(userId);
  const exclude = userId => credRows(userId).map(c => ({ id: c.id, transports: c.transports ? JSON.parse(c.transports) : undefined }));
  const regOpts = (userId, name) => generateRegistrationOptions({
    rpName: cfg.rpName, rpID: cfg.rpID, userName: name, userDisplayName: name,
    userID: new TextEncoder().encode(userId), attestationType: 'none', excludeCredentials: exclude(userId),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' }
  });
  function storeCredential(userId, info, label) {
    const { credential, credentialDeviceType, credentialBackedUp } = info;
    db.prepare(`INSERT INTO credentials(id,user_id,public_key,counter,transports,device_type,backed_up,label,created_at)
                VALUES(?,?,?,?,?,?,?,?,?)`).run(credential.id, userId, Buffer.from(credential.publicKey), credential.counter || 0,
      credential.transports ? JSON.stringify(credential.transports) : null, credentialDeviceType, credentialBackedUp ? 1 : 0,
      String(label || 'Passkey').slice(0, 60), now());
  }
  const verifyReg = (response, challenge) => verifyRegistrationResponse({
    response, expectedChallenge: challenge, expectedOrigin: cfg.origin, expectedRPID: cfg.rpID, requireUserVerification: true
  });

  // ── registro com convite ──
  app.post('/api/auth/register/options', inviteLimit, async req => {
    const { invite, name } = req.body || {};
    const inv = findInvite(invite); if (!inv) throw bad('Convite inválido, usado ou expirado.');
    let userId, display;
    if (inv.user_id) {                                     // convite de recuperação / novo dispositivo
      const u = db.prepare('SELECT * FROM users WHERE id=? AND disabled=0').get(inv.user_id); if (!u) throw bad('Conta indisponível.');
      userId = u.id; display = u.name;
    } else { userId = uuid(); display = String(name || inv.label).trim().slice(0, 60) || inv.label; }
    const options = await regOpts(userId, display);
    return { challengeId: newChallenge('reg', options.challenge, { userId, inviteId: inv.id, name: display }), options, name: display };
  });
  app.post('/api/auth/register/verify', inviteLimit, async (req, reply) => {
    const { challengeId, response, label } = req.body || {};
    const ch = takeChallenge(challengeId, 'reg');
    const inv = db.prepare('SELECT * FROM invites WHERE id=?').get(ch.invite_id);
    if (!inv || inv.used_at || inv.revoked_at || inv.expires_at < now()) throw bad('Convite inválido, usado ou expirado.');
    let v; try { v = await verifyReg(response, ch.challenge); } catch (e) { throw bad('Passkey recusada: ' + e.message); }
    if (!v.verified) throw denied('Passkey não verificada');
    const t = now();
    db.transaction(() => {
      if (inv.user_id) {
        const n = db.prepare('SELECT COUNT(*) FROM credentials WHERE user_id=?').pluck().get(ch.user_id);
        if (n >= cfg.maxPasskeys) throw conflict(`Limite de ${cfg.maxPasskeys} passkeys. Peça ao administrador para remover uma.`);
      } else {
        db.prepare('INSERT INTO users(id,name,role,created_at) VALUES(?,?,?,?)').run(ch.user_id, ch.name, inv.role, t);
      }
      storeCredential(ch.user_id, v.registrationInfo, label);
      db.prepare('UPDATE invites SET used_at=?, used_by=? WHERE id=? AND used_at IS NULL').run(t, ch.user_id, inv.id);
      audit(db, ch.user_id, inv.user_id ? 'passkey.recovered' : 'user.registered', ch.user_id, req.ip, { invite: inv.id });
    })();
    createSession(req, reply, ch.user_id);
    const u = db.prepare('SELECT id,name,role FROM users WHERE id=?').get(ch.user_id);
    return { user: u };
  });

  // ── login (passkey descobrível: sem digitar usuário) ──
  app.post('/api/auth/login/options', authLimit, async () => {
    const options = await generateAuthenticationOptions({ rpID: cfg.rpID, userVerification: 'required' });
    return { challengeId: newChallenge('auth', options.challenge), options };
  });
  app.post('/api/auth/login/verify', authLimit, async (req, reply) => {
    const { challengeId, response } = req.body || {};
    const ch = takeChallenge(challengeId, 'auth');
    const cred = db.prepare('SELECT * FROM credentials WHERE id=?').get(String(response?.id || ''));
    const fail = () => { audit(db, null, 'login.failed', null, req.ip); return denied('Passkey não reconhecida'); };
    if (!cred) throw fail();
    const u = db.prepare('SELECT * FROM users WHERE id=? AND disabled=0').get(cred.user_id); if (!u) throw fail();
    let v; try {
      v = await verifyAuthenticationResponse({
        response, expectedChallenge: ch.challenge, expectedOrigin: cfg.origin, expectedRPID: cfg.rpID, requireUserVerification: true,
        credential: { id: cred.id, publicKey: new Uint8Array(cred.public_key), counter: cred.counter, transports: cred.transports ? JSON.parse(cred.transports) : undefined }
      });
    } catch (e) { throw fail(); }
    if (!v.verified) throw fail();
    db.prepare('UPDATE credentials SET counter=?, last_used_at=? WHERE id=?').run(v.authenticationInfo.newCounter, now(), cred.id);
    audit(db, u.id, 'login', u.id, req.ip);
    createSession(req, reply, u.id);
    return { user: { id: u.id, name: u.name, role: u.role } };
  });
  app.post('/api/auth/logout', async (req, reply) => {
    if (req.sidHash) db.prepare('DELETE FROM sessions WHERE id_hash=?').run(req.sidHash);
    reply.clearCookie(COOKIE, { path: '/' }); return { ok: true };
  });

  // ── conta ──
  const passkeysOf = id => db.prepare('SELECT id,label,device_type,backed_up,created_at,last_used_at FROM credentials WHERE user_id=? ORDER BY created_at').all(id)
    .map(c => ({ id: c.id, label: c.label, deviceType: c.device_type, backedUp: !!c.backed_up, createdAt: c.created_at, lastUsedAt: c.last_used_at }));
  app.get('/api/me', { preHandler: app.requireAuth }, async req => ({
    user: req.user, passkeys: passkeysOf(req.user.id), maxPasskeys: cfg.maxPasskeys, serverTime: now()
  }));
  app.post('/api/me/passkeys/options', { preHandler: app.requireAuth, ...authLimit }, async req => {
    if (passkeysOf(req.user.id).length >= cfg.maxPasskeys) throw conflict(`Limite de ${cfg.maxPasskeys} passkeys.`);
    const options = await regOpts(req.user.id, req.user.name);
    return { challengeId: newChallenge('reg-self', options.challenge, { userId: req.user.id, name: req.user.name }), options };
  });
  app.post('/api/me/passkeys/verify', { preHandler: app.requireAuth, ...authLimit }, async req => {
    const { challengeId, response, label } = req.body || {};
    const ch = takeChallenge(challengeId, 'reg-self'); if (ch.user_id !== req.user.id) throw forbidden();
    if (passkeysOf(req.user.id).length >= cfg.maxPasskeys) throw conflict(`Limite de ${cfg.maxPasskeys} passkeys.`);
    let v; try { v = await verifyReg(response, ch.challenge); } catch (e) { throw bad('Passkey recusada: ' + e.message); }
    if (!v.verified) throw denied('Passkey não verificada');
    storeCredential(req.user.id, v.registrationInfo, label); audit(db, req.user.id, 'passkey.added', req.user.id, req.ip);
    return { passkeys: passkeysOf(req.user.id) };
  });
  // link para cadastrar a passkey de OUTRO aparelho (15 min, uso único, respeita o limite)
  app.post('/api/me/device-invite', { preHandler: app.requireAuth, ...authLimit }, async req => {
    if (passkeysOf(req.user.id).length >= cfg.maxPasskeys) throw conflict(`Limite de ${cfg.maxPasskeys} passkeys. Remova uma antes.`);
    db.prepare('UPDATE invites SET revoked_at=? WHERE user_id=? AND created_by=? AND used_at IS NULL AND revoked_at IS NULL').run(now(), req.user.id, req.user.id);   // só um link ativo
    const raw = token(32), t = now(), exp = t + 15 * 60e3;
    db.prepare('INSERT INTO invites(id,token_hash,label,role,user_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(uuid(), sha256(raw), req.user.name, 'user', req.user.id, req.user.id, t, exp);
    audit(db, req.user.id, 'invite.device', req.user.id, req.ip);
    return { url: `${cfg.origin}/login?invite=${raw}`, expiresAt: exp };
  });
  app.delete('/api/me/passkeys/:id', { preHandler: app.requireAuth }, async req => {
    const list = passkeysOf(req.user.id); if (!list.some(c => c.id === req.params.id)) throw notFound();
    if (list.length <= 1) throw conflict('Não dá para remover a única passkey. Adicione outra antes.');
    db.prepare('DELETE FROM credentials WHERE id=? AND user_id=?').run(req.params.id, req.user.id);
    audit(db, req.user.id, 'passkey.removed', req.user.id, req.ip); return { passkeys: passkeysOf(req.user.id) };
  });
  return { createSession };
}

// limpeza periódica de lixo (desafios, sessões e convites vencidos)
export function purgeExpired(db) {
  const t = now();
  db.prepare('DELETE FROM challenges WHERE expires_at<?').run(t);
  db.prepare('DELETE FROM sessions WHERE expires_at<?').run(t);
  db.prepare('DELETE FROM invites WHERE (expires_at<? OR used_at IS NOT NULL OR revoked_at IS NOT NULL) AND created_at<?').run(t, t - 30 * DAY);
}
