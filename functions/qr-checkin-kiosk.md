# QR Check-In Kiosk

> **Status:** ✅ Working · public per-tenant URL via slug · members tap their name → check in · gym branding applied · no auth required.

## Purpose

The "front-desk iPad" experience. The gym mounts a tablet by the door open to `/checkin/{slug}`. Members arriving for class tap their name, the system records an `AttendanceRecord` against today's matching `ClassInstance`, and a confirmation flashes. Zero login, zero typing, ~2 seconds per member.

This is the most-used feature on a busy day — 60 members can check into a 7pm class in 5 minutes.

## URL structure

`/checkin/{tenantSlug}` — public, unauthenticated. The tenant slug (e.g. `totalbjj`) is enough to identify which gym; we never expose member PII at this URL beyond names + ranks.

`tenantSlug` whitelisted in [proxy.ts](../proxy.ts) `PUBLIC_PREFIXES` so the auth gate doesn't 307 the kiosk away.

## Surfaces

- Public kiosk URL: `/checkin/{slug}` — fullscreen-friendly, branded
- Today's classes shown as horizontal cards (current/next highlighted)
- Member grid filtered by class capacity / time-window
- Owner side: QR poster auto-generated from Settings → Branding → "Print kiosk QR"
- Owner can link the same URL on their gym's website / member info pack

## Page structure

[`app/checkin/[slug]/page.tsx`](../app/checkin/[slug]/page.tsx):

```tsx
export default async function CheckinPage({ params }) {
  const { slug } = await params;
  const tenant = await prisma.tenant.findUnique({ where: { slug } });
  if (!tenant) notFound();

  const classes = await prisma.classInstance.findMany({
    where: {
      class: { tenantId: tenant.id },
      date: { gte: startOfDay, lte: endOfDay },
      isCancelled: false,
    },
    include: { class: true, _count: { select: { attendances: true } } },
    orderBy: { startTime: "asc" },
  });

  return (
    <QRCheckinPage
      tenantSlug={slug}
      tenantName={tenant.name}
      primaryColor={tenant.primaryColor}
      logoUrl={tenant.logoUrl}
      todayClasses={...mapped}
    />
  );
}
```

`force-dynamic` so the page never serves stale class data — every refresh re-queries.

## Member selection

`QRCheckinPage` (client component) renders:

1. **Header**: gym logo + name + clock
2. **Today's classes**: horizontal scroll of cards (with capacity / enrolled count)
3. **Selected class** → fetch members eligible for it via `GET /api/checkin/{slug}/members?classInstanceId=...`
4. **Member grid**: alphabetical, with photo / initials, rank chip
5. **Tap member** → `POST /api/checkin/{slug}/attend` → success animation → after 3s, return to grid

### Member listing endpoint

```ts
// app/api/checkin/[slug]/members/route.ts
const tenant = await prisma.tenant.findUnique({where:{slug}});
if (!tenant) return 404;

const members = await prisma.member.findMany({
  where: {
    tenantId: tenant.id,
    status: "active",
    deletedAt: null,
  },
  select: {
    id: true, name: true, photoUrl: true,
    memberRanks: {
      orderBy: { achievedAt: "desc" }, take: 1,
      include: { rankSystem: { select: { color: true } } },
    },
  },
  orderBy: { name: "asc" },
});

return NextResponse.json({ members });
```

PII surface is intentionally minimal: name, photo (optional), top rank colour. No email, no phone, no payment status. A passer-by glancing at the kiosk sees member names — no more.

### Check-in endpoint

```ts
// app/api/checkin/[slug]/attend/route.ts
const { memberId, classInstanceId } = await req.json();

// Tenant-scope BOTH the member and the class via the slug
const tenant = await prisma.tenant.findUnique({where:{slug}});
const member = await prisma.member.findFirst({where:{id: memberId, tenantId: tenant.id}});
const ci = await prisma.classInstance.findFirst({
  where: {id: classInstanceId, class: {tenantId: tenant.id}, isCancelled: false},
});
if (!member || !ci) return 404;

// Idempotent — unique constraint on (memberId, classInstanceId) prevents double check-in
try {
  const att = await prisma.attendanceRecord.create({
    data: {
      memberId, classInstanceId,
      checkInTime: new Date(),
      checkInMethod: "qr_kiosk",
    },
  });

  // Class-pack credit burn (if active pack exists) — see class-pack-purchase-and-redemption.md
  await burnClassPackCreditIfApplicable(member.id, tenant.id, att.id);

  return NextResponse.json({ ok: true, attendanceId: att.id });
} catch (e) {
  if (e.code === "P2002") return NextResponse.json({ ok: true, alreadyCheckedIn: true });
  throw e;
}
```

