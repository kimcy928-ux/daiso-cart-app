// 아주 단순한 PWA 오프라인 셸 캐시.
// /api/ 요청은 절대 캐시하지 않습니다 (항상 최신 검색 결과를 받아야 하니까요).

const CACHE_NAME = 'daiso-cart-shell-v1';
const SHELL_FILES = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.json',
  'icons/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API 요청은 네트워크로만 (캐시 금지)
  if (url.pathname.startsWith('/api/')) {
    return;
  }

  if (event.request.method !== 'GET') return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const network = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const resClone = res.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
