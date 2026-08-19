"use client";

import { useEffect } from "react";

/**
 * Registers the minimal installability service worker (public/sw.js).
 * Production-only: a SW in dev caches against you and serves stale chunks.
 */
export default function RegisterSW() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production") return;
    if (!("serviceWorker" in navigator)) return;
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Non-fatal — the app works without a service worker.
    });
  }, []);

  return null;
}