The P2002 catch makes double-tap (member taps twice in rapid succession) silently succeed.

## Class auto-selection

The kiosk highlights the "current class" — within ±15 mins of `startTime`. If multiple classes match, all are shown; if none, "No classes right now" with a manual class picker.

## Branding

`primaryColor` from `Tenant` is applied as the active-state colour for buttons + selected class cards. `logoUrl` shown top-left. Falls back to MatFlow defaults if either is null.

## Offline / poor-wifi handling

The kiosk is the worst place for a 5G blackspot. Today's posture:

- Member list cached in client state for the session — refresh re-fetches
- Check-in failure shows a red banner with retry — does NOT optimistically mark the member as checked in (lying to the gym is worse than asking them to retry)
- No service worker / offline queue (yet)

A worthwhile follow-up: queue check-ins to localStorage when offline, drain on reconnect.

## QR poster generation

Owner can print a QR poster via Settings → Branding → "Print kiosk QR":

- Server endpoint generates a PNG of the URL via `qrcode` npm package
- Embedded in a printable A4 PDF with gym logo + "Scan to check in"
- Includes the URL as text below the QR (in case scan fails)

## Security

| Control | Where |
|---|---|
| Tenant scope via slug | All queries filter `tenantId = tenant.id` resolved from slug |
| Public-by-design | Whitelisted in proxy.ts PUBLIC_PREFIXES |
| Minimal PII surface | Name + photo + rank only — no email/phone/payment |
| Idempotent check-in | `(memberId, classInstanceId)` unique; double-tap safe |
| `checkInMethod: "qr_kiosk"` audit | Distinguishes from coach-marked attendance |
| Soft-delete respected | `where: {deletedAt: null}` on member listing |
| No write to other tenants | Slug → tenantId resolution scopes everything |
| Class-cancel respected | `isCancelled: false` filter on class instance |
| Rate limit (per-IP) | Optional — depends on per-environment config |

## Known limitations

- **No PIN / face confirmation** — anyone walking up to the kiosk can check in any member by tapping their name. Deliberate trade-off (speed > strict identity), but a 4-digit PIN per member would reduce abuse if a gym needed it.
- **No attendance reversal at the kiosk** — accidentally tapping the wrong member requires a coach to delete the attendance from /admin.
- **No "guest" check-in** — drop-ins / trials have to be added as a member first.
- **No offline mode** — drops connectivity → check-ins fail entirely.
- **No multi-class check-in** — member attending two classes back-to-back has to walk back to the kiosk between them.
- **Photo dependency** — without a member photo, the grid shows initials. Some gyms intentionally don't take photos (privacy of minors), which makes the kiosk visually noisy.
- **No "front-desk staff override"** — a coach watching the kiosk has no privileged controls; they have to use the /admin check-in tool instead.
- **Tablet sleep / kiosk-mode** depends on the gym setting up the device; we don't enforce.

## Test coverage

- E2E test for the happy path (see [admin-checkin.md](admin-checkin.md) for related tests)
- Unit test for the slug → tenantId resolution (recommended)

## Files

- [app/checkin/[slug]/page.tsx](../app/checkin/[slug]/page.tsx) — server component, looks up tenant + classes
- `app/api/checkin/[slug]/members/route.ts` — public member list (minimal PII)
- `app/api/checkin/[slug]/attend/route.ts` — check-in handler
- `components/checkin/QRCheckinPage.tsx` — client UI
- [proxy.ts](../proxy.ts) — `/checkin/` in PUBLIC_PREFIXES
- See [admin-checkin.md](admin-checkin.md), [todays-register.md](todays-register.md), [attendance-log.md](attendance-log.md), [class-pack-purchase-and-redemption.md](class-pack-purchase-and-redemption.md), [proxy-middleware.md](proxy-middleware.md)
