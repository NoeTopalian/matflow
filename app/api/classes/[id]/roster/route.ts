import { auth } from "@/auth";
import { NextResponse } from "next/server";
import { z } from "zod";
import { withTenantContext } from "@/lib/prisma-tenant";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";
import { assertSameOrigin } from "@/lib/csrf";

const addSchema = z.object({ memberId: z.string().min(1) });

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["owner", "manager", "admin"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const tenantId = session.user.tenantId;
  const rows = await withTenantContext(tenantId, (tx) =>
    tx.classRoster.findMany({
      where: { classId: id, tenantId },
      include: { member: { select: { id: true, name: true, email: true } } },
      orderBy: { addedAt: "desc" },
    }),
  );
  return NextResponse.json({ roster: rows });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!["owner", "manager", "admin"].includes(session.user.role)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }
  const { id } = await ctx.params;
  const tenantId = session.user.tenantId;

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = addSchema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid input" }, { status: 400 });

  try {
    const created = await withTenantContext(tenantId, async (tx) => {
      const cls = await tx.class.findFirst({
        where: { id, tenantId },
        select: { id: true, tenantId: true, requiredRankId: true, maxRankId: true },
      });
      if (!cls) throw new Error("CLASS_NOT_FOUND");
      if (cls.requiredRankId || cls.maxRankId) throw new Error("RANK_GATED");

      const member = await tx.member.findFirst({
        where: { id: parsed.data.memberId, tenantId },
        select: { id: true, tenantId: true },
      });
      if (!member) throw new Error("MEMBER_NOT_FOUND");

      return tx.classRoster.create({
        data: {
          tenantId,
          classId: id,
          memberId: parsed.data.memberId,
          addedByUserId: session.user.id,
        },
      });
    });

    await logAudit({
      tenantId,
      userId: session.user.id,
      action: "class.roster.add",
      entityType: "ClassRoster",
      entityId: created.id,
      metadata: { classId: id, memberId: parsed.data.memberId },
      req,
    });
    return NextResponse.json(created, { status: 201 });
  } catch (e: unknown) {
    const code = (e as Error).message;
    if (code === "CLASS_NOT_FOUND" || code === "MEMBER_NOT_FOUND") {
      return NextResponse.json({ error: "Class or member not found in this tenant" }, { status: 404 });
    }
    if (code === "RANK_GATED") {
      return NextResponse.json({ error: "Class has a rank gate; clear requiredRank/maxRank before adding to roster" }, { status: 409 });
    }
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "Member already on roster" }, { status: 409 });
    }
    return apiError("Failed to add to roster", 500, e, "[roster.POST]");
  }
}
