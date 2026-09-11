const CACHE = 'guidefit-v7';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(clients.claim()); });
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return; // API — только сеть
  if (e.request.method !== 'GET') return;
  e.respondWith(
    caches.open(CACHE).then(cache =>
      cache.match(e.request).then(cached => {
        const fresh = fetch(e.request).then(res => {
          if (res && res.ok && (url.origin.includes('pexels.com') || url.origin === location.origin)) {
            cache.put(e.request, res.clone());
          }
          return res;
        }).catch(() => cached);
        return cached || fresh;
      })
    )
  );
});
