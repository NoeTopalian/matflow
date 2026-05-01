# Proxy Middleware

> **Status:** ✅ Working · NextAuth-wrapped middleware enforces auth, role-based routing (member↔staff), and TOTP-pending gating · public prefixes whitelisted.

## Purpose

Single-source enforcement of "who can see what URL". Without it, every page would have to redo auth checks; with it, a misconfigured page is the only way to leak access. The proxy runs on every request before the route handler, so it's the cheapest place to fail closed.

It does four things:

1. Lets a small list of public URLs through unchanged
2. Redirects unauthenticated users to `/login`
3. Forces TOTP-pending users to `/login/totp` (and away from anything else)
4. Routes members away from `/dashboard/*` and staff away from `/member/*`

The file is named `proxy.ts` rather than the conventional `middleware.ts` for legacy reasons — Next.js detects either, but `proxy.ts` is what we have.

## File — `proxy.ts`

```ts
import { auth } from "@/auth";
import { NextResponse } from "next/server";

const PUBLIC_PREFIXES = [
  "/login",
  "/api/auth",
  "/api/magic-link",
  "/api/tenant",
  "/api/apply",
  "/api/webhooks",          // Resend webhooks — Svix signature verified in handler
  "/api/stripe/webhook",    // Stripe webhook — signature verified in handler
  "/api/cron",              // Vercel cron — Bearer secret verified in handler
  "/api/checkin",           // QR check-in — HMAC token verified + rate-limited
  "/api/members/accept-invite",  // LB-003: invite-token-gated
  "/apply",
  "/checkin",               // QR landing page
  "/legal",                 // Public legal pages
  "/onboarding",            // Post-apply onboarding step
  "/preview",               // Public preview page
  "/_next",
  "/favicon",
  "/manifest.webmanifest",
  "/icons",
  "/robots.txt",
  "/sitemap.xml",
];

export default auth(function proxy(req) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  if (!req.auth) {
    return NextResponse.redirect(new URL("/login", req.url));
  }

  const totpPending = (req.auth.user as any)?.totpPending;
  if (totpPending === true && pathname !== "/login/totp") {
    return NextResponse.redirect(new URL("/login/totp", req.url));
  }
  if (totpPending !== true && pathname === "/login/totp") {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  const role = (req.auth.user as any)?.role as string | undefined;

  if (role === "member" && pathname.startsWith("/dashboard")) {
    return NextResponse.redirect(new URL("/member/home", req.url));
  }

  if (role !== "member" && pathname.startsWith("/member")) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  return NextResponse.next();
});

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
```

## Public prefixes — why each is on the list

| Prefix | Why public |
|---|---|
| `/login` | Login page itself — gating it would 307-loop |
| `/api/auth` | NextAuth's own callback URLs |
| `/api/magic-link` | Public magic-link consumer (LB pre-launch — moved out of `/api/auth/` to escape NextAuth catch-all) |
| `/api/tenant` | Public tenant-meta lookups (used by login page to render branding) |
| `/api/apply` | Public apply form submit |
| `/api/webhooks` | Resend (and other) inbound webhooks — signature verified in handler |
| `/api/stripe/webhook` | Stripe webhook — signature verified in handler |
| `/api/cron` | Vercel cron — Bearer secret verified in handler |
| `/api/checkin` | QR check-in API — slug + HMAC verified in handler |
| `/api/members/accept-invite` | LB-003 — token-gated public acceptance |
| `/apply` | Public lead-capture form |
| `/checkin` | QR check-in landing pages — public by design |
| `/legal` | Public legal pages (terms/privacy/AUP/subprocessors) |
| `/onboarding` | Post-apply onboarding flow |
| `/preview` | Public preview pages (marketing) |
| `/_next` | Next.js static asset paths |
| `/favicon` | Browser-requested icon |
| `/manifest.webmanifest` | PWA manifest — must reach unauthenticated |
| `/icons` | PWA icon assets referenced from manifest |
| `/robots.txt` + `/sitemap.xml` | SEO assets |

