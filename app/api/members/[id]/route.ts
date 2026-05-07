import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withTenantContext } from "@/lib/prisma-tenant";
import { memberUpdateSchema as updateSchema } from "@/lib/schemas/member";
import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";
import { stripTotpFields } from "@/lib/totp-immutable";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const { member, promoters } = await withTenantContext(session.user.tenantId, async (tx) => {
      const m = await tx.member.findFirst({
        where: { id, tenantId: session.user.tenantId },
        include: {
          memberRanks: {
            include: {
              rankSystem: true,
              rankHistory: {
                orderBy: { promotedAt: "desc" },
                take: 10,
              },
            },
            orderBy: { achievedAt: "desc" },
          },
          attendances: {
            include: {
              classInstance: {
                include: { class: true },
              },
            },
            orderBy: { checkInTime: "desc" },
            take: 20,
          },
        },
      });
      if (!m) return { member: null, promoters: new Map<string, { id: string; name: string }>() };

      // LB-007 (audit H4): enrich each MemberRank + RankHistory entry with the
      // promoter's name. Previously the UI only had promotedById and showed it
      // as blank.
      const promoterIds = new Set<string>();
      for (const rank of m.memberRanks) {
        if (rank.promotedById) promoterIds.add(rank.promotedById);
        for (const h of rank.rankHistory) {
          if (h.promotedById) promoterIds.add(h.promotedById);
        }
      }
      let pmap: Map<string, { id: string; name: string }> = new Map();
      if (promoterIds.size > 0) {
        const users = await tx.user.findMany({
          where: { id: { in: Array.from(promoterIds) } },
          select: { id: true, name: true },
        });
        pmap = new Map(users.map((u) => [u.id, u]));
      }
      return { member: m, promoters: pmap };
    });

    if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const enriched = {
      ...member,
      memberRanks: member.memberRanks.map((rank) => ({
        ...rank,
        promotedBy: rank.promotedById ? (promoters.get(rank.promotedById) ?? null) : null,
        rankHistory: rank.rankHistory.map((h) => ({
          ...h,
          promotedBy: h.promotedById ? (promoters.get(h.promotedById) ?? null) : null,
        })),
      })),
    };
    return NextResponse.json(enriched);
  } catch {
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canEdit = ["owner", "manager", "admin"].includes(session.user.role);
  if (!canEdit) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  let body: unknown;
  try {
    // Defence in depth: strip TOTP fields so an attacker cannot disable
    // a member's TOTP through this PATCH route. Only the dedicated reset
    // endpoints (/api/admin/customers/[id]/member-totp-reset for operator
    // and /api/members/[id]/totp-reset for staff) may clear it.
    body = stripTotpFields(await req.json() as Record<string, unknown>);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  try {
    const { dateOfBirth, updatedAt: clientUpdatedAt, ...rest } = parsed.data;
    // Optimistic-concurrency precondition: only update if the row's updatedAt
    // matches what the client thinks it is. Skipped when no precondition is
    // sent so existing callers stay backward-compatible.
    const concurrencyGuard = clientUpdatedAt ? { updatedAt: new Date(clientUpdatedAt) } : {};
    const result = await withTenantContext(session.user.tenantId, async (tx) => {
      const m = await tx.member.updateMany({
        where: { id, tenantId: session.user.tenantId, ...concurrencyGuard },
        data: {
          ...rest,
          ...(dateOfBirth !== undefined ? { dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null } : {}),
        },
      });
      if (m.count === 0) {
        const existing = await tx.member.findFirst({
          where: { id, tenantId: session.user.tenantId },
          select: { updatedAt: true },
        });
        return { updated: null, existing };
      }
      const fresh = await tx.member.findFirst({ where: { id, tenantId: session.user.tenantId } });
      return { updated: fresh, existing: null };
    });

    if (!result.updated) {
      if (!result.existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
      if (clientUpdatedAt) {
        return NextResponse.json(
          { error: "This member was updated by someone else. Reload and try again.", currentUpdatedAt: result.existing.updatedAt.toISOString() },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const updated = result.updated;
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "member.update",
      entityType: "Member",
      entityId: id,
      metadata: { fields: Object.keys(parsed.data) },
      req,
    });
    return NextResponse.json(updated);
  } catch (e: unknown) {
    if ((e as { code?: string }).code === "P2002") {
      return NextResponse.json({ error: "Email already in use" }, { status: 409 });
    }
    return NextResponse.json({ error: "Failed to update member" }, { status: 500 });
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (session.user.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    await withTenantContext(session.user.tenantId, (tx) =>
      tx.member.deleteMany({ where: { id, tenantId: session.user.tenantId } }),
    );
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "member.delete",
      entityType: "Member",
      entityId: id,
      req,
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to delete member" }, { status: 500 });
  }
}
