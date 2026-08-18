/* ═══════════════════════════════════════════════════════
   AgentKontor Service Worker
   Cache-Strategie:
   - App-Shell (HTML/CSS/JS) → Cache-First
   - API-Calls (/api/*)      → Network-Only
   - Assets (Icons etc.)     → Cache-First
═══════════════════════════════════════════════════════ */

const CACHE_NAME   = 'agentkontor-v2'; // Bump bei jedem Deploy
const SHELL_ASSETS = [
  '/app.html',
  '/manifest.json',
  'https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js',
];

// ── Install: Shell cachen ────────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(SHELL_ASSETS).catch(() => {}) // ignoriere Fehler bei externen URLs
    ).then(() => self.skipWaiting())
  );
});

// ── Activate: alten Cache löschen ────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: Routing-Strategie ─────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // API-Calls: immer vom Netzwerk
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(fetch(e.request).catch(() =>
      new Response(JSON.stringify({ error: 'Offline — keine Verbindung' }), {
        status: 503,
        headers: { 'Content-Type': 'application/json' }
      })
    ));
    return;
  }

  // App-Shell: Cache-First mit Netzwerk-Fallback
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        // NUR GET-Anfragen cachen — niemals POST/PUT/DELETE
        if (e.request.method === 'GET' && response.status === 200 && !e.request.url.includes('/api/')) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(e.request, clone));
        }
        return response;
      }).catch(() => {
        // Offline-Fallback für Navigation
        if (e.request.mode === 'navigate') {
          return caches.match('/app.html');
        }
      });
    })
  );
});

// ── Push-Notifications (für spätere Freigabe-Alerts) ────────────────────────
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'AgentKontor', {
      body:    data.body || 'Neue Benachrichtigung',
      icon:    '/icon-192.png',
      badge:   '/icon-192.png',
      tag:     data.tag || 'agentkontor',
      data:    { url: data.url || '/app.html' },
      actions: data.actions || [],
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.openWindow(e.notification.data?.url || '/app.html')
  );
});
