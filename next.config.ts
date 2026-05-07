import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// Build CSP at config-load time. Some directives differ between dev (Turbopack
// HMR needs eval, websockets to localhost) and production (lock everything down).
const csp = [
  "default-src 'self'",
  // Scripts: drop 'unsafe-eval' in production. Turbopack/HMR needs it in dev.
  // Vercel Analytics + Stripe.js are first-party trusted.
  `script-src 'self' 'unsafe-inline'${isProd ? "" : " 'unsafe-eval'"} https://va.vercel-scripts.com https://js.stripe.com`,
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  // Images: blob: covers signed waiver previews; https: covers Vercel Blob CDN.
  "img-src 'self' data: blob: https:",
  // Outbound connections: Sentry ingest (when configured), Stripe API,
  // Vercel infra, and Google OAuth's accounts endpoint for the OAuth flow.
  `connect-src 'self' https://*.vercel-storage.com https://*.vercel-insights.com https://*.ingest.sentry.io https://*.ingest.us.sentry.io https://api.stripe.com https://accounts.google.com${isProd ? "" : " ws://localhost:* http://localhost:*"}`,
  // Stripe.js renders an iframe for hosted Checkout / Elements. Allow it
  // narrowly rather than opening up frame-src globally.
  "frame-src 'self' https://js.stripe.com https://hooks.stripe.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  // Forces all subresource loads to upgrade to HTTPS in production.
  ...(isProd ? ["upgrade-insecure-requests"] : []),
].join("; ");

const nextConfig: NextConfig = {
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
          {
            // Deny browser features the app doesn't use. Reduces blast radius
            // of any future XSS — even if attacker injects a script, they
            // can't pop the camera, geolocation, or initiate Web Bluetooth.
            key: "Permissions-Policy",
            value: [
              "camera=()",
              "microphone=()",
              "geolocation=()",
              "payment=(self)",
              "usb=()",
              "midi=()",
              "magnetometer=()",
              "gyroscope=()",
              "accelerometer=()",
              "fullscreen=(self)",
              "interest-cohort=()", // opt out of FLoC tracking
            ].join(", "),
          },
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          // COEP `credentialless` enables cross-origin isolation without
          // forcing every cross-origin resource to send CORP headers
          // (`require-corp` would break Stripe.js, Vercel Analytics, etc.).
          // CORP `same-origin` blocks OUR resources from being embedded by
          // other origins. Together with COOP these form the cross-origin
          // isolation triple. (Security audit iter-2 / L5, 2026-05-07.)
          { key: "Cross-Origin-Embedder-Policy", value: "credentialless" },
          { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
          { key: "Content-Security-Policy", value: csp },
        ],
      },
    ];
  },
};

export default nextConfig;
