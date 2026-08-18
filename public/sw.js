/* ═══════════════════════════════════════════════════════
   AgentKontor Service Worker
   Cache-Strategie:
   - App-Shell (HTML/CSS/JS) → Cache-First
   - API-Calls (/api/*)      → Network-Only
   - Assets (Icons etc.)     → Cache-First
═══════════════════════════════════════════════════════ */

const CACHE_NAME   = 'agentkontor-v2'; // Bump bei jedem Deploy
// NUR same-origin Assets cachen — externe CDN-URLs werden direkt geladen
const SHELL_ASSETS = [
  '/app.html',
  '/manifest.json',
  '/sw.js',
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

  // Externe Domains: IMMER direkt ans Netzwerk, NIEMALS cachen
  // (fonts.googleapis.com, unpkg.com, cdnjs.cloudflare.com etc.)
  const isExternal = url.origin !== self.location.origin;
  if (isExternal) return; // SW tritt zur Seite — Browser handled das direkt

  // API-Calls: immer vom Netzwerk, kein Cache
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(JSON.stringify({ error: 'Offline — keine Verbindung' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' }
        })
      )
    );
    return;
  }

  // chrome-extension:// und andere nicht-http Schemes: ignorieren
  if (!url.protocol.startsWith('http')) return;

  // App-Shell (nur same-origin GET): Cache-First
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(response => {
        // NUR: same-origin GET, Status 200, kein API-Call
        if (
          e.request.method === 'GET' &&
          response.status === 200 &&
          url.origin === self.location.origin &&
          !url.pathname.startsWith('/api/')
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME)
            .then(cache => cache.put(e.request, clone))
            .catch(() => {}); // Chrome-Extension-Scheme-Fehler ignorieren
        }
        return response;
      }).catch(() => {
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
