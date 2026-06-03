// service-worker.js
const CACHE_NAME = 'babylink-v2.2.0';
const urlsToCache = [
  '/',
  '/css/variables.css',
  '/css/base.css',
  '/css/components.css',
  '/css/monitor.css',
  '/css/home.css',
  '/js/utils.js',
  '/js/qrcode-generator.js',
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

// Install event - cache resources and activate immediately
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(urlsToCache))
      .then(() => self.skipWaiting())
  );
});

// Fetch event - network first, fall back to cache
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Cache the fresh response for offline use
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => {
        // Network failed, try cache
        return caches.match(event.request);
      })
  );
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
