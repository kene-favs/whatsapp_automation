// ============================================================
//  ForgeBot — Service Worker
//  Required for PWA install prompt to work on Android/Chrome.
//  Also caches the dashboard so it loads fast on repeat visits.
// ============================================================

const CACHE_NAME = 'forgebot-v1';

// Pages/assets to cache on install
const PRECACHE = [
  '/',
  '/dashboard',
  '/public/index.html',
  '/public/dashboard.html',
  '/manifest.json'
];

// ── Install: cache core pages ────────────────────────────────
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(PRECACHE).catch(function() {
        // Silently ignore cache failures (URLs may not exist yet)
      });
    })
  );
  self.skipWaiting();
});

// ── Activate: clean up old caches ───────────────────────────
self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// ── Fetch: network first, fallback to cache ──────────────────
self.addEventListener('fetch', function(event) {
  // Only handle GET requests
  if (event.request.method !== 'GET') return;

  // Skip API calls — always go to network for live data
  if (event.request.url.includes('/api/')) return;

  event.respondWith(
    fetch(event.request)
      .then(function(response) {
        // Cache a copy of successful responses
        if (response && response.status === 200) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(event.request, clone);
          });
        }
        return response;
      })
      .catch(function() {
        // Network failed — try cache
        return caches.match(event.request);
      })
  );
});

// ── Push: show notification when server sends one ────────────
self.addEventListener('push', function(event) {
  var data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {
      title: 'ForgeBot',
      body: event.data ? event.data.text() : 'You have a new notification.'
    };
  }

  var title   = data.title || 'ForgeBot';
  var options = {
    body:    data.body    || 'You have a new notification.',
    icon:    '/icons/icon-192.png',
    badge:   '/icons/icon-192.png',
    tag:     data.tag     || 'forgebot-notification',
    data:    { url: data.url || '/dashboard' },
    vibrate: [200, 100, 200],
    requireInteraction: data.requireInteraction || false
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Notification click: open / focus dashboard ───────────────
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  var targetUrl = (event.notification.data && event.notification.data.url) || '/dashboard';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(clientList) {
      for (var i = 0; i < clientList.length; i++) {
        var c = clientList[i];
        if (c.url.includes('/dashboard') && 'focus' in c) {
          return c.focus();
        }
      }
      return clients.openWindow(targetUrl);
    })
  );
});
