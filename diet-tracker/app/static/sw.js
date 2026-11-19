'use strict';
// להעלות את הגרסה בכל שינוי בקבצי המעטפת
const VERSION = 'v2';
const SHELL_CACHE = `dt-shell-${VERSION}`;
const DATA_CACHE = 'dt-data';
const SHELL = [
  '/static/style.css',
  '/static/app.js',
  '/static/login.js',
  '/static/icons/icon-192.png',
  '/manifest.webmanifest',
  '/login',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) {
      if (k.startsWith('dt-shell-') && k !== SHELL_CACHE) await caches.delete(k);
    }
    await self.clients.claim();
  })());
});

const offline = () => new Response(JSON.stringify({ detail: 'אופליין' }), {
  status: 503, headers: { 'Content-Type': 'application/json', 'X-Offline': '1' },
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return; // כתיבות — ישירות לרשת

  // דף ראשי: רשת קודם, ובאופליין — העותק האחרון ששמרנו
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok && !res.redirected && url.pathname === '/') {
          (await caches.open(SHELL_CACHE)).put('/', res.clone());
        }
        return res;
      } catch {
        return (await caches.match(url.pathname === '/login' ? '/login' : '/')) ||
               (await caches.match('/login')) || Response.error();
      }
    })());
    return;
  }

  // נתונים: רשת קודם, גיבוי מהמטמון לצפייה אופליין
  if (url.pathname.startsWith('/api/')) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res.ok) (await caches.open(DATA_CACHE)).put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req)) || offline();
      }
    })());
    return;
  }

  // קבצים סטטיים: מהמטמון מיד, ורענון ברקע
  e.respondWith((async () => {
    const cache = await caches.open(SHELL_CACHE);
    const cached = await cache.match(req);
    const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; });
    if (cached) { fresh.catch(() => {}); return cached; }
    try { return await fresh; } catch { return Response.error(); }
  })());
});
