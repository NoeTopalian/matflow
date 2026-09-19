import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { revalidateTag } from "next/cache";
import { z } from "zod";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";
import { requireApiOwner } from "@/lib/api-authz";

// https-only URL validator — blocks javascript:/data:/file: URI XSS in stored
// links (P2 finding from Sprint 3 security gate).
const httpsUrl = () =>
  z
    .string()
    .url()
    .max(300)
    .refine((u) => u.startsWith("https://"), { message: "Must be https://" });

/**
 * A real IANA zone, checked against the runtime's own list.
 *
 * Deliberately stricter than `usableTimezone` (lib/class-time.ts:148), which
 * exists to stop a bad stored value 500ing a coach's Register and so FALLS
 * BACK to Europe/London. A fallback is right on the read side and wrong here:
 * silently storing London when the owner asked for New York is the same lie
 * this route has just stopped telling. `Intl.supportedValuesOf` is the
 * canonical list, so it rejects the near-misses a human types — "London"
 * without a region, or a bare "GMT+5" offset, which is not a zone and does not
 * observe daylight saving.
 */
const IANA_ZONES: ReadonlySet<string> = new Set(Intl.supportedValuesOf("timeZone"));

const ianaTimezone = () =>
  z
    .string()
    .max(64)
    .refine((v) => IANA_ZONES.has(v), {
      message: "Must be an IANA time zone, such as Europe/London or America/New_York",
    });

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  secondaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  bgColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  fontFamily: z.string().max(200).optional(),
  logoSize: z.enum(["sm", "md", "lg"]).optional(),
  // Campaign lane L-B, J12 round 2. This union used to open with a bare
  // `z.string().url()`, and `.url()` is `new URL()`, which parses EVERY
  // scheme — so `data:image/svg+xml;base64,<svg><script>…`, `javascript:` and
  // `file:` all matched the first branch and the two narrow branches after it
  // never got a say. The value is rendered as the club's logo on the member
  // portal, the kiosk and the public waiver page, so that was stored XSS, and
  // a 20 MB data URL slipped past the 3 MB bound the same way. The absolute
  // branch is now https-only, exactly as `httpsUrl()` above already is for
  // every other stored link on this route.
  logoUrl: z.union([
    z.string().url().max(2000).refine((u) => u.startsWith("https://"), {
      message: "Must be https://",
    }),
    z.string().regex(/^\/[^\s]*$/),
    // data: URL fallback when Vercel Blob isn't configured. The bytes are the
    // sharp-resized WebP that /api/upload produced (longest edge ≤1600px), not
    // the file the client sent, and the .max() below is the hard bound.
    // Raster types only: SVG is a script-execution context, not an image.
    z.string().regex(/^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/).max(3_000_000),
  ]).optional().nullable(),
  onboardingCompleted: z.boolean().optional(),
  onboardingAnswers: z.record(z.string(), z.unknown()).optional(),
  waiverTitle: z.string().max(200).optional().nullable(),
  waiverContent: z.string().max(20000).optional().nullable(),
  kidsWaiverTitle: z.string().max(200).optional().nullable(),
  kidsWaiverContent: z.string().max(20000).optional().nullable(),
  // How this club takes money from its members. An enum rather than free text:
  // the member shop branches on it, so a typo would silently route a
  // pay-at-desk club back into Stripe checkout. Nullable means "not chosen",
  // which falls back to whether Stripe is configured — today's behaviour, so
  // existing clubs are unaffected.
  paymentRail: z.enum(["pay_at_desk", "stripe"]).nullable().optional(),
  acceptsBacs: z.boolean().optional(),
  memberSelfBilling: z.boolean().optional(),
  billingContactEmail: z.string().email().max(120).nullable().optional(),
  billingContactUrl: z
    .string()
    .url()
    .max(300)
    .refine((u) => u.startsWith("https://"), { message: "Must be https://" })
    .nullable()
    .optional(),
  // Sprint 3 L: privacy fields. Email goes through .email(); URL is https-only.
  privacyContactEmail: z.string().email().max(120).nullable().optional(),
  privacyPolicyUrl: httpsUrl().nullable().optional(),
  // Sprint 3 L: socials + website (all https-only validated server-side).
  instagramUrl: httpsUrl().nullable().optional(),
  facebookUrl: httpsUrl().nullable().optional(),
  tiktokUrl: httpsUrl().nullable().optional(),
  youtubeUrl: httpsUrl().nullable().optional(),
  twitterUrl: httpsUrl().nullable().optional(),
  websiteUrl: httpsUrl().nullable().optional(),
  // Sub-project #5: optional group-chat invite URL (WhatsApp/Telegram/Discord).
  groupChatUrl: httpsUrl().nullable().optional(),
  checkinWindowBeforeMin: z.number().int().min(0).max(180).optional(),
  checkinWindowAfterMin:  z.number().int().min(0).max(180).optional(),
  // The club's own zone. Read by app/api/coach/today (what is on today),
  // app/api/classes (which day an instance is minted for) and lib/checkin.ts
  // (the check-in window) — and, until now, written by nothing at all, so
  // every club outside Europe/London ran on London time with no way to say so.
  timezone: ianaTimezone().optional(),
})
  // Campaign lane L-B, J12/J16. Zod's default object STRIPS a key it does not
  // know, so this route answered 200 to a body it had not saved: the caller
  // was told the save succeeded and the column never moved. That is exactly
  // how `Tenant.timezone` stayed unwritable without anyone noticing — a PATCH
  // carrying it looked like a success for as long as the field was missing.
  //
  // Safe to tighten because the only two callers were enumerated first
  // (components/dashboard/SettingsPage.tsx and
  // components/onboarding/OwnerOnboardingWizard.tsx, thirty distinct keys
  // between them) and every key they send is declared above — see
  // tests/unit/settings-patch-strict.test.ts, which pins the full list.
  .strict();

