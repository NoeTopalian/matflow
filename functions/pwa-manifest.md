# PWA Manifest

> **Status:** ✅ Working · `/manifest.webmanifest` served publicly · whitelisted in proxy.ts (otherwise auth gate 307'd it) · iOS + Android home-screen install supported.

## Purpose

Members install MatFlow on their phone home-screen as if it were a native app — tap the icon, get a fullscreen branded experience, no browser chrome. Critical for the member portal because they use it on the way to class with one hand on the bus.

The manifest is also what gives Lighthouse PWA scores; without it we'd lose installability.

## File

`/public/manifest.webmanifest`:

```json
{
  "name": "MatFlow",
  "short_name": "MatFlow",
  "description": "Martial arts gym management platform",
  "start_url": "/",
  "display": "standalone",
  "background_color": "#ffffff",
  "theme_color": "#000000",
  "icons": [
    { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-256.png", "sizes": "256x256", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-384.png", "sizes": "384x384", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
  ],
  "orientation": "portrait",
  "scope": "/",
  "categories": ["fitness", "productivity"]
}
```

### Why per-tenant branding ISN'T in the manifest

The manifest is served from a single static URL — it can't be tenant-specific. The icon + name are platform-level (MatFlow), not gym-level. When a member adds the home-screen icon, it says "MatFlow" not "Total BJJ".

Tenant-specific branding (logo, primary color) IS surfaced via:

- HTML `<title>` per-page (set server-side from session)
- Theme color via `<meta name="theme-color" content="...">` per-page
- Logo + colour throughout the in-app UI

A future enhancement: per-tenant manifests at `/checkin/{slug}/manifest.webmanifest`. Not done because home-screen install is mostly a member-portal concern, and members log in once, not per-tenant.

## Public-by-design

The manifest MUST be reachable without auth — browsers fetch it on every page load to validate the install state, and a 307-to-/login response causes a hard parse error in the browser console.

[proxy.ts](../proxy.ts):

```ts
const PUBLIC_PREFIXES = [
  ...,
  "/manifest.webmanifest",   // PWA manifest — must be reachable while logged-out or browsers log a parse error
  "/icons",                  // PWA icon assets referenced by the manifest
  ...
];
```

This was a real bug we hit pre-launch — manifest 307s in the console were noisy and confused users.

## HTML link tag

Every page renders:

```tsx
// app/layout.tsx
export const metadata = {
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "MatFlow",
  },
  icons: [
    { rel: "icon", url: "/favicon.ico" },
    { rel: "apple-touch-icon", url: "/icons/apple-touch-icon.png" },
  ],
};
```

Next.js converts these into the right `<link rel="manifest">`, `<meta name="apple-mobile-web-app-capable">`, and apple-touch-icon tags.

## Icons

### Standard (192/256/384/512)

Square PNGs of the MatFlow logo on a white background. The 192/512 pair is the minimum requirement; the 256/384 sizes catch device-pixel-ratio combinations Android uses for the home-screen badge.

### Maskable (512 with safe zone)

Android Adaptive Icons crop the icon into a circle, squircle, or other shape depending on the device theme. The maskable variant has a 20% safe-zone padding so the logo isn't truncated when masked. Without this, on Pixel devices our square icon gets clipped to a circle and looks bad.

### Apple touch icon (180×180)

iOS doesn't read maskable variants — it uses `<link rel="apple-touch-icon">` directly and rounds the corners itself.

## `display: standalone`

When installed on the home screen, the app launches without browser chrome (no URL bar, no back button) — looks like a native app. Members use the in-app navigation to move around.

For the kiosk URL (`/checkin/{slug}`), gyms typically install via Chrome's "Add to home screen" + "Open as window" — same standalone display, same manifest.

## `start_url: "/"`

Launches the root, which is the marketing splash. Logged-in users get auto-redirected to `/dashboard` (staff) or `/member/home` (members) by the proxy.

A nicer per-role start_url isn't possible from a single manifest, but we could deep-link via Web Share Target API in future.

## Service worker

**Status:** ❌ Not implemented yet.

Without a service worker:
- App works only when online
- No background sync for offline check-ins
- No push notifications

Service worker is the biggest missing PWA feature. Adding one would require:
- A `sw.js` registered from `app/layout.tsx`
- Cache strategy: stale-while-revalidate for static assets, network-first for API
- Push notification permission flow (member opt-in)

Not blocking launch — most users have connectivity inside gyms. Worth scheduling.

## Lighthouse PWA score

Current: ~95/100. Failing only the "service worker / offline" requirement. Installability ✓, manifest ✓, HTTPS ✓, themed splash ✓, viewport meta ✓.

## Security

| Control | Where |
|---|---|
| Public manifest | Whitelisted in proxy.ts; no auth gate |
| Same-origin scope | `"scope": "/"` confines installed app to our domain |
| HTTPS required | PWA install only works over HTTPS (HSTS enforced) |
| No sensitive data in manifest | Just brand name + icons |
| CSP applies | Manifest fetch passes the same CSP headers as other static files |

## Known limitations

- **No service worker** — no offline mode, no push notifications, no background sync
- **No per-tenant manifest** — home-screen says "MatFlow" not the gym's name
- **No web share target** — can't be the receiving app for shared content
- **Apple-touch-icon is single-size** — modern iOS requests multiple sizes; we serve a single 180×180 for all
- **No splash screen image** — relies on the auto-generated splash from the icon + theme color. iOS specifically prefers explicit splash images
- **No `screenshots` array** — Chrome's install prompt would render screenshots if provided
- **No `shortcuts`** — the manifest could expose quick actions ("Today's classes", "Check in") shown on long-press of the home-screen icon
- **Icons are platform-default** — the MatFlow black-on-white square. No per-tenant white-label icon.

## Test coverage

- Manual: install on iOS + Android, verify standalone launch
- Lighthouse audit on every PR (recommended; not yet wired)
- Manifest JSON validity asserted by Next's build (parse error breaks build)

## Files

- [public/manifest.webmanifest](../public/manifest.webmanifest)
- [public/icons/](../public/icons/) — all icon variants
- `app/layout.tsx` — `metadata.manifest` + `metadata.appleWebApp`
- [proxy.ts](../proxy.ts) — `/manifest.webmanifest` + `/icons` in PUBLIC_PREFIXES
- See [proxy-middleware.md](proxy-middleware.md), [csp-and-security-headers.md](csp-and-security-headers.md), [member-home.md](member-home.md)
