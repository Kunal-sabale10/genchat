// GenChat Service Worker for PWA Shell & Static Asset Caching
const CACHE_NAME = 'genchat-shell-v1.0.0';
const STATIC_SHELL = [
  '/',
  '/index.html',
  '/manifest.json',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_SHELL);
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Never intercept WebSocket connections, Auth API, or Media endpoints
  if (
    url.pathname.startsWith('/ws') ||
    url.pathname.startsWith('/chat.v1.') ||
    url.pathname.startsWith('/auth') ||
    url.pathname.startsWith('/media') ||
    url.pathname.startsWith('/v1/media') ||
    url.pathname.startsWith('/readyz') ||
    url.pathname.startsWith('/healthz') ||
    url.protocol === 'ws:' ||
    url.protocol === 'wss:'
  ) {
    return;
  }

  // SPA navigation fallback to cached index.html
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/index.html'))
    );
    return;
  }

  // Cache-first for immutable Vite assets and wasm binaries
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (
          response.status === 200 &&
          (url.pathname.startsWith('/assets/') || url.pathname.endsWith('.wasm'))
        ) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});
