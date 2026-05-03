/**
 * POST /api/admin/create-tenant
 * Creates a new gym tenant + owner account.
 * Protected by MATFLOW_ADMIN_SECRET header for security.
 */
import { withRlsBypass } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";
import { logAudit } from "@/lib/audit-log";
import { getBaseUrl } from "@/lib/env-url";

const schema = z.object({
  gymName: z.string().min(1).max(100),
  slug: z
    .string()
    .min(3)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase letters, numbers, hyphens only"),
  ownerName: z.string().min(1).max(100),
  ownerEmail: z.string().email(),
  ownerPassword: z.string().min(8),
  primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).optional(),
  subscriptionTier: z.enum(["starter", "pro", "elite", "enterprise"]).optional(),
});

export async function POST(req: Request) {
  // Require admin secret header
  const adminSecret = req.headers.get("x-admin-secret");
  const expectedSecret = process.env.MATFLOW_ADMIN_SECRET;

  if (!expectedSecret || adminSecret !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const ip = getClientIp(req);
  const rl = await checkRateLimit(`admin:create-tenant:${ip}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many tenant creations from this IP. Try again later." },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const { gymName, slug, ownerName, ownerEmail, ownerPassword, primaryColor, subscriptionTier } = parsed.data;
  const passwordHash = await bcrypt.hash(ownerPassword, 12);

  try {
    // Tenant creation: by definition cross-tenant — there is no current
    // tenant context until this row exists. Bypass is intentional.
    const tenant = await withRlsBypass((tx) =>
      tx.tenant.create({
        data: {
          name: gymName,
          slug: slug.toLowerCase(),
          primaryColor: primaryColor ?? "#3b82f6",
          secondaryColor: "#2563eb",
          subscriptionStatus: "trial",
          subscriptionTier: subscriptionTier ?? "pro",
          users: {
            create: {
              email: ownerEmail,
              passwordHash,
              name: ownerName,
              role: "owner",
            },
          },
        },
        include: { users: { select: { id: true, email: true, role: true } } },
      }),
    );

    await logAudit({
      tenantId: tenant.id,
      userId: null,
      action: "admin.tenant.create",
      entityType: "Tenant",
      entityId: tenant.id,
      metadata: { slug: tenant.slug, name: tenant.name },
      req,
    });

    return NextResponse.json(
      {
        success: true,
        tenantId: tenant.id,
        slug: tenant.slug,
        loginUrl: `${getBaseUrl(req) || "http://localhost:3000"}/login`,
        clubCode: tenant.slug,
        ownerEmail,
      },
      { status: 201 }
    );
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "A gym with that slug already exists" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to create tenant" }, { status: 500 });
  }
}
