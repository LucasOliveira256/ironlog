import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import fstatic from '@fastify/static';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from './db.js';
import { registerAuth } from './auth.js';
import { registerSync } from './sync.js';
import { registerPush } from './push.js';
import { registerAdmin } from './admin.js';
import { now } from './util.js';

const CSP = [
  "default-src 'self'", "script-src 'self' 'unsafe-inline'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src https://fonts.gstatic.com", "img-src 'self' data:", "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'",
  "frame-ancestors 'none'", "base-uri 'none'", "form-action 'self'", "object-src 'none'"
].join('; ');

// lê um arquivo e só reprocessa quando o mtime muda
function memo(file, fn) {
  let m = -1, v = null;
  return () => { const st = fs.statSync(file); if (st.mtimeMs !== m) { v = fn(fs.readFileSync(file, 'utf8')); m = st.mtimeMs; } return v; };
}

export async function buildApp(cfg, opts = {}) {
  const app = Fastify({ logger: opts.logger ? { level: cfg.logLevel } : false, trustProxy: cfg.trustProxy, bodyLimit: 6 * 1024 * 1024 });
  const db = opts.db || openDb(cfg.dbFile);
  app.decorate('db', db); app.decorate('cfg', cfg);
  app.addHook('onClose', async () => { if (!opts.db) try { db.close(); } catch (_) {} });

  await app.register(cookie);
  await app.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute',
    errorResponseBuilder: (req, ctx) => ({ statusCode: 429, error: 'Muitas tentativas. Aguarde um instante.', message: 'Muitas tentativas. Aguarde um instante.' }) });

  app.addHook('onSend', async (req, reply) => {
    reply.header('x-content-type-options', 'nosniff').header('referrer-policy', 'no-referrer').header('x-frame-options', 'DENY')
      .header('permissions-policy', 'camera=(), microphone=(), geolocation=()').header('content-security-policy', CSP);
    if (cfg.secureCookies) reply.header('strict-transport-security', 'max-age=31536000');
    if (req.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
  });
  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode || err.status || 500;
    if (status >= 500) req.log.error(err);
    const msg = status >= 500 ? 'Erro interno' : (status === 429 ? 'Muitas tentativas. Aguarde um instante.' : err.error || err.message);
    reply.status(status).send({ error: msg });
  });
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Não encontrado' });
    reply.status(404).type('text/plain').send('Não encontrado');
  });

  registerAuth(app); registerSync(app); registerPush(app, opts); registerAdmin(app);
  app.get('/api/health', async () => ({ ok: true, time: now() }));

  // ── arquivos do app ──
  const f = n => path.join(cfg.staticDir, n);
  const index = memo(f('index.html'), html => html.replace('</head>', '<meta name="ironlog-server" content="1">\n</head>'));
  const buildId = (() => {            // muda a cada deploy → o service worker renova o cache
    let key = '', val = '';
    return () => {
      const files = ['index.html', 'sw.js', 'exercises.json', 'manifest.json'].map(f);
      const k = files.map(x => { try { return fs.statSync(x).mtimeMs; } catch (_) { return 0; } }).join('|');
      if (k !== key) { const h = crypto.createHash('sha256'); for (const x of files) try { h.update(fs.readFileSync(x)); } catch (_) {} val = h.digest('hex').slice(0, 12); key = k; }
      return val;
    };
  })();
  const sw = memo(f('sw.js'), s => s);
  const html = (reply, body) => reply.header('cache-control', 'no-cache').type('text/html; charset=utf-8').send(body);
  const safe = (reply, fn) => { try { return fn(); } catch (e) { reply.status(503).type('text/plain').send('Aplicativo ainda não instalado no servidor.'); } };
  app.get('/', async (req, reply) => safe(reply, () => html(reply, index())));
  app.get('/index.html', async (req, reply) => safe(reply, () => html(reply, index())));
  app.get('/sw.js', async (req, reply) => safe(reply, () =>
    reply.header('cache-control', 'no-cache').header('service-worker-allowed', '/').type('application/javascript; charset=utf-8').send(sw().replace(/%%BUILD%%/g, buildId()))));
  const loginPage = memo(f('login.html'), s => s);
  app.get('/login', async (req, reply) => safe(reply, () => html(reply, loginPage())));
  const adminPage = memo(cfg.adminFile, s => s);
  app.get('/admin', async (req, reply) => {
    if (!req.user || req.user.role !== 'admin') return reply.status(404).type('text/plain').send('Não encontrado');   // não revela que existe
    return safe(reply, () => html(reply, adminPage()));
  });
  app.get('/admin/', async (req, reply) => reply.redirect('/admin'));

  await app.register(fstatic, {
    root: cfg.staticDir, prefix: '/', index: false, dotfiles: 'deny', wildcard: true, cacheControl: false,
    setHeaders: (res, p) => {
      if (/exercises\.json$|manifest\.json$/.test(p)) res.setHeader('cache-control', 'no-cache');
      else res.setHeader('cache-control', 'public, max-age=86400');
    }
  });
  return app;
}
