// TEMPORARY DEBUG ENDPOINT — returns the DB hostname this deployment is
// connected to (no credentials). Used to confirm Production vs Preview
// envs are pointing at the same Neon database. Remove after diagnosis.

import { NextResponse } from "next/server";
import { withRlsBypass } from "@/lib/prisma-tenant";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.DATABASE_URL ?? "";
  // Strip credentials, keep just the host + db.
  const hostMatch = url.match(/@([^/?]+)/);
  const dbMatch = url.match(/\/([^/?]+)\?/);
  const host = hostMatch ? hostMatch[1] : "(no host detected)";
  const db = dbMatch ? dbMatch[1] : "(no db detected)";

  // Verify connectivity by counting Tenant rows + listing tenant slugs.
  let tenantSlugs: string[] = [];
  let tenantCount = 0;
  let userCount = 0;
  let totalbjjOwnerEmail: string | null = null;
  try {
    const data = await withRlsBypass(async (tx) => {
      const tenants = await tx.tenant.findMany({ select: { slug: true } });
      const users = await tx.user.count();
      const owner = await tx.user.findFirst({
        where: { tenant: { slug: "totalbjj" }, role: "owner" },
        select: { email: true },
      });
      return { tenants, users, owner };
    });
    tenantSlugs = data.tenants.map((t) => t.slug);
    tenantCount = data.tenants.length;
    userCount = data.users;
    totalbjjOwnerEmail = data.owner?.email ?? null;
  } catch (e) {
    return NextResponse.json({
      host, db,
      vercelEnv: process.env.VERCEL_ENV ?? null,
      error: (e as Error)?.message ?? String(e),
    }, { status: 500 });
  }

  return NextResponse.json({
    host,
    db,
    vercelEnv: process.env.VERCEL_ENV ?? null,
    tenantCount,
    tenantSlugs,
    userCount,
    totalbjjOwnerEmail,
  });
}
