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
import { recordStatusEventsBulk } from "@/lib/member-status";
import {
  planRefreshRollback,
  refreshWrite,
  REFRESH_MEMBER_SELECT,
  type RefreshChange,
} from "@/lib/importers/teamup-refresh";

export const runtime = "nodejs";
export const maxDuration = 120;
// The rollback's transaction may run as long as the route (connection register
// gap 16, 30 Sep 2026: it had the 15 s default while the route allowed more).
const ROLLBACK_TX = { timeout: (maxDuration - 10) * 1000, maxWait: 10_000 };

type Kept = { memberId: string; name: string; reasons: string[] };

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const csrf = assertSameOrigin(req);
  if (csrf) return csrf;
  const gate = await requireApiOwner();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const { id } = await params;

  const job = await withTenantContext(tenantId, (tx) =>
    tx.importJob.findFirst({ where: { id, tenantId }, select: { id: true, status: true, completedAt: true, rolledBackAt: true, fileName: true, mode: true, manifest: true } }),
  );
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // A rollback that kept anyone (they had signed in, been edited, or had
  // imported attendance history) can be run again for what remains, once the
  // owner has dealt with the reason — otherwise "roll back that attendance
  // import first" led nowhere (verifier lane 5 round 2, 30 Sep 2026). Only a
  // job with none of its rows left is finished.
  if (job.mode === "refresh") {
    if (job.status !== "complete" || !job.completedAt) {
      return NextResponse.json({ error: "Only a completed status refresh can be rolled back" }, { status: 409 });
    }
    return rollbackRefresh(req, { tenantId, userId, job });
  }
  if (job.rolledBackAt) {
    const remaining = await withTenantContext(tenantId, (tx) => tx.member.count({ where: { tenantId, importJobId: job.id } }));
    if (remaining === 0) return NextResponse.json({ error: "This import was already rolled back" }, { status: 409 });
  }
  // A run that failed part-way may have created people, so it can be rolled
  // back too (connection register gap 12, 30 Sep 2026).
  if (!["complete", "failed"].includes(job.status) || !job.completedAt) {
    return NextResponse.json({ error: "Only a finished import can be rolled back" }, { status: 409 });
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
      if (ids.length === 0) {
        // teamup-2: a run that created nobody still wrote ledger rows for the
        // records it excluded or quarantined; a rolled-back run keeps none.
        await tx.importedMembership.deleteMany({ where: { tenantId, importJobId: job.id, memberId: null } });
        return { removed: [] as string[], kept: [] as Kept[], attendanceRemoved: 0, ledgerRemoved: 0 };
      }

      // Real visits made in MatFlow (no import job) pin a member. History brought
      // in by an ATTENDANCE import is not a visit: it pins the member only until
      // that import is rolled back, and says so (verifier lane 5, 30 Sep 2026).
      const liveAttendance = await tx.attendanceRecord.groupBy({
        by: ["memberId"],
        where: { tenantId, memberId: { in: ids }, importJobId: null },
        _count: { _all: true },
      });
      const liveByMember = new Map(liveAttendance.map((a) => [a.memberId, a._count._all]));
      const importedHistory = await tx.attendanceRecord.groupBy({
        by: ["memberId"],
        where: { tenantId, memberId: { in: ids }, importJobId: { not: null, notIn: [job.id] } },
        _count: { _all: true },
      });
      const historyByMember = new Map(importedHistory.map((a) => [a.memberId, a._count._all]));
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
        if (historyByMember.get(c.id)) r.push("has imported attendance history — roll back that attendance import first");
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
      // teamup-2 (real-data rehearsal, 2 Oct 2026): the run's row ledger goes
      // with it — rows of removed members cascade; rows that never had a member
      // (excluded, quarantined, duplicate, unlinked) are removed here. Rows of
      // KEPT members stay: their history is still real for a member who remains.
      const ledger = await tx.importedMembership.deleteMany({
        where: { tenantId, importJobId: job.id, OR: [{ memberId: null }, { memberId: { in: removeIds } }] },
      });

      // The outcome is recorded in the SAME transaction as the deletions
      // (connection register gap 15, 30 Sep 2026): a failure after the
      // members were deleted used to answer "nothing was removed". Now either
      // both happen or neither does, and that sentence is true.
      const current = await tx.importJob.findUnique({ where: { id: job.id }, select: { manifest: true } });
      const manifest = (current?.manifest ?? {}) as Record<string, unknown>;
      // A repeat rollback adds to what earlier ones removed.
      const prior = (manifest.rollback ?? {}) as { removed?: number; attendanceRemoved?: number; ledgerRemoved?: number };
      await tx.importJob.update({
        where: { id: job.id },
        data: {
          rolledBackAt: new Date(),
          manifest: {
            ...manifest,
            rollback: {
              removed: (prior.removed ?? 0) + removeIds.length,
              kept,
              attendanceRemoved: (prior.attendanceRemoved ?? 0) + attendance.count,
              ledgerRemoved: (prior.ledgerRemoved ?? 0) + ledger.count,
            },
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return { removed: removeIds, kept, attendanceRemoved: attendance.count, ledgerRemoved: ledger.count };
    }, ROLLBACK_TX);

    await logAudit({
      tenantId,
      userId,
      action: "import.rollback",
      entityType: "ImportJob",
      entityId: job.id,
      metadata: { fileName: job.fileName, removed: result.removed.length, kept: result.kept.length, attendanceRemoved: result.attendanceRemoved, ledgerRemoved: result.ledgerRemoved },
      req,
    });

    return NextResponse.json({ ok: true, removed: result.removed.length, kept: result.kept, attendanceRemoved: result.attendanceRemoved });
  } catch (e) {
    return apiError("Rollback failed — nothing was removed", 500, e, "[admin/import/rollback]");
  }
}

type RefreshManifest = {
  refresh?: { changes?: RefreshChange[] };
  rollback?: { kind?: string; restored?: number; restoredIds?: string[]; kept?: Kept[] };
};

/**
 * Undo a status refresh: put back the standing each member had before it,
 * only where the member still carries exactly what the refresh wrote. Anyone
 * changed since — by staff, or by a later refresh — is left as they are and
 * listed with the reason. A repeat run picks up whoever is left.
 */
async function rollbackRefresh(
  req: Request,
  { tenantId, userId, job }: { tenantId: string; userId: string; job: { id: string; fileName: string; rolledBackAt: Date | null; manifest: unknown } },
) {
  const manifest = (job.manifest ?? {}) as RefreshManifest;
  const changes = manifest.refresh?.changes ?? [];
  const alreadyRestored = new Set(manifest.rollback?.restoredIds ?? []);
  if (job.rolledBackAt && changes.every((c) => alreadyRestored.has(c.memberId))) {
    return NextResponse.json({ error: "This status refresh was already rolled back" }, { status: 409 });
  }
  try {
    const result = await withTenantContext(tenantId, async (tx) => {
      const current = await tx.member.findMany({
        where: { tenantId, id: { in: changes.map((c) => c.memberId) } },
        select: REFRESH_MEMBER_SELECT,
      });
      const { restore, kept } = planRefreshRollback(changes, current, alreadyRestored);
      for (const c of restore) {
        await tx.member.updateMany({ where: { id: c.memberId, tenantId }, data: refreshWrite(c.before) });
      }
      await recordStatusEventsBulk(
        tx,
        restore.map((c) => ({ tenantId, memberId: c.memberId, fromStatus: c.after.status, toStatus: c.before.status, reason: "import" as const, changedById: null })),
      );
      const restoredIds = [...alreadyRestored, ...restore.map((c) => c.memberId)];
      await tx.importJob.update({
        where: { id: job.id },
        data: {
          rolledBackAt: new Date(),
          manifest: {
            ...(job.manifest as Record<string, unknown>),
            rollback: { kind: "refresh", restored: restoredIds.length, restoredIds, kept },
          } as unknown as Prisma.InputJsonValue,
        },
      });
      return { restored: restore.length, kept };
    });

    await logAudit({
      tenantId,
      userId,
      action: "import.rollback",
      entityType: "ImportJob",
      entityId: job.id,
      metadata: { fileName: job.fileName, mode: "refresh", restored: result.restored, kept: result.kept.length },
      req,
    });
    return NextResponse.json({ ok: true, mode: "refresh", restored: result.restored, kept: result.kept });
  } catch (e) {
    return apiError("Rollback failed — nothing was changed", 500, e, "[admin/import/rollback]");
  }
}
