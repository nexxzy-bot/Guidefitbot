const CACHE = 'guidefit-v17';
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k.indexOf('guidefit-') === 0 && k !== CACHE).map(k => caches.delete(k)))
  ).then(() => clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.pathname.startsWith('/api/')) return;
  if (e.request.method !== 'GET') return;
  // страница приложения — сначала сеть, кэш как запасной (аудит: без этого юзеры сидят на старой версии)
  if (e.request.mode === 'navigate' || url.pathname === '/' || url.pathname === '/index.html') {
    e.respondWith(fetch(e.request).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put('/index.html', copy));
      return res;
    }).catch(() => caches.match('/index.html')));
    return;
  }
  // остальное (фото и т.п.) — stale-while-revalidate
  e.respondWith(caches.open(CACHE).then(cache =>
    cache.match(e.request).then(cached => {
      const fresh = fetch(e.request).then(res => {
        if (res && res.ok && (url.origin.includes('pexels.com') || url.origin === location.origin)) cache.put(e.request, res.clone());
        return res;
      }).catch(() => cached);
      return cached || fresh;
    })
  ));
});
