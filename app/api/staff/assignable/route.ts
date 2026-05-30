// Lightweight list of staff in the current tenant, for assigning tasks.
//
// GET /api/staff/assignable
//
// Open to ALL staff (owner | manager | coach | admin) — unlike the parent
// /api/staff GET which is owner+manager only and returns broader fields. This
// endpoint is read-only and returns only { id, name, role }, so widening it
// doesn't leak anything sensitive. Used by the dashboard's Add-Task modal.

import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { STAFF_ROLES } from "@/lib/authz";

export const runtime = "nodejs";

export async function GET() {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!STAFF_ROLES.includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const tenantId = session.user.tenantId;

  // Audit H-4: explicit role filter. The User table is staff-only by CHECK
  // constraint today, but filtering here keeps the contract honest and survives
  // a future schema change that would put non-staff users in the same table.
  const staff = await withTenantContext(tenantId, (tx) =>
    tx.user.findMany({
      where: { tenantId, role: { in: [...STAFF_ROLES] } },
      select: { id: true, name: true, role: true },
      orderBy: [{ role: "asc" }, { name: "asc" }],
    }),
  );

  return NextResponse.json(staff, {
    headers: { "Cache-Control": "private, max-age=300" },
  });
}
