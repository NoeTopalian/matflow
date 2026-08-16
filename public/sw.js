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

self.addEventListener("fetch", (event) => {
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
