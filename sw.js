var CACHE = 'agriflow-v5';

self.addEventListener('install', function() {
  self.skipWaiting();
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(keys.map(function(k) { return caches.delete(k); }));
    }).then(function() {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', function(e) {
  if (e.request.url.includes('/api/')) return;
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(function() { return caches.match(e.request); }));
  }
});
