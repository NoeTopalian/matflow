/**
 * GET /api/admin/applications?status=pending|all
 * Lists GymApplication rows for the super-admin queue. Cookie- or header-gated.
 */
import { NextResponse } from "next/server";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { isAdminAuthed } from "@/lib/admin-auth";

export async function GET(req: Request) {
  if (!(await isAdminAuthed(req))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const statusParam = url.searchParams.get("status") ?? "pending";

  // GymApplication is global (no tenantId) — applications precede tenants.
  // Use bypass + an explicit filter rather than relying on RLS context.
  const where = statusParam === "all"
    ? {}
    : statusParam === "pending"
      ? { status: { in: ["new", "pending", "contacted"] } }
      : { status: statusParam };

  const rows = await withRlsBypass((tx) =>
    tx.gymApplication.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  );

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      gymName: r.gymName,
      contactName: r.contactName,
      email: r.email,
      phone: r.phone,
      discipline: r.discipline,
      memberCount: r.memberCount,
      notes: r.notes,
      status: r.status,
      createdAt: r.createdAt,
    })),
  );
}
