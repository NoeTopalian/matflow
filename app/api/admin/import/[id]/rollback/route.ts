// POST /api/admin/import/[id]/rollback
//
// Undo a committed member import, safely. Only rows this job created
// (Member.importJobId = job.id) are candidates, and a candidate is removed only
// if nothing has happened to it since: no login of its own, no check-in other
// than history this same job imported, no payment, waiver, pack, order, rank,
// Stripe customer, edit after the import, or child being kept. Everything left
// in place is reported with the reason, so the owner sees exactly what the
// rollback did and did not do. Idempotent: a second call answers 409.

import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { withTenantContext } from "@/lib/prisma-tenant";
import { requireApiOwner } from "@/lib/api-authz";
import { assertSameOrigin } from "@/lib/csrf";
import { logAudit } from "@/lib/audit-log";
import { apiError } from "@/lib/api-error";

export const runtime = "nodejs";
export const maxDuration = 120;

type Kept = { memberId: string; name: string; reasons: string[] };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const { id } = await params;

  const job = await withTenantContext(tenantId, (tx) =>
    tx.importJob.findFirst({ where: { id, tenantId }, select: { id: true, status: true, completedAt: true, rolledBackAt: true, fileName: true } }),
  );
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (job.rolledBackAt) return NextResponse.json({ error: "This import was already rolled back" }, { status: 409 });
  if (job.status !== "complete" || !job.completedAt) {
    return NextResponse.json({ error: "Only a completed import can be rolled back" }, { status: 409 });
  }
  const completedAt = job.completedAt;

  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      const candidates = await tx.member.findMany({
        where: { tenantId, importJobId: job.id },
        select: {
          id: true,
          name: true,
          parentMemberId: true,
          passwordHash: true,
          stripeCustomerId: true,
          updatedAt: true,
          _count: {
            select: {
              memberRanks: true, subscriptions: true, waitlists: true, signedWaivers: true,
              payments: true, classPacks: true, orders: true, loginEvents: true, classRosters: true,
              photos: true, uploadedPhotos: true, pushSubscriptions: true, tasksAssigned: true,
              creditedByMembers: true, children: true,
            },
          },
        },
      });
      const ids = candidates.map((c) => c.id);
      if (ids.length === 0) return { removed: [] as string[], kept: [] as Kept[], attendanceRemoved: 0 };

      // Check-ins that are NOT this job's imported history (a real visit).
      const liveAttendance = await tx.attendanceRecord.groupBy({
        by: ["memberId"],
        where: { tenantId, memberId: { in: ids }, OR: [{ importJobId: null }, { importJobId: { not: job.id } }] },
        _count: { _all: true },
      });
      const liveByMember = new Map(liveAttendance.map((a) => [a.memberId, a._count._all]));
      // Status changes made by people, not by this import.
      const laterEvents = await tx.memberStatusEvent.groupBy({
        by: ["memberId"],
        where: { tenantId, memberId: { in: ids }, reason: { not: "import" } },
        _count: { _all: true },
      });
      const eventsByMember = new Map(laterEvents.map((e) => [e.memberId, e._count._all]));

      const reasonsFor = new Map<string, string[]>();
      for (const c of candidates) {
        const r: string[] = [];
        if (c.passwordHash) r.push("has signed in");
        if (liveByMember.get(c.id)) r.push("has check-ins made in MatFlow");
        if (eventsByMember.get(c.id)) r.push("status changed after the import");
        if (c.stripeCustomerId) r.push("linked to Stripe");
        if (c.updatedAt.getTime() > completedAt.getTime() + 1000) r.push("edited after the import");
        const n = c._count;
        if (n.payments) r.push("has payments");
        if (n.signedWaivers) r.push("has a signed waiver");
        if (n.classPacks) r.push("has class packs");
        if (n.orders) r.push("has orders");
        if (n.memberRanks) r.push("has a rank");
        if (n.loginEvents) r.push("has signed in");
        if (n.subscriptions || n.waitlists || n.classRosters) r.push("is booked into classes");
        if (n.photos || n.uploadedPhotos) r.push("has photos");
        if (n.pushSubscriptions || n.tasksAssigned || n.creditedByMembers) r.push("is referenced elsewhere");
        reasonsFor.set(c.id, [...new Set(r)]);
      }
      // A child created by another job, or kept here, pins its parent.
      const byId = new Map(candidates.map((c) => [c.id, c]));
      const children = await tx.member.findMany({
        where: { tenantId, parentMemberId: { in: ids } },
        select: { id: true, parentMemberId: true },
      });
      let changed = true;
      while (changed) {
        changed = false;
        for (const ch of children) {
          const parent = ch.parentMemberId!;
          const childKept = !byId.has(ch.id) || (reasonsFor.get(ch.id)?.length ?? 0) > 0;
          const pr = reasonsFor.get(parent)!;
          if (childKept && !pr.includes("has a child who is being kept")) {
            pr.push("has a child who is being kept");
            changed = true;
          }
        }
      }

      const removable = candidates.filter((c) => (reasonsFor.get(c.id)?.length ?? 0) === 0);
      const removeIds = removable.map((c) => c.id);
      const kept: Kept[] = candidates
        .filter((c) => (reasonsFor.get(c.id)?.length ?? 0) > 0)
        .map((c) => ({ memberId: c.id, name: c.name, reasons: reasonsFor.get(c.id)! }));

      // Imported history of the removed rows goes with them; status events
      // cascade. Children first: a parent row is referenced by its children.
      const attendance = await tx.attendanceRecord.deleteMany({
        where: { tenantId, importJobId: job.id, memberId: { in: removeIds } },
      });
      const childIds = removable.filter((c) => c.parentMemberId).map((c) => c.id);
      const adultIds = removable.filter((c) => !c.parentMemberId).map((c) => c.id);
      if (childIds.length) await tx.member.deleteMany({ where: { tenantId, id: { in: childIds } } });
      if (adultIds.length) await tx.member.deleteMany({ where: { tenantId, id: { in: adultIds } } });

      await tx.importJob.update({
        where: { id: job.id },
        data: { rolledBackAt: new Date() },
      });
      return { removed: removeIds, kept, attendanceRemoved: attendance.count };
    });

    // Record the outcome on the job for the Import history.
    await withTenantContext(tenantId, async (tx) => {
      const current = await tx.importJob.findUnique({ where: { id: job.id }, select: { manifest: true } });
      const manifest = (current?.manifest ?? {}) as Record<string, unknown>;
      await tx.importJob.update({
        where: { id: job.id },
        data: {
          manifest: {
            ...manifest,
            rollback: { removed: result.removed.length, kept: result.kept, attendanceRemoved: result.attendanceRemoved },
          } as unknown as Prisma.InputJsonValue,
        },
      });
    });

    await logAudit({
      tenantId,
      userId,
      action: "import.rollback",
      entityType: "ImportJob",
      entityId: job.id,
      metadata: { fileName: job.fileName, removed: result.removed.length, kept: result.kept.length, attendanceRemoved: result.attendanceRemoved },
      req,
    });

    return NextResponse.json({ ok: true, removed: result.removed.length, kept: result.kept, attendanceRemoved: result.attendanceRemoved });
  } catch (e) {
    return apiError("Rollback failed — nothing was removed", 500, e, "[admin/import/rollback]");
  }
}
