/// <reference lib="webworker" />
// Service worker for MatFlow PWA push notifications.
//
// This file is a standalone listener — it is NOT yet registered by a Serwist
// plugin or manual registration call. Until Serwist (or equivalent) is added
// to next.config.ts to serve this file as /sw.js, the handlers below are
// dormant. The web-push delivery path (lib/push.ts) and subscribe endpoint
// (app/api/push/subscribe/route.ts) are fully wired and will queue push
// payloads as soon as the SW is registered.
//
// To register: add @serwist/next or wire a manual registration call in
// app/layout.tsx — both approaches will pick up this file's listeners.

declare const self: ServiceWorkerGlobalScope;

self.addEventListener("push", (event: PushEvent) => {
  if (!event.data) return;
  const payload = event.data.json() as { title: string; body: string; url?: string };
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      icon: "/icons/icon-192.png",
      data: { url: payload.url ?? "/" },
    }),
  );
});

self.addEventListener("notificationclick", (event: NotificationEvent) => {
  event.notification.close();
  const url = (event.notification.data as { url?: string })?.url ?? "/";
  event.waitUntil(self.clients.openWindow(url));
});

export {};
