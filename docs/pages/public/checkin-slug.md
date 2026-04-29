# /checkin/[slug]

| | |
|---|---|
| **File** | app/checkin/[slug]/page.tsx |
| **Section** | public |
| **Auth gating** | PUBLIC_PREFIXES includes `/checkin` — no auth required |
| **Roles allowed** | unauthenticated (member-facing QR landing page) |
| **Status** | ✅ working |

## Purpose
QR-code check-in landing page for members. The gym owner displays a QR code that encodes `/checkin/<tenant-slug>`. Members scan it on their phone, land here, select their class, and check themselves in. The server component looks up the tenant by `slug`, fetches today's class instances (non-cancelled, ordered by start time), then renders the `QRCheckinPage` client component with the tenant branding and class list. Marked `force-dynamic` to ensure fresh class data on every request.

## Inbound links
— (accessed by scanning a physical QR code; no in-app links)

## Outbound links
— (self-contained; members check in and leave)

## API calls
| Method | Endpoint | Purpose |
|---|---|---|
| — | prisma.tenant.findUnique | Resolve slug to tenant (server-side) |
| — | prisma.classInstance.findMany | Fetch today's non-cancelled class instances (server-side) |

## Sub-components
- QRCheckinPage ([components/checkin/QRCheckinPage.tsx](../../components/checkin/QRCheckinPage.tsx)) — full client-side check-in flow: class selection, member lookup, attendance recording via `/api/checkin`

## Mobile / responsive
- QRCheckinPage is mobile-first; designed for phones scanning a QR code.

## States handled
- Server: `notFound()` if tenant slug does not exist or DB error on tenant lookup.
- Server: empty `todayClasses` array if class lookup fails (DB error logged, graceful degradation).
- Client (QRCheckinPage): handles no-classes-today empty state, loading, and check-in success/error states.

## Known issues
- **P1 ✅ Closed** (`79afaab`) — was returning 404 intermittently; fixed with `force-dynamic` export and try/catch logging on DB calls.

## Notes
The `[slug]` parameter is the tenant's unique URL-safe identifier (e.g. `totalbjj`). The HMAC token verification and rate limiting mentioned in proxy.ts comments apply to `/api/checkin` (the POST endpoint), not this landing page.
