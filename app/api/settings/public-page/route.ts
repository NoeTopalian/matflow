/**
 * GET/PATCH /api/settings/public-page — the club's opt-in public page (T9c).
 *
 * Owner only (Q9, Noe 17 Oct 2026: owner self-service). Every support session
 * is refused on PATCH, the Edit scope included: publishing a club to search
 * engines cannot be recalled by a redeploy, so it stays with the owner (T9c
 * acceptance 5). The route is deliberately NOT on
 * SUPPORT_EDIT_MUTATION_ALLOWLIST.
 *
 * Every change writes a durable audit row in the same transaction:
 * `tenant.public_page.published` / `.unpublished` when the switch moves,
 * `tenant.public_page.update` for content or price-visibility edits.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { revalidatePath } from "next/cache";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { refuseSupportSession } from "@/lib/support-session";
import { assertSameOrigin } from "@/lib/csrf";
import { logAuditStrict } from "@/lib/audit-log";
import { updateMetadata } from "@/lib/audit-snapshot";
import { formatTierPrice, PRICE_NOT_SET } from "@/lib/membership-tier-format";
import { forgetPublicGate } from "@/lib/public-club-page-server";
import {
  PUBLIC_ADDRESS_MAX,
  PUBLIC_DESCRIPTION_MAX,
  PUBLIC_EMAIL_MAX,
  PUBLIC_PHONE_MAX,
  clubPageUrl,
  inlineLogo,
} from "@/lib/public-club-page";

const PUBLIC_FIELDS = {
  publicPageEnabled: true,
  publicPageEnabledAt: true,
  publicPageDescription: true,
  publicPageEmail: true,
  publicPagePhone: true,
  publicPageAddress: true,
} as const;

const AUDITED_FIELDS = [
  "publicPageEnabled",
  "publicPageDescription",
  "publicPageEmail",
  "publicPagePhone",
  "publicPageAddress",
] as const;

/** Trimmed text; an empty string clears the field. */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((v) => v.trim())
    .transform((v) => (v === "" ? null : v))
    .nullable()
    .optional();

const publicPagePatchSchema = z
  .object({
    enabled: z.boolean().optional(),
    description: optionalText(PUBLIC_DESCRIPTION_MAX),
    // Trimmed BEFORE the empty check, so a field of only spaces clears it
    // rather than failing validation.
    email: z
      .string()
      .trim()
      .pipe(
        z.union([
          z.literal(""),
          z
            .string()
            .max(PUBLIC_EMAIL_MAX, { message: `Keep the email to ${PUBLIC_EMAIL_MAX} characters or fewer.` })
            .email({ message: "Enter a valid email address, such as hello@yourclub.com." }),
        ]),
      )
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional(),
    phone: z
      .string()
      .trim()
      .pipe(
        z.union([
          z.literal(""),
          z
            .string()
            .max(PUBLIC_PHONE_MAX, { message: `Keep the phone number to ${PUBLIC_PHONE_MAX} characters or fewer.` })
            .regex(/^\+?[0-9 ()-]{5,}$/, {
              message: "Enter a phone number using digits, spaces, brackets or hyphens, with an optional leading +.",
            }),
        ]),
      )
      .transform((v) => (v === "" ? null : v))
      .nullable()
      .optional(),
    address: optionalText(PUBLIC_ADDRESS_MAX),
    /** The FULL set of tiers whose price shows publicly (replace semantics). */
    publicTierIds: z.array(z.string().min(1).max(64)).max(200).optional(),
  })
  .strict();

type TierRow = { id: string; name: string; pricePence: number; currency: string; billingCycle: string; showOnPublicPage: boolean };

function tierView(t: TierRow) {
  const price = formatTierPrice(t);
  return { id: t.id, name: t.name, price, priceKnown: price !== PRICE_NOT_SET, showOnPublicPage: t.showOnPublicPage };
}

const TIER_SELECT = { id: true, name: true, pricePence: true, currency: true, billingCycle: true, showOnPublicPage: true } as const;

