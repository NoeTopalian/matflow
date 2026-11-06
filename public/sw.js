// MatFlow minimal service worker — installability only.
// Deliberately no push handlers: push lives in app/sw.ts and stays dormant
// until real delivery is proven. No precache manifest; network-first always.

self.addEventListener("install", () => {
  self.skipWaiting();
});

// Navigation preload: the browser starts the page request while this worker is
// still starting up, instead of after it (speed quick win 2g, 6 Nov 2026) —
// the fetch handler below answers navigations with that response.
// Old caches: every MatFlow static cache but the current one is deleted, so a
// version bump frees the hashed chunks of every earlier build.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      if (self.registration.navigationPreload) {
        await self.registration.navigationPreload.enable().catch(() => {});
      }
      const names = await caches.keys();
      await Promise.all(
        names
          .filter((name) => name.startsWith("matflow-static-") && name !== STATIC_CACHE)
          .map((name) => caches.delete(name)),
      );
      await self.clients.claim();
    })(),
  );
});

const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Offline — MatFlow</title>
<style>
  body { margin: 0; min-height: 100dvh; display: flex; align-items: center; justify-content: center;
         background: #111111; color: #ffffff; font-family: system-ui, sans-serif; text-align: center; padding: 24px; }
</style>
</head>
<body><p>You're offline — check your connection and try again.</p></body>
</html>`;

// v2 (6 Nov 2026): the bump retires v1, which had grown by every build's
// chunks since the worker shipped; activate deletes it.
const STATIC_CACHE = "matflow-static-v2";

// Content-hashed build assets + immutable app icons: safe to cache-first
// forever — a new build emits new hashed URLs, so nothing here ever goes
// stale. This is what makes repeat page-opens feel instant on the installed
// app. Navigations and API calls stay strictly network-first.
function isImmutableAsset(url) {
  return (
    url.origin === self.location.origin &&
    (url.pathname.startsWith("/_next/static/") ||
      url.pathname.startsWith("/icons/") ||
      url.pathname === "/apple-touch-icon.png")
  );
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  if (event.request.method === "GET" && isImmutableAsset(url)) {
    event.respondWith(
      caches.open(STATIC_CACHE).then(async (cache) => {
        const hit = await cache.match(event.request);
        if (hit) return hit;
        const res = await fetch(event.request);
        if (res.ok) cache.put(event.request, res.clone());
        return res;
      }),
    );
    return;
  }

  // Network-first passthrough; only navigations get an offline fallback.
  // A navigation uses the preloaded response when there is one (activate turns
  // preload on), so the page request is not held up by this worker starting.
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    (async () => {
      try {
        const preloaded = await event.preloadResponse;
        if (preloaded) return preloaded;
        return await fetch(event.request);
      } catch {
        return new Response(OFFLINE_HTML, {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        });
      }
    })(),
  );
});
