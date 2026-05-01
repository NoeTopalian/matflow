import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit-log";

const updateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  email: z.string().email().optional(),
  phone: z.string().max(30).optional().nullable(),
  emergencyContactName: z.string().max(120).optional().nullable(),
  emergencyContactPhone: z.string().max(30).optional().nullable(),
  emergencyContactRelation: z.string().max(60).optional().nullable(),
  membershipType: z.string().max(60).optional().nullable(),
  status: z.enum(["active", "inactive", "cancelled"]).optional(),
  notes: z.string().max(2000).optional().nullable(),
  dateOfBirth: z.string().optional().nullable(),
  // Sprint 5 US-508: optimistic concurrency — client sends the updatedAt it
  // last saw. Server rejects with 409 if the row has changed since.
  updatedAt: z.string().optional(),
});

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const { id } = await params;

  try {
    const member = await prisma.member.findFirst({
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

    if (!member) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // LB-007 (audit H4): enrich each MemberRank + RankHistory entry with the
    // promoter's name. Previously the UI only had promotedById and showed it
    // as blank.
    const promoterIds = new Set<string>();
    for (const rank of member.memberRanks) {
      if (rank.promotedById) promoterIds.add(rank.promotedById);
      for (const h of rank.rankHistory) {
        if (h.promotedById) promoterIds.add(h.promotedById);
      }
    }
    let promoters: Map<string, { id: string; name: string }> = new Map();
    if (promoterIds.size > 0) {
      const users = await prisma.user.findMany({
        where: { id: { in: Array.from(promoterIds) } },
        select: { id: true, name: true },
      });
      promoters = new Map(users.map((u) => [u.id, u]));
    }

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
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const canEdit = ["owner", "manager", "admin"].includes(session.user.role);
  if (!canEdit) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
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
    const member = await prisma.member.updateMany({
      where: { id, tenantId: session.user.tenantId, ...concurrencyGuard },
      data: {
        ...rest,
        ...(dateOfBirth !== undefined ? { dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : null } : {}),
      },
    });

    if (member.count === 0) {
      // Distinguish missing row from concurrency conflict: if the row exists
      // (within the tenant) but the WHERE didn't match, it's a 409 — return
      // the current updatedAt so the client can refresh and retry.
      const existing = await prisma.member.findFirst({
        where: { id, tenantId: session.user.tenantId },
        select: { updatedAt: true },
      });
      if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });
      if (clientUpdatedAt) {
        return NextResponse.json(
          { error: "This member was updated by someone else. Reload and try again.", currentUpdatedAt: existing.updatedAt.toISOString() },
          { status: 409 },
        );
      }
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const updated = await prisma.member.findFirst({ where: { id, tenantId: session.user.tenantId } });
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
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  if (session.user.role !== "owner") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  try {
    await prisma.member.deleteMany({ where: { id, tenantId: session.user.tenantId } });
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
