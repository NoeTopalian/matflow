/**
 * POST /api/admin/applications/[id]/approve
 *
 * Approves a pending GymApplication: creates the Tenant + owner User and
 * mints an owner_activation magic-link so they can sign in and set their
 * own password. Replaces the manual `curl /api/admin/create-tenant` flow.
 *
 * Body (optional): { primaryColor?: "#abc123", subscriptionTier?: "starter|pro|elite|enterprise" }
 *
 * Cookie- or header-gated by isAdminAuthed.
 */
import { NextResponse } from "next/server";
import { z } from "zod";
import { randomBytes } from "crypto";
import bcrypt from "bcryptjs";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { sendEmail } from "@/lib/email";
import { isEmailDeliveryOn } from "@/lib/email-delivery";
import { hashToken } from "@/lib/token-hash";
import { getBaseUrl } from "@/lib/env-url";
import { getOperatorContext } from "@/lib/operator-context";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { assertSameOrigin } from "@/lib/csrf";

// Audit iter-1-operator-admin A6I1-S-5: rate-limit destructive admin ops.
const RL_MAX = 20;
const RL_WINDOW_MS = 60 * 60 * 1000;

const bodySchema = z.object({
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  subscriptionTier: z.enum(["starter", "pro", "elite", "enterprise"]).optional(),
}).optional();

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || `gym-${Date.now()}`;
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // CSRF. The operator plane was excluded from the earlier sweep on the
  // reasoning that it is token-authenticated and therefore exempt. That does
  // not hold: the operator session is carried by a COOKIE, and a cookie rides
  // along on a cross-site form post. So every mutation here was reachable from
  // any page the operator happened to have open — on the most powerful surface
  // in the product.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const operator = await getOperatorContext(req);
  if (!operator.authed) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const rl = await checkRateLimit(`admin:application-action:${operator.operatorId}:${getClientIp(req)}`, RL_MAX, RL_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many admin actions. Try again shortly." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const { id } = await ctx.params;

  const raw = await req.text();
  let body: z.infer<typeof bodySchema> = undefined;
  if (raw.trim().length > 0) {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
    const result = bodySchema.safeParse(parsed);
    if (!result.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });
    body = result.data;
  }

  // Find the application (cross-tenant scope — use bypass).
  const application = await withRlsBypass((tx) =>
    tx.gymApplication.findUnique({ where: { id } }),
  );
  if (!application) {
    return NextResponse.json({ error: "Application not found" }, { status: 404 });
  }
  if (application.status === "approved") {
    return NextResponse.json({ error: "Application already approved" }, { status: 409 });
  }

  // Generate a slug. If it collides, append a short suffix.
  let slug = slugify(application.gymName);
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await withRlsBypass((tx) => tx.tenant.findUnique({ where: { slug } }));
    if (!existing) break;
    slug = `${slugify(application.gymName)}-${randomBytes(2).toString("hex")}`;
  }

  // Random temp password the owner never sees — they sign in via magic link
  // and change it via Settings → Account on first login.
  const tempPassword = randomBytes(18).toString("base64").slice(0, 24);
  const passwordHash = await bcrypt.hash(tempPassword, 12);

  let tenantId: string;
  let ownerUserId: string;
  try {
    const tenant = await withRlsBypass((tx) =>
      tx.tenant.create({
        data: {
          name: application.gymName,
          slug,
          primaryColor: body?.primaryColor ?? "#3b82f6",
          secondaryColor: "#2563eb",
          subscriptionStatus: "trial",
          subscriptionTier: body?.subscriptionTier ?? "pro",
          users: {
            create: {
              email: application.email.toLowerCase().trim(),
              passwordHash,
              name: application.contactName,
              role: "owner",
            },
          },
        },
        include: { users: { select: { id: true } } },
      }),
    );
    tenantId = tenant.id;
    ownerUserId = tenant.users[0].id;
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "A gym with that slug already exists" }, { status: 409 });
    }
    console.error(`[admin/applications/${id}/approve] tenant create failed`, e);
    return NextResponse.json({ error: "Failed to create tenant" }, { status: 500 });
  }

  // Mint an owner-activation magic-link token (30-min expiry, same shape as login)
  // — but only when email is on (review defect 5, 7 Oct 2026). With
  // EMAIL_DELIVERY=off nobody can receive it, so minting it would only leave a
  // live sign-in credential lying in the database. The response says plainly
  // that no link exists; the operator gives the owner access another way.
  const deliveryOn = isEmailDeliveryOn();
  let token: string | null = null;
  if (deliveryOn) {
    token = randomBytes(32).toString("hex");
    const tokenHash = hashToken(token);
    const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
    await withTenantContext(tenantId, (tx) =>
      tx.magicLinkToken.create({
        data: {
          tenantId,
          email: application.email.toLowerCase().trim(),
          tokenHash,
          purpose: "first_time_signup",
          expiresAt,
        },
      }),
    );
  }

  // Flip application to approved (cross-tenant scope — bypass).
  await withRlsBypass((tx) =>
    tx.gymApplication.update({
      where: { id },
      data: { status: "approved" },
    }),
  );

  // Audit-log the approval.
  void logAudit({
    tenantId,
    userId: null,
    action: "admin.application.approve",
    entityType: "GymApplication",
    entityId: id,
    metadata: {
      tenantSlug: slug,
      ownerEmail: application.email,
      ownerUserId,
      operatorEmail: operator.operatorEmail,
      activationLinkCreated: token !== null,
    },
    actAsUserId: operator.operatorId,
    req,
  }).catch(() => {});

  // Send the activation email. Best-effort — DB state stays correct even if email fails.
  const baseUrl = getBaseUrl(req);
  const link = token
    ? `${baseUrl}/api/magic-link/verify?token=${encodeURIComponent(token)}&tenantSlug=${encodeURIComponent(slug)}`
    : undefined;
  // `activationEmailSent` / `activationLinkCreated` are what the operator screen
  // reports (7 Oct 2026, mail-dark): it is never told the contact was emailed
  // unless sendEmail says so, and with email off it is told no link exists.
  let activationEmailSent = false;
  if (!link) {
    console.warn(`[admin/applications/${id}/approve] email is turned off (EMAIL_DELIVERY=off) — no activation link was created or sent`);
  } else if (process.env.RESEND_API_KEY) {
    try {
      const sent = await sendEmail({
        tenantId,
        templateId: "owner_activation",
        to: application.email.toLowerCase().trim(),
        vars: {
          contactName: application.contactName,
          gymName: application.gymName,
          clubCode: slug,
          link,
        },
      });
      activationEmailSent = sent.ok;
      if (sent.suppressed) {
        // The link itself is never logged here, in any environment.
        console.warn(`[admin/applications/${id}/approve] activation email suppressed (${sent.suppressed}) — nothing was sent`);
      }
    } catch (e) {
      console.error(`[admin/applications/${id}/approve] activation email failed`, e);
    }
  } else if (process.env.NODE_ENV === "production") {
    // Never write a live sign-in link to production logs (6 Oct 2026, lane I
    // review): anyone with log access could sign in as the new owner.
    console.error(`[admin/applications/${id}/approve] RESEND_API_KEY unset — activation email NOT sent; resend once mail is configured`);
  } else {
    console.warn(`[admin/applications/${id}/approve] RESEND_API_KEY unset — activation link: ${link}`);
  }

  return NextResponse.json({
    ok: true,
    tenantId,
    slug,
    ownerEmail: application.email,
    activationEmailSent,
    activationLinkCreated: token !== null,
    emailDelivery: deliveryOn ? "on" : "off",
    activationLink: process.env.NODE_ENV === "production" ? undefined : link,
  }, { status: 201 });
}
