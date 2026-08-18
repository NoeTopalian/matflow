// GET /api/members/promotion-alerts
// Returns junior/kids members whose dateOfBirth indicates they are >= 18 today.
// Auth: requireOwner

import { requireApiOwner } from "@/lib/api-authz";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";

export async function GET() {
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId } = gate;

  const cutoff = new Date();
  cutoff.setFullYear(cutoff.getFullYear() - 18);

  const members = await withTenantContext(tenantId, (tx) =>
    tx.member.findMany({
      where: {
        tenantId,
        accountType: { in: ["junior", "kids"] },
        dateOfBirth: { lte: cutoff },
      },
      select: {
        id: true,
        name: true,
        dateOfBirth: true,
        accountType: true,
        parentMemberId: true,
        parent: { select: { id: true, name: true } },
      },
      orderBy: { dateOfBirth: "asc" },
    }),
  );

  return NextResponse.json({ members }, { headers: { "Cache-Control": "private, no-store" } });
}
