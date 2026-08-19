/* ═══════════════════════════════════════════════════════
   AgentKontor Service Worker v3
   - Externe CDN-URLs (Fonts, Alpine, Chart.js) NIEMALS abfangen
   - API-Calls immer vom Netzwerk
   - Nur same-origin Assets cachen
═══════════════════════════════════════════════════════ */

const CACHE_NAME = 'agentkontor-v4';

// Nur eigene Dateien cachen
const SHELL_ASSETS = ['/app.html', '/manifest.json'];

// ── Install ──────────────────────────────────────────────────────────────────
self.addEventListener('install', e => {
  // Sofort aktiv werden — alten SW ersetzen
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(SHELL_ASSETS).catch(() => {})
    )
  );
});

// ── Activate ─────────────────────────────────────────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
      .then(() => {
        // Alle offenen Tabs nach Update neu laden
        return self.clients.matchAll({ type: 'window' }).then(clients => {
          clients.forEach(c => c.navigate(c.url));
        });
      })
  );
});

// ── Fetch ─────────────────────────────────────────────────────────────────────
self.addEventListener('fetch', e => {
  let url;
  try {
    url = new URL(e.request.url);
  } catch {
    return; // Ungültige URL → ignorieren
  }

  // 1. chrome-extension:// und andere Nicht-HTTP-Schemes → ignorieren
  if (!url.protocol.startsWith('http')) return;

  // 2. Externe Domains (CDN, Fonts, etc.) → IMMER direkt ans Netzwerk
  //    SW tritt komplett zur Seite — kein Abfangen, kein Cachen
  if (url.origin !== self.location.origin) return;

  // 3. API-Calls → Netzwerk-Only, offline-freundlicher Fehler
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(e.request).catch(() =>
        new Response(
          JSON.stringify({ error: 'Offline — keine Verbindung' }),
          { status: 503, headers: { 'Content-Type': 'application/json' } }
        )
      )
    );
    return;
  }

  // 4. Same-origin GET → Cache-First, Netzwerk-Fallback
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;

      return fetch(e.request)
        .then(response => {
          if (response.status === 200) {
            const clone = response.clone();
            caches.open(CACHE_NAME)
              .then(cache => cache.put(e.request, clone))
              .catch(() => {}); // Fehler beim Cachen ignorieren
          }
          return response;
        })
        .catch(() => {
          // Offline: Navigation → App-Shell
          if (e.request.mode === 'navigate') {
            return caches.match('/app.html');
          }
        });
    })
  );
});

// ── Push (für spätere Freigabe-Alerts) ───────────────────────────────────────
self.addEventListener('push', e => {
  const data = e.data?.json() || {};
  e.waitUntil(
    self.registration.showNotification(data.title || 'AgentKontor', {
      body:  data.body  || 'Neue Benachrichtigung',
      icon:  '/icon-192.png',
      badge: '/icon-192.png',
      tag:   data.tag   || 'agentkontor',
      data:  { url: data.url || '/app.html' },
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.openWindow(e.notification.data?.url || '/app.html'));
});
