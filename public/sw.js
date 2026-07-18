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
