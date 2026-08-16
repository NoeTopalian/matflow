// MatFlow minimal service worker — installability only.
// Deliberately no push handlers: push lives in app/sw.ts and stays dormant
// until real delivery is proven. No precache manifest; network-first always.

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
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

const STATIC_CACHE = "matflow-static-v1";

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
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(OFFLINE_HTML, {
          status: 503,
          headers: { "Content-Type": "text/html; charset=utf-8" },
        }),
    ),
  );
});