Any addition to this list is a security decision — every entry is a route the auth gate doesn't see. Reviewer should ask: is the handler downstream of this prefix doing its own gating?

## TOTP gating

When a user with TOTP enabled signs in, NextAuth issues a JWT with `totpPending: true`. Until they complete the TOTP step at `/login/totp`, every other route 307s back to `/login/totp`. Inverse: if they're NOT pending and try to visit `/login/totp`, redirect to `/dashboard` to avoid a confusing dead-end.

This is the only piece of session state that controls routing besides `role`. Adding more flags here (e.g. `passwordChangeRequired`) is intentional friction — keep the list short.

## Member↔staff URL split

- `role === "member"` → only `/member/*` allowed; anything else under `/dashboard` redirects to `/member/home`
- `role !== "member"` → `/member/*` redirects to `/dashboard`

This isn't an authorisation decision (the API still enforces `requireStaff()` etc.) — it's a navigation guardrail. A coach landing on `/member/home` would render an empty profile because their User has no Member row.

## Auth gate vs API authz

The proxy gates URLs. API authz (`requireStaff`, `requireOwnerOrManager`, `requireOwner`, `requireMember`) gates **operations**.

A request to `/api/members/123` with no session bounces at the proxy with 307→/login. With a valid session, the proxy lets it through, and `requireStaff()` inside the route checks role — a member would 403 there.

Both layers are important — defence in depth.

## `matcher` regex

```ts
matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"]
```

Excludes static asset paths from middleware execution entirely (saves a few ms per asset request). NOT exhaustive — `/manifest.webmanifest` and `/icons/*` still hit middleware and rely on `PUBLIC_PREFIXES` to pass through.

## Edge runtime

Middleware runs on Vercel's Edge runtime — small bundle, fast cold-start, no Node-only APIs. `auth()` from NextAuth is edge-compatible. Inside the proxy we deliberately avoid any DB calls (proxy must be cheap), so no `prisma` import.

## Security

| Control | Where |
|---|---|
| Default-deny | Anything not in `PUBLIC_PREFIXES` requires session |
| TOTP gate | Pending users can ONLY reach `/login/totp` |
| Member↔staff split | URL-level guardrail in addition to API authz |
| No DB lookup | Proxy is pure JWT inspection — no I/O on hot path |
| Same-origin only | NextAuth's CSRF state ensures the redirect URL is same-origin |
| Public prefixes audited | Every entry has a reason captured in the comment |

## Known limitations

- **`PUBLIC_PREFIXES` is hand-maintained** — adding a new public route requires editing here. No automated check.
- **JWT inspection is opaque to revocation** — see [session-version-rotation.md](session-version-rotation.md). The proxy only checks `req.auth` exists; doesn't verify session version against DB (which would require I/O).
- **No per-tenant route customisation** — every tenant gets the same routing rules. A "members can also access reports" override isn't possible at the proxy.
- **`totpPending` is a duck-typed cast** — `(req.auth.user as any)?.totpPending`. A typed Auth.js v5 module augmentation would be safer.
- **Race between login + first request** — JWT is set on the response of `/api/auth/callback/credentials`; the next page load reads it. No race in practice but theoretical with parallel tabs.
- **No Vercel preview-deployment gating** — production middleware runs on previews too. Branch protection enforces "only review-approved deployment is public".

## Test coverage

- [tests/integration/security.test.ts](../tests/integration/security.test.ts) — asserts public routes are reachable, gated routes 307, role-mismatched URLs redirect

## Files

- [proxy.ts](../proxy.ts) — the entire middleware
- [auth.ts](../auth.ts) — NextAuth config, source of `req.auth.user`
- [lib/authz.ts](../lib/authz.ts) — API-side role helpers (defence in depth)
- See [session-and-cookies.md](session-and-cookies.md), [session-version-rotation.md](session-version-rotation.md), [totp-2fa.md](totp-2fa.md), [multi-tenant-isolation.md](multi-tenant-isolation.md), [pwa-manifest.md](pwa-manifest.md)
