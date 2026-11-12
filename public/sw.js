// sw.js — VERSION é substituído pelo build (vercel.json/netlify.toml) a cada deploy
const VERSION = '%%BUILD%%';
const CACHE = 'ironlog-' + VERSION;
const ASSETS = ['/', '/index.html', '/manifest.json', '/exercises.json', '/icon-192.png', '/icon-512.png'];
const CATALOG = '/exercises.json';

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE)
      // só guarda respostas OK: um 404 não pode virar "versão offline" de nada
      .then(c => Promise.all(ASSETS.map(a =>
        fetch(a, { cache: 'reload' }).then(r => { if (r && r.ok) return c.put(a, r); }).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  // API e painel admin: sempre rede, nunca cache (dados e sessões não podem ficar no cache do navegador)
  if (url.pathname.startsWith('/api/') || url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return;

  // App shell: rede primeiro, cache se offline
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone));
        return res;
      }).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Catálogo de exercícios: responde do cache na hora e atualiza em segundo plano
  // (o app ainda guarda uma cópia própria no IndexedDB como segunda camada offline)
  if (url.pathname === CATALOG) {
    e.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cached = await cache.match(CATALOG);
      const refresh = fetch(req).then(r => { if (r && r.ok) { cache.put(CATALOG, r.clone()); } return r; }).catch(() => null);
      e.waitUntil(refresh);
      if (cached) return cached;
      const fresh = await refresh;
      return fresh || new Response('', { status: 503, statusText: 'offline' });
    })());
    return;
  }

  e.respondWith(
    caches.match(req).then(cached => cached || fetch(req).catch(() => caches.match('/index.html')))
  );
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

// ── Avisos push (chegam mesmo com o app fechado) ──
self.addEventListener('push', e => {
  let d = {}; try { d = e.data ? e.data.json() : {}; } catch (_) { d = { title: 'IRONLOG', body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'IRONLOG', {
    body: d.body || '', tag: d.tag || 'ironlog', renotify: true,
    vibrate: Array.isArray(d.vibrate) ? d.vibrate : [300, 100, 300],
    icon: '/icon-192.png', badge: '/icon-192.png', data: { url: d.url || '/' },
    requireInteraction: d.type === 'workout-alert'            // o aviso de treino esquecido não some sozinho
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) if ('focus' in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
