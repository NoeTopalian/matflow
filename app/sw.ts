/// <reference lib="webworker" />
// Service worker for MatFlow PWA push notifications.
//
// This file remains UNREGISTERED and dormant, deliberately. The service
// worker actually registered in production is the minimal public/sw.js
// (installability only, no push) via components/pwa/RegisterSW.tsx. These
// push handlers stay out of the live SW until real push delivery is proven
// end-to-end. The web-push delivery path (lib/push.ts) and subscribe endpoint
// (app/api/push/subscribe/route.ts) are wired and will work as soon as these
// listeners are merged into the registered SW (or served in its place).

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
