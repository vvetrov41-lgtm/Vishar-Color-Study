// Service Worker of the Stage 0 bench. The build replaces the two
// placeholders below (see vite.config.ts).
const VERSION = '__BENCH_VERSION__';
const PRECACHE = self.__PRECACHE__;
const SHELL = `vishar-bench-shell-${VERSION}`;
const SAMPLES = 'vishar-bench-samples';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((c) => c.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== SAMPLES).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function tagged(resp, how) {
  const h = new Headers(resp.headers);
  h.set('x-bench-cache', how);
  return new Response(resp.body, { status: resp.status, statusText: resp.statusText, headers: h });
}

async function fromShell(req) {
  const c = await caches.open(SHELL);
  return c.match(req, { ignoreSearch: true, ignoreVary: true });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // Probe used by the bench: answer strictly from cache, never from the network.
  if (url.searchParams.has('sw-cache-only')) {
    event.respondWith(
      fromShell(new Request(new URL('./', self.registration.scope))).then((r) =>
        r ? tagged(r, 'hit') : new Response('not cached', { status: 504 }),
      ),
    );
    return;
  }

  // Large timing samples: cache on first use, so the second run works offline.
  if (url.pathname.includes('/samples/')) {
    event.respondWith(
      caches.open(SAMPLES).then(async (c) => {
        const hit = (await c.match(req, { ignoreVary: true })) || (await fromShell(req));
        if (hit) return tagged(hit, 'cache');
        let resp;
        try {
          resp = await fetch(req);
        } catch {
          // Offline and never downloaded in this storage container.
          return new Response('sample not cached', { status: 504, headers: { 'x-bench-cache': 'miss-offline' } });
        }
        if (resp.ok) await c.put(req, resp.clone());
        return tagged(resp, 'network');
      }),
    );
    return;
  }

  // Page navigations: network first (fresh build), cache when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then(async (resp) => {
          if (resp.ok) (await caches.open(SHELL)).put(new URL('./', self.registration.scope).href, resp.clone());
          return resp;
        })
        .catch(async () => {
          const r = await fromShell(new Request(new URL('./', self.registration.scope)));
          return r ? tagged(r, 'offline') : Response.error();
        }),
    );
    return;
  }

  // Hashed assets and icons: cache first.
  event.respondWith(fromShell(req).then((r) => (r ? tagged(r, 'cache') : fetch(req))));
});
