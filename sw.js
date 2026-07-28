/* Scale Invaders service worker.
 *
 * Exists for two reasons: installability (Chrome requires a fetch handler) and
 * offline play — the point of installing a practice game is drilling on a phone
 * without a connection.
 *
 * Bump CACHE when shipping a change you want to force out of old caches. The
 * document itself is network-first, so an ordinary edit lands on the next online
 * load without a version bump.
 */
const CACHE = "scale-invaders-v1";

/* Relative so the app works from a subdirectory (e.g. a GitHub Pages project
   path) as well as a domain root. Fonts are cached opportunistically at runtime
   instead — they are cross-origin and must never fail the install. */
const SHELL = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // One 404 in addAll() rejects the whole install, which would leave the app
    // permanently uninstallable; take the entries that resolve and move on.
    await Promise.allSettled(SHELL.map(url => cache.add(new Request(url, { cache: "reload" }))));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n !== CACHE).map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  // The document goes network-first so edits show up without a cache bump, with
  // the cached copy as the offline fallback.
  if (req.mode === "navigate" || req.destination === "document") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
        return res;
      } catch {
        return (await caches.match(req)) || (await caches.match("./index.html")) || Response.error();
      }
    })());
    return;
  }

  // Everything else (icons, Google Fonts CSS and woff2) is cache-first: it is all
  // versioned or immutable, and this is what makes offline play work.
  event.respondWith((async () => {
    const hit = await caches.match(req);
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // `opaque` covers the no-cors font files; caching those is fine, we only
      // ever hand them back to the same <link>/@import that asked for them.
      if (res.ok || res.type === "opaque") {
        const cache = await caches.open(CACHE);
        cache.put(req, res.clone());
      }
      return res;
    } catch {
      return Response.error();
    }
  })());
});
