const CACHE_NAME = 'spl-static-v1';
const PRECACHE = [
  '/static/css/site.css',
  '/static/css/extensions.css',
  '/static/fonts/fonts.css',
  '/static/fonts/font-1.woff2',
  '/static/fonts/font-2.woff2',
  '/static/fonts/font-3.woff2',
  '/static/fonts/font-4.woff2',
  '/static/assets/icons.svg',
  '/static/assets/favicon.svg'
];

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE_NAME).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('spl-static-') && key !== CACHE_NAME).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith('/static/')) return;
  event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
    if (response.ok && response.type === 'basic') {
      const copy = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, copy));
    }
    return response;
  })));
});
