// Cache the application shell only. Authenticated API responses and files are never cached.
const CACHE = 'dirtworks-shell-v3';
self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(['/', '/index.html', '/favicon.svg'])));
  self.skipWaiting();
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('dirtworks-shell-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || /^\/api(?:\/|$)/i.test(url.pathname)) return;
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request).then(response => {
      if (response.ok && (response.headers.get('content-type') || '').includes('text/html')) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put('/index.html', copy)); }
      return response;
    }).catch(() => caches.match('/index.html')));
  } else if (url.pathname.startsWith('/assets/') || url.pathname === '/favicon.svg') {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); }
      return response;
    })));
  }
});