export async function GET() {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const tenantId = gate.tenantId;
  try {
    const { tenant, tiers } = await withTenantContext(tenantId, async (tx) => {
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { slug: true, reviewLockedAt: true, logoUrl: true, ...PUBLIC_FIELDS },
      });
      const tiers = await tx.membershipTier.findMany({
        where: { tenantId, isActive: true },
        select: TIER_SELECT,
        orderBy: [{ pricePence: "asc" }, { name: "asc" }],
      });
      return { tenant, tiers };
    });
    if (!tenant) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({
      enabled: tenant.publicPageEnabled,
      enabledAt: tenant.publicPageEnabledAt?.toISOString() ?? null,
      description: tenant.publicPageDescription,
      email: tenant.publicPageEmail,
      phone: tenant.publicPagePhone,
      address: tenant.publicPageAddress,
      url: clubPageUrl(tenant.slug),
      path: `/${tenant.slug}`,
      reviewLocked: tenant.reviewLockedAt !== null,
      // A logo is set but cannot be served anonymously (a legacy private-blob
      // or external logo, which T9b does not migrate): the public page shows
      // the letter avatar instead, so Settings says so.
      logoNotPublic: !!tenant.logoUrl && inlineLogo(tenant.logoUrl) === null,
      tiers: tiers.map(tierView),
    });
  } catch (e) {
    console.error("[settings/public-page] read failed", e);
    return NextResponse.json({ error: "Couldn't load the public page settings." }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  // Before the role gate: an operator acting as the owner (either scope) is
  // refused here, so the refusal does not depend on the session's role.
  const session = await auth();
  const support = refuseSupportSession(session);
  if (support) return support;

  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const tenantId = gate.tenantId;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const parsed = publicPagePatchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }
  const input = parsed.data;
  const sentFields = Object.keys(input);

  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      const before = await tx.tenant.findFirst({ where: { id: tenantId }, select: { id: true, slug: true, ...PUBLIC_FIELDS } });
      if (!before) return { notFound: true } as const;

      const tiersBefore = await tx.membershipTier.findMany({
        where: { tenantId, showOnPublicPage: true },
        select: { id: true },
      });

      if (input.publicTierIds) {
        const wanted = [...new Set(input.publicTierIds)];
        const own = await tx.membershipTier.findMany({ where: { tenantId, id: { in: wanted } }, select: { id: true } });
        // A tier id from another club (or none at all) is refused outright,
        // never silently dropped.
        if (own.length !== wanted.length) return { refused: "One or more of those memberships isn't in this club." } as const;
        await tx.membershipTier.updateMany({
          where: { tenantId, showOnPublicPage: true, id: { notIn: wanted } },
          data: { showOnPublicPage: false },
        });
        if (wanted.length) {
          await tx.membershipTier.updateMany({ where: { tenantId, id: { in: wanted } }, data: { showOnPublicPage: true } });
        }
      }

      const data: Record<string, unknown> = {};
      if (input.description !== undefined) data.publicPageDescription = input.description;
      if (input.email !== undefined) data.publicPageEmail = input.email;
      if (input.phone !== undefined) data.publicPagePhone = input.phone;
      if (input.address !== undefined) data.publicPageAddress = input.address;
      if (input.enabled !== undefined && input.enabled !== before.publicPageEnabled) {
        data.publicPageEnabled = input.enabled;
        data.publicPageEnabledAt = input.enabled ? new Date() : null;
      }

      const after = Object.keys(data).length
        ? await tx.tenant.update({ where: { id: tenantId }, data, select: { id: true, slug: true, ...PUBLIC_FIELDS } })
        : before;

      const tiersAfter = input.publicTierIds
        ? await tx.membershipTier.findMany({ where: { tenantId, showOnPublicPage: true }, select: { id: true } })
        : tiersBefore;

      const switched = before.publicPageEnabled !== after.publicPageEnabled;
      const action = switched
        ? after.publicPageEnabled
          ? "tenant.public_page.published"
          : "tenant.public_page.unpublished"
        : "tenant.public_page.update";
      const beforeTierIds = tiersBefore.map((t) => t.id).sort();
      const afterTierIds = tiersAfter.map((t) => t.id).sort();
      const tiersChanged = JSON.stringify(beforeTierIds) !== JSON.stringify(afterTierIds);

      await logAuditStrict(tx, {
        tenantId,
        userId: gate.userId,
        action,
        entityType: "Tenant",
        entityId: tenantId,
        metadata: {
          ...updateMetadata(sentFields, before, after, AUDITED_FIELDS),
          ...(tiersChanged ? { publicTierIdsBefore: beforeTierIds, publicTierIdsAfter: afterTierIds } : {}),
        },
        req,
      });
      return { after } as const;
    });

    if ("notFound" in outcome) return NextResponse.json({ error: "Not found" }, { status: 404 });
    if ("refused" in outcome) return NextResponse.json({ error: outcome.refused }, { status: 400 });

    // Best-effort: the page is rendered per request anyway; outside a Next
    // request store (unit tests) revalidatePath throws.
    try {
      revalidatePath(`/${outcome.after.slug}`);
    } catch {}
    // This instance's gate cache answers at once; others within its 30 s TTL.
    forgetPublicGate(outcome.after.slug);

    return NextResponse.json({
      ok: true,
      enabled: outcome.after.publicPageEnabled,
      enabledAt: outcome.after.publicPageEnabledAt?.toISOString() ?? null,
    });
  } catch (e) {
    console.error("[settings/public-page] update failed", e);
    return NextResponse.json({ error: "Couldn't save the public page settings. Nothing has changed." }, { status: 500 });
  }
}
