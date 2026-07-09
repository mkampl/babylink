// service-worker.js
const CACHE_NAME = 'babylink-v2.7.0';

// Shell assets pre-cached on install. Everything here is fingerprintless
// (no hashed filenames), so we rely on the CACHE_NAME bump to roll
// users to a new version.
const urlsToCache = [
  '/',
  '/css/variables.css',
  '/css/base.css',
  '/css/components.css',
  '/css/monitor.css',
  '/css/home.css',
  '/js/utils.js',
  '/js/qrcode-generator.js',
  '/js/sw-register.js',
  '/js/home.js',
  '/js/select-role.js',
  '/js/level-meter.js',
  '/js/multi-baby-ui.js',
  '/js/multi-stream-manager.js',
  '/js/wake-lock-manager.js',
  '/js/alarm-manager.js',
  '/js/esp32-audio-handler.js',
  '/js/sleep-tracker.js',
  '/js/app.js',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// Static shell assets — anything under /css/, /js/, /icons/, plus
// /manifest.json. These are pure files, never user-specific.
function isStaticShell(url) {
  if (url.origin !== self.location.origin) return false;
  const p = url.pathname;
  if (p === '/manifest.json') return true;
  return p.startsWith('/css/') || p.startsWith('/js/') || p.startsWith('/icons/');
}

// Requests we never want the SW to touch — let them go straight to
// the network so the room HTML stays fresh (it carries role-routing
// logic), the WebRTC config picks up TURN credential rotations, and
// /socket.io/ + /esp32-baby keep their long-lived upgrades.
function isBypass(url) {
  if (url.origin !== self.location.origin) return true;
  const p = url.pathname;
  return p.startsWith('/api/') ||
         p.startsWith('/socket.io/') ||
         p.startsWith('/esp32-baby') ||
         p === '/health';
}

// Cache-first with stale-while-revalidate for the shell. The cached
// copy ships instantly (faster first paint after the first visit),
// and a background fetch quietly refreshes it for the next load.
function shellRespond(request) {
  return caches.match(request).then((cached) => {
    const refresh = fetch(request).then((response) => {
      if (response && response.ok) {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
      }
      return response;
    }).catch(() => cached);
    return cached || refresh;
  });
}

// Network-first for HTML so role/PIN flows never see a stale page;
// fall back to cache (we pre-cached '/' so the home page works offline).
// Only cache the root path — room URLs like /<roomId>?role=…&userName=…
// would fill the cache with every room ID the user visits and persist
// them to disk indefinitely (privacy + quota leak).
function htmlRespond(request) {
  const url = new URL(request.url);
  return fetch(request)
    .then((response) => {
      if (response.ok && url.pathname === '/') {
        const clone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          // background-revalidate: keep the cached copy fresh without
          // blocking the response the caller already received.
          cache.put(request, clone);
        });
      }
      return response;
    })
    .catch(() => caches.match(request));
}

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  if (isBypass(url)) return;
  if (isStaticShell(url)) {
    event.respondWith(shellRespond(event.request));
    return;
  }
  event.respondWith(htmlRespond(event.request));
});

// Activate event - clean old caches and claim clients immediately
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((names) => Promise.all(
        names.filter((name) => name !== CACHE_NAME).map((name) => caches.delete(name))
      ))
      .then(() => self.clients.claim())
  );
});
