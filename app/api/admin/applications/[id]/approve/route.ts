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
import { isAdminAuthed } from "@/lib/admin-auth";
import { logAudit } from "@/lib/audit-log";
import { sendEmail } from "@/lib/email";
import { hashToken } from "@/lib/token-hash";
import { getBaseUrl } from "@/lib/env-url";

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
  if (!(await isAdminAuthed(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

  // Mint an owner-activation magic-link token (30-min expiry, same shape as login).
  const token = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + 30 * 60 * 1000);
  await withTenantContext(tenantId, (tx) =>
    tx.magicLinkToken.create({
      data: {
        tenantId,
        email: application.email.toLowerCase().trim(),
        tokenHash: hashToken(token),
        purpose: "first_time_signup",
        expiresAt,
      },
    }),
  );

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
    metadata: { tenantSlug: slug, ownerEmail: application.email, ownerUserId },
    req,
  }).catch(() => {});

  // Send the activation email. Best-effort — DB state stays correct even if email fails.
  const baseUrl = getBaseUrl(req);
  const link = `${baseUrl}/api/magic-link/verify?token=${encodeURIComponent(token)}&tenantSlug=${encodeURIComponent(slug)}`;
  if (process.env.RESEND_API_KEY) {
    try {
      await sendEmail({
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
    } catch (e) {
      console.error(`[admin/applications/${id}/approve] activation email failed`, e);
    }
  } else {
    console.warn(`[admin/applications/${id}/approve] RESEND_API_KEY unset — activation link: ${link}`);
  }

  return NextResponse.json({
    ok: true,
    tenantId,
    slug,
    ownerEmail: application.email,
    activationLink: process.env.NODE_ENV === "production" ? undefined : link,
  }, { status: 201 });
}
