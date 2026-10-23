// Service Worker of the engine debug page: the app works offline from the home screen.
// The build replaces the two placeholders below (see vite.config.ts). Photos never pass
// through here: they are opened from local files and stay on the device.
const VERSION = '__ENGINE_VERSION__';
const PRECACHE = self.__PRECACHE__;
const SHELL = `vishar-engine-shell-${VERSION}`;
const SAMPLES = 'vishar-engine-samples';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('vishar-engine-shell-') && k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const fromShell = async (req) => (await caches.open(SHELL)).match(req, { ignoreSearch: true, ignoreVary: true });

self.addEventListener('message', (event) => {
  if (event.data === 'version') event.source?.postMessage({ version: VERSION, precached: PRECACHE.length });
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;

  // Large test photos: cached on first use, so a second run works offline.
  if (url.pathname.includes('/samples/')) {
    event.respondWith(caches.open(SAMPLES).then(async (c) => {
      const hit = await c.match(req, { ignoreVary: true });
      if (hit) return hit;
      try {
        const resp = await fetch(req);
        if (resp.ok) await c.put(req, resp.clone());
        return resp;
      } catch {
        return new Response('sample not cached', { status: 504 });
      }
    }));
    return;
  }

  // Page navigations: network first (fresh build), the cached shell when offline.
  if (req.mode === 'navigate') {
    const shell = new URL('./', self.registration.scope).href;
    event.respondWith(
      fetch(req)
        .then(async (resp) => {
          if (resp.ok) await (await caches.open(SHELL)).put(shell, resp.clone());
          return resp;
        })
        .catch(async () => (await fromShell(new Request(shell))) ?? Response.error()),
    );
    return;
  }

  // Hashed assets, catalogues, icons: cache first.
  event.respondWith(fromShell(req).then((r) => r ?? fetch(req)));
});
