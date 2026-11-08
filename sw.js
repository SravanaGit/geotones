// Keeps the app's own files so it opens without signal. Maps, sign-in and
// storage come from other sites and are left to the network.
const CACHE = 'geotones-shell-v1';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cache = await caches.open(CACHE);
        const hit = await cache.match(event.request, { ignoreSearch: true });
        if (hit) return hit;
        if (event.request.mode === 'navigate') {
          return (await cache.match(new URL('./', self.registration.scope).href)) ?? Response.error();
        }
        return Response.error();
      }),
  );
});
