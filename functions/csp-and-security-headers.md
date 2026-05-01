# CSP & Security Headers

> **Status:** ✅ Working · CSP set globally via [next.config.ts](../next.config.ts) headers · HSTS / X-Frame-Options / Referrer-Policy / Permissions-Policy / X-Content-Type-Options all set · Stripe + Resend + Vercel Blob origins explicitly allow-listed.

## Purpose

Defence-in-depth against XSS, clickjacking, MITM downgrade, MIME-sniffing, and overly permissive browser features. The headers below are the cheapest, broadest mitigations — many incidents that would otherwise be exploitable get neutered before they reach the route handler.

## Headers configured

In [next.config.ts](../next.config.ts) under `headers()`:

### `Content-Security-Policy`

```
default-src 'self';
script-src 'self' 'unsafe-inline' https://js.stripe.com https://*.vercel-insights.com;
style-src 'self' 'unsafe-inline';
img-src 'self' data: blob: https://*.vercel-storage.com https://*.googleusercontent.com https://q.stripe.com;
font-src 'self' data:;
connect-src 'self' https://api.stripe.com https://api.resend.com https://*.googleapis.com https://api.anthropic.com https://*.vercel-insights.com;
frame-src https://js.stripe.com https://hooks.stripe.com;
worker-src 'self' blob:;
object-src 'none';
base-uri 'self';
form-action 'self';
frame-ancestors 'none';
upgrade-insecure-requests;
```

Notes on each directive:

- **`'unsafe-inline'` for scripts** — Next.js + Tailwind require it for inlined `<script>` and `<style>` blocks. We accept the trade-off because:
  - Most XSS would land in DOM strings, where React's escaping protects us
  - Adding nonces would require a server-side rewrite of every page (Next has partial support)
- **`https://js.stripe.com`** — Stripe Elements + Connect onboarding load JS from there
- **`https://*.googleapis.com`** — Drive API + the OAuth picker
- **`frame-ancestors 'none'`** — equivalent to `X-Frame-Options: DENY` (anti-clickjacking)
- **`object-src 'none'`** — no plugins, no Flash legacy
- **`upgrade-insecure-requests`** — auto-rewrites mixed-content `http://` → `https://`

### `Strict-Transport-Security`

```
max-age=31536000; includeSubDomains; preload
```

1 year HSTS. `preload` opts us into the browser-vendored HSTS list — once submitted to hstspreload.org, every browser downgrade-blocks the domain forever (uninstallable).

### `X-Frame-Options`

```
DENY
```

Belt-and-braces alongside CSP `frame-ancestors 'none'`. Older browsers ignore CSP but respect X-Frame-Options.

### `X-Content-Type-Options`

```
nosniff
```

Prevents the browser from MIME-sniffing a `text/plain` upload as `text/html` and executing it.

### `Referrer-Policy`

```
strict-origin-when-cross-origin
```

Same-origin requests get full referrer; cross-origin only gets the origin (no path). Trade-off: don't leak member-detail URLs to third parties via outbound links.

### `Permissions-Policy`

```
camera=(), microphone=(), geolocation=(), payment=(self "https://js.stripe.com"), usb=(), interest-cohort=()
```

Most browser features disabled; `payment` allowed for Stripe Elements. `interest-cohort=()` opts out of Google's FLoC.

### `X-DNS-Prefetch-Control`

```
on
```

Allows the browser to pre-resolve outbound hostnames (Stripe, Resend) for marginal latency wins.

## Where they're applied

```ts
// next.config.ts
async headers() {
  return [
    {
      source: "/:path*",
      headers: [
        { key: "Content-Security-Policy", value: CSP_VALUE },
        { key: "Strict-Transport-Security", value: HSTS_VALUE },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        { key: "Permissions-Policy", value: PERMISSIONS_VALUE },
        { key: "X-DNS-Prefetch-Control", value: "on" },
      ],
    },
  ];
}
```

Applied to every route — including API routes (which is fine; they don't render HTML but the CSP header is still cheap).

## Testing

- [tests/integration/security.test.ts](../tests/integration/security.test.ts) asserts the headers are present + correctly valued on key endpoints
- Use https://securityheaders.com/?q=matflow.studio to spot-check after deploy
- CSP violations are surfaced in the browser console; production has no `report-uri` configured today

## Why no nonces / hashes

Next.js's app router doesn't natively inject CSP nonces into all generated `<script>` tags. We chose `'unsafe-inline'` over fighting the framework. The trade-off:

- **What we lose**: a true XSS would execute (nonce-mode would block it)
- **What protects us instead**: React's auto-escaping + zero `dangerouslySetInnerHTML` usage in user-controlled paths

If a page ever renders user-submitted HTML directly, the calculus flips and we'd need nonces.

## Stripe-specific allowances

- `script-src` allows `https://js.stripe.com` for the Payment Element / Connect onboarding bundle
- `frame-src` allows `https://js.stripe.com` and `https://hooks.stripe.com` for the embedded card iframe
- `connect-src` allows `https://api.stripe.com` for client-side webhook checks
- `img-src` allows `https://q.stripe.com` for Stripe pixel-tracking

These origins ARE the Stripe SDK; locking them out breaks payment.

## Resend / Anthropic / Google

- `connect-src` allows `https://api.resend.com` (we proxy from server, but client retries hit it directly)
- `connect-src` allows `https://api.anthropic.com` (only used server-side; safety belt)
- `connect-src` + `img-src` allow `https://*.googleapis.com` and `https://*.googleusercontent.com` for the Drive picker UI

## Vercel Blob

- `img-src` allows `https://*.vercel-storage.com` for uploaded photos / posters

## Known limitations

- **`'unsafe-inline'` in script-src** — biggest residual XSS exposure. Worth revisiting when Next gains better nonce support.
- **No CSP `report-uri`** — violations land in the user's console but we don't aggregate. Adding `report-uri /api/csp-report` + a logger would catch real-world breakage.
- **Permissions-Policy doesn't cover all features** — newer policies (`autoplay`, `encrypted-media`) inherit defaults; would be tighter to enumerate.
- **HSTS preload not yet submitted** — to be done after we're confident no `http://` leaks remain.
- **`*.googleusercontent.com` is broad** — narrower allow-list would be safer; this matches the Drive API patterns we hit.
- **CSP is identical for marketing + app routes** — could be tighter on `/legal/*` (no Stripe needed there).
- **No Subresource Integrity (SRI)** on third-party scripts — Stripe's bundle is loaded without integrity hash. Stripe doesn't publish stable hashes, so SRI is impractical.

## Test coverage

- Header presence + values asserted in [tests/integration/security.test.ts](../tests/integration/security.test.ts)
- Manual spot-check via securityheaders.com after deploy

## Files

- [next.config.ts](../next.config.ts) — `headers()` config
- [tests/integration/security.test.ts](../tests/integration/security.test.ts) — header assertion tests
- See [proxy-middleware.md](proxy-middleware.md), [encryption-secrets.md](encryption-secrets.md), [pwa-manifest.md](pwa-manifest.md)
