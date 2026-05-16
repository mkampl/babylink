// service-worker.js
const CACHE_NAME = 'babylink-v2.0.0';
const urlsToCache = [
  '/',
  '/css/variables.css',
  '/css/base.css',
  '/css/components.css',
  '/css/monitor.css',
  '/css/home.css',
  '/js/utils.js',
  '/js/multi-baby-ui.js',
  '/js/multi-stream-manager.js',
  '/js/wake-lock-manager.js',
  '/js/alarm-manager.js',
  '/js/esp32-audio-handler.js',
  '/js/notification-ui.js',
  '/js/app.js',
  '/manifest.json',
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png'
];

// Install event
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        console.log('Opened cache');
        return cache.addAll(urlsToCache);
      })
  );
});

// Fetch event
self.addEventListener('fetch', (event) => {
  event.respondWith(
    caches.match(event.request)
      .then((response) => {
        // Return cached version or fetch from network
        return response || fetch(event.request);
      }
    )
  );
});

// Activate event
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName);
          }
        })
      );
    })
  );
});
