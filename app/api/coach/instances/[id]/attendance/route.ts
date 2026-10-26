import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireApiStaff } from "@/lib/api-authz";
import { logAudit } from "@/lib/audit-log";
import { assertSameOrigin } from "@/lib/csrf";
import {
  restorePackCreditsForAttendance,
  lockedClassEligibility,
  staffAllowanceAsk,
  type AllowanceFacts,
} from "@/lib/checkin";
import { checkinRefusal } from "@/lib/checkin-refusal";
import { ALLOWANCE_OVERRIDE_REASON } from "@/lib/class-allowance";

// `acknowledged` carries one answer only: "allowance_reached" (T7), the
// coach's confirmation after being asked about a used-up plan allowance. The
// squad list and the membership list refuse a tick as they refuse every door
// (owner decision, 20 Oct 2026): an old client's "tier_not_included" is
// stripped here and admits no one.
const schema = z.object({
  memberId: z.string().min(1),
  attended: z.boolean(),
  acknowledged: z.preprocess(
    (v) => (Array.isArray(v) ? v.filter((x) => x !== "tier_not_included") : v),
    z.array(z.enum([ALLOWANCE_OVERRIDE_REASON])).max(1).optional(),
  ),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  // Lane 1 iter-1 CSRF sweep [High]: bulk-inserted by scripts/csrf-sweep.mjs.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;
  const gate = await requireApiStaff();
  if (!gate.ok) return gate.response;
  const { tenantId, userId } = gate;
  const { id: classInstanceId } = await params;

  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ error: "Invalid JSON" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "Invalid data" }, { status: 400 });
  const allowanceConfirmed = parsed.data.acknowledged?.includes(ALLOWANCE_OVERRIDE_REASON) === true;

  try {
    const outcome = await withTenantContext(tenantId, async (tx) => {
      const instance = await tx.classInstance.findFirst({
        where: {
          id: classInstanceId,
          // Every staff role may mark any class in the club (Noe, 17 Sep
          // 2026: coaches see all, theirs highlighted). Tenancy only.
          class: { tenantId },
        },
        select: { id: true, classId: true, date: true, startTime: true, class: { select: { name: true, tenant: { select: { timezone: true } } } } },
      });
      if (!instance) return "no-instance" as const;
      const member = await tx.member.findFirst({
        where: { id: parsed.data.memberId, tenantId },
        select: { id: true },
      });
      if (!member) return "no-member" as const;
      if (parsed.data.attended) {
        // Whether THIS tick created the row goes in the audit row, so an undo
        // removes only a row the tick made — never one that was already there
        // (a card scan, a self check-in, imported history).
        const existing = await tx.attendanceRecord.findUnique({
          where: { memberId_classInstanceId: { memberId: member.id, classInstanceId } },
          select: { id: true },
        });
        // The squad list and the membership list, under the Class row lock,
        // refuse-only, exactly as every other door. Only when the tick would
        // admit someone: a tick on a member already in writes nothing, so it
        // is not re-judged.
        let overAllowance: AllowanceFacts | null = null;
        if (!existing) {
          const refused = await lockedClassEligibility(
            tx,
            { tenantId, memberId: member.id },
            instance.classId,
            instance.class.name,
          );
          if (refused?.kind === "member_not_found") return "no-member" as const;
          if (refused) return refused;
          // T7: the plan allowance is ASKED about, as the desk register asks,
          // under the Member lock lockedClassEligibility already holds (Class,
          // then Member: the engine's order).
          const allowance = await staffAllowanceAsk(
            tx,
            { tenantId, memberId: member.id, confirmed: allowanceConfirmed, timeZone: instance.class.tenant.timezone },
            { id: instance.id, date: instance.date, startTime: instance.startTime },
          );
          if (allowance.kind === "member_not_found") return "no-member" as const;
          if (allowance.kind === "allowance_reached") return allowance;
          if (allowance.kind === "open" && allowance.overridden) overAllowance = allowance.facts;
        }
        const record = await tx.attendanceRecord.upsert({
          where: { memberId_classInstanceId: { memberId: member.id, classInstanceId } },
          // `checkedInById` names the staff member who ticked, exactly as
          // POST /api/checkin and the card scanner do. Without it every row
          // this route wrote was a staff mark nobody signed, and the "by
          // [name]" the register renders was blank for it.
          create: { tenantId, memberId: member.id, classInstanceId, checkInMethod: "admin", checkedInById: userId },
          // A tick on a member who is already in leaves the row exactly as it
          // was. This branch used to write `{ checkInMethod: "admin" }`, so a
          // register loaded before a card scan — or a second coach's device —
          // silently turned a `qr` row into an `admin` row while `checkedInById`
          // still named the scanner: a record that lied about how it came to
          // exist, and one that vanished from the `qr` filter and the reports
          // label that prove a scan happened. The tick's only job is presence.
          update: {},
          select: { id: true, checkInMethod: true, checkedInById: true },
        });
        // A row another device created between the read and the upsert hits
        // the no-op update branch; it is ours only if it reads as this tick's.
        const created = !existing && record.checkInMethod === "admin" && record.checkedInById === userId;
        const overrides: string[] = [];
        if (created && overAllowance) overrides.push(ALLOWANCE_OVERRIDE_REASON);
        return {
          kind: "marked" as const,
          memberId: member.id,
          recordId: record.id,
          created,
          overrides,
          overAllowance: created ? overAllowance : null,
        };
      } else {
        // Unmark is the inverse of a check-in: if the attendance was covered
        // by a class pack, the credit goes back in the same transaction
        // (audit P2-1). Ids are fetched first so the redemption rows can be
        // found before the attendance rows disappear.
        const records = await tx.attendanceRecord.findMany({
          where: { memberId: member.id, classInstanceId },
          select: { id: true },
        });
        if (records.length > 0) {
          const ids = records.map((r) => r.id);
          await restorePackCreditsForAttendance(tx, ids);
          await tx.attendanceRecord.deleteMany({ where: { id: { in: ids } } });
        }
      }
      return {
        kind: "marked" as const, memberId: member.id, recordId: null, created: false,
        overrides: [] as string[], overAllowance: null as AllowanceFacts | null,
      };
    });

    if (outcome === "no-instance") return NextResponse.json({ error: "Class not found" }, { status: 404 });
    if (outcome === "no-member") return NextResponse.json({ error: "Member not found" }, { status: 404 });
    if (outcome.kind === "tier_not_included" || outcome.kind === "roster_not_listed" || outcome.kind === "allowance_reached") {
      // Nothing was written. The eligibility refusals carry the sentence the
      // member reads at their own door; the allowance answer is askable: the
      // register confirms, then resends with acknowledged: ["allowance_reached"].
      const refusal = checkinRefusal(outcome)!;
      return NextResponse.json(refusal.body, { status: refusal.status });
    }

    await logAudit({
      tenantId, userId,
      action: parsed.data.attended ? "attendance.mark" : "attendance.unmark",
      entityType: "AttendanceRecord",
      entityId: `${classInstanceId}:${outcome.memberId}`,
      metadata: parsed.data.attended
        ? {
            classInstanceId, memberId: outcome.memberId, recordId: outcome.recordId, created: outcome.created,
            // The gates staff admitted past, as POST /api/checkin records them.
            ...(outcome.overrides.length > 0 ? { overrides: outcome.overrides } : {}),
            ...(outcome.overAllowance ? { overAllowance: outcome.overAllowance } : {}),
          }
        : { classInstanceId, memberId: outcome.memberId },
      req,
    });
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ error: "Failed to update attendance" }, { status: 500 });
  }
}
