import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withTenantContext } from "@/lib/prisma-tenant";
import { memberUpdateSchema as updateSchema } from "@/lib/schemas/member";
import { NextResponse } from "next/server";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";
import { stripTotpFields } from "@/lib/totp-immutable";
import {
  deleteParentMemberWithKidsResolution,
  type ParentDeletionStrategy,
} from "@/lib/member-delete";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  // Staff-only — without this, a member could enumerate other members in the
  // same tenant. Members read their own profile via /api/member/me.
  // (Security audit 2026-05-07, severity LOW.)
  const canRead = ["owner", "manager", "coach", "admin"].includes(session.user.role);
  if (!canRead) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

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
    // Audit iter-1-member-lifecycle A3C-2: refuse to mutate `status` away from
    // "cancelled" when the member has been GDPR-erased. The DSAR erase route
    // sets `email = "deleted-{cuid}@deleted.invalid"` + `status = "cancelled"`.
    // A staff PATCH back to "active" would resurrect the erased record,
    // violating Article 17 fulfilment evidence. The sentinel pattern is the
    // canonical mark of an erased member.
    if (rest.status && rest.status !== "cancelled") {
      const existing = await withTenantContext(session.user.tenantId, (tx) =>
        tx.member.findFirst({
          where: { id, tenantId: session.user.tenantId },
          select: { email: true, status: true },
        }),
      );
      if (existing && /^deleted-.*@deleted\.invalid$/.test(existing.email)) {
        return NextResponse.json(
          { error: "This member has been erased under GDPR Article 17 and cannot be reactivated." },
          { status: 422 },
        );
      }
    }
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

  // F5 deletion gateway: when a Member has linked kids, the caller MUST pick
  // a strategy (reassign / cascade / orphan). The first call without a
  // strategy is the probe — it returns 409 with the kids list so the UI can
  // surface the three-option picker; the second call passes ?strategy=... in
  // the query string.
  const url = new URL(req.url);
  const strategyKind = url.searchParams.get("strategy");
  let strategy: ParentDeletionStrategy = undefined;
  if (strategyKind) {
    if (strategyKind === "reassign") {
      const to = url.searchParams.get("toParentMemberId");
      if (!to) return NextResponse.json({ error: "reassign requires toParentMemberId" }, { status: 400 });
      strategy = { kind: "reassign", toParentMemberId: to };
    } else if (strategyKind === "cascade") {
      strategy = { kind: "cascade" };
    } else if (strategyKind === "orphan") {
      strategy = { kind: "orphan" };
    } else {
      return NextResponse.json({ error: "Invalid strategy" }, { status: 400 });
    }
  }

  try {
    const outcome = await withTenantContext(session.user.tenantId, (tx) =>
      deleteParentMemberWithKidsResolution(
        tx,
        { id, tenantId: session.user.tenantId },
        strategy,
      ),
    );
    if (outcome.kind === "not-found") {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    if (outcome.kind === "race") {
      return NextResponse.json({ error: "Conflict — member already removed" }, { status: 409 });
    }
    if (outcome.kind === "kids-present") {
      // Probe response. UI shows the picker, then re-issues DELETE with
      // ?strategy=cascade / reassign&toParentMemberId=X / orphan.
      return NextResponse.json(
        {
          error: "This member has linked kids — choose how to resolve them",
          kids: outcome.kids,
        },
        { status: 409 },
      );
    }
    if (outcome.kind === "invalid-reassign") {
      return NextResponse.json({ error: outcome.reason }, { status: 400 });
    }

    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "member.delete",
      entityType: "Member",
      entityId: id,
      metadata: strategy
        ? { kidsAffected: outcome.kidsAffected, strategy: strategy.kind }
        : { kidsAffected: 0 },
      req,
    });
    return NextResponse.json({ success: true, kidsAffected: outcome.kidsAffected });
  } catch {
    return NextResponse.json({ error: "Failed to delete member" }, { status: 500 });
  }
}