export async function GET() {
  // Owner-only, matching this route's own PATCH and the sibling settings/kiosk
  // route, which is owner-only on both verbs.
  //
  // This used to block only `role === "member"`, so every coach and admin in
  // the club could read its subscriptionStatus, subscriptionTier and member /
  // staff / class counts — a commercial standing they have no business seeing,
  // through a route whose write half has always been owner-only.
  //
  // Checked before narrowing rather than assumed: the only two callers are
  // SettingsPage (rendered by /dashboard/settings, which is requireRole(["owner"]))
  // and the owner onboarding wizard. No coach-facing surface reads this.
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const session = gate.session;

  try {
    const tenant = await withTenantContext(session.user.tenantId, (tx) =>
      tx.tenant.findUnique({
        where: { id: session.user.tenantId },
        select: {
          id: true,
          name: true,
          slug: true,
          logoUrl: true,
          logoSize: true,
          primaryColor: true,
          secondaryColor: true,
          textColor: true,
          bgColor: true,
          fontFamily: true,
          // The Settings timezone control reads its current value from here:
          // `app/dashboard/settings/page.tsx` does not carry the column, and
          // the control cannot offer "change this" without first showing what
          // it is. Owner-only, like the rest of this payload.
          timezone: true,
          subscriptionStatus: true,
          subscriptionTier: true,
          createdAt: true,
          _count: {
            select: {
              members: true,
              users: true,
              classes: { where: { isActive: true } },
            },
          },
        },
      }),
    );
    if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json(tenant);
  } catch {
    return NextResponse.json({ error: "Server error" }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isOwner = session.user.role === "owner";
  if (!isOwner) return NextResponse.json({ error: "Only owners can change gym settings" }, { status: 403 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    // Cast needed: Zod's Record<string,unknown> doesn't satisfy Prisma's InputJsonValue for Json fields
    const data = parsed.data as Parameters<typeof prisma.tenant.update>[0]["data"];
    const tenant = await withTenantContext(session.user.tenantId, (tx) =>
      tx.tenant.update({
        where: { id: session.user.tenantId },
        data,
      }),
    );
    // Bust the 60s branding cache so a save shows up on the next member-app
    // open immediately (see app/api/me/gym/route.ts). Best-effort: outside a
    // Next request store (unit tests) revalidateTag throws — the cache then
    // simply expires on its own 60s clock.
    try {
      revalidateTag(`gym-branding-${session.user.tenantId}`, { expire: 0 });
    } catch {}
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "tenant.settings.update",
      entityType: "Tenant",
      entityId: tenant.id,
      metadata: { fields: Object.keys(parsed.data) },
      req,
    });
    return NextResponse.json(tenant);
  } catch {
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }
}
