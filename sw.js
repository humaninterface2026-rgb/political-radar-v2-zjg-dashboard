// Service Worker for political-radar-v2-lxy-site
// Goal: 2nd-visit speed-up + offline fallback.
//
// Strategy:
//   HTML       — network-first (so deploys show up immediately if online)
//   JS / CSS   — cache-first (versioned via ?v=... in URL; new versions = new URLs)
//   JSON data  — stale-while-revalidate, ignoring the ?t=... cache-buster query
//                (cron updates data every 15 min; user sees previous snapshot
//                 instantly, fresh data lands on next view)
//   Cross-origin (CDN vendor JS, Supabase RPC, OSM tiles) — passthrough
//
// Bump VERSION when changing SW logic to invalidate old caches.

const VERSION = 'v3';
const STATIC_CACHE = `lxy-static-${VERSION}`;
const JSON_CACHE   = `lxy-json-${VERSION}`;

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter(k => !k.endsWith(`-${VERSION}`)).map(k => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.headers.has('range')) return;        // skip partial-content (video etc.)
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;  // CDN / Supabase / OSM — let browser handle

  const path = url.pathname;
  if (path.endsWith('.json'))                   event.respondWith(staleWhileRevalidate(req));
  else if (path.endsWith('/') || path.endsWith('.html')) event.respondWith(networkFirst(req));
  else if (/\.(js|css)$/.test(path))            event.respondWith(cacheFirst(req));
  // Other static types (images, fonts) fall through to default browser handling.
});

async function cacheFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  const cached = await cache.match(req);
  if (cached) return cached;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone()).catch(() => {});
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(STATIC_CACHE);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw e;
  }
}

// Stale-while-revalidate, ignoring ?t=... (cache-buster timestamp added by fetchJSON)
async function staleWhileRevalidate(req) {
  const cache = await caches.open(JSON_CACHE);
  // Strip query string for cache key so all timestamp variants share one entry
  const cacheKey = req.url.split('?')[0];
  const cached = await cache.match(cacheKey);

  const fetchPromise = fetch(req).then(res => {
    if (res.ok) cache.put(cacheKey, res.clone()).catch(() => {});
    return res;
  }).catch(() => null);

  // Serve cached immediately if available; otherwise wait for fetch.
  if (cached) {
    // Don't await fetchPromise — runs in background.
    return cached;
  }
  return (await fetchPromise) || new Response('Network error and no cache', { status: 503 });
}
