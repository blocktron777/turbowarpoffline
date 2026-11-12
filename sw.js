const CACHE = 'app-v1';
const PAGE = '/index.html';

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          // Got a fresh copy online — update the cache and serve it
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(PAGE, copy));
          return res;
        })
        .catch(() =>
          // Offline — serve the cached copy, or a friendly error page
          caches.match(PAGE).then(
            (cached) =>
              cached ||
              new Response(
                '<h1>Offline</h1><p>This page was never cached.</p>',
                { headers: { 'Content-Type': 'text/html' } }
              )
          )
        )
    );
  }
});
