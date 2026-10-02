// GET /api/members/[id]/imported-memberships — the member's membership history
// as TeamUp recorded it (ImportedMembership rows, teamup-2, 2 Oct 2026).
// Staff-readable like GET /api/members/[id]; tenant-scoped. These rows are
// imported facts, never MatFlow purchases: nothing here was charged, signed
// up or paid through MatFlow.
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";

export const runtime = "nodejs";

const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["owner", "manager", "coach", "admin"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const tenantId = session.user.tenantId;
  const { id } = await params;

  const result = await withTenantContext(tenantId, async (tx) => {
    const member = await tx.member.findFirst({ where: { id, tenantId }, select: { id: true, billedBy: true, billingStatusAsOf: true } });
    if (!member) return null;
    const rows = await tx.importedMembership.findMany({
      where: { tenantId, memberId: id },
      orderBy: [{ startDate: "desc" }, { sourceRow: "desc" }],
      select: {
        id: true, importJobId: true, sourceRow: true, planLabel: true, type: true, status: true, processor: true,
        purchaseDate: true, startDate: true, expiryDate: true, cancelledDate: true, completedAt: true,
        isFirst: true, otherActive: true, entitlement: true, disposition: true,
      },
    });
    return { member, rows };
  });
  if (!result) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = result.rows.map((r) => ({
    id: r.id,
    importJobId: r.importJobId,
    sourceRow: r.sourceRow,
    planLabel: r.planLabel,
    type: r.type,
    status: r.status,
    processor: r.processor,
    purchaseDate: day(r.purchaseDate),
    startDate: day(r.startDate),
    expiryDate: day(r.expiryDate),
    cancelledDate: day(r.cancelledDate),
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
    isFirst: r.isFirst,
    otherActive: r.otherActive,
    entitlement: r.entitlement,
    disposition: r.disposition,
  }));
  const current = rows.filter((r) => r.entitlement === "current");
  const scheduled = rows.filter((r) => r.entitlement === "scheduled");
  return NextResponse.json({
    billedBy: result.member.billedBy,
    billingStatusAsOf: result.member.billingStatusAsOf ? result.member.billingStatusAsOf.toISOString() : null,
    standing: {
      decisionRequired: current.length > 1 ? current.map((r) => r.planLabel) : null,
      scheduled: scheduled.length > 0 ? scheduled.map((r) => ({ planLabel: r.planLabel, startDate: r.startDate })) : null,
    },
    rows,
  });
}
