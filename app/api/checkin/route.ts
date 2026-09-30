/**
 * POST /api/checkin
 * Records a member attendance for a class instance.
 * Can be called by: staff (admin tool — any method), or authenticated member (self).
 *
 * Business rules live in lib/checkin.ts so the public kiosk route
 * (POST /api/kiosk/[token]/checkin) can share them without re-implementing
 * rank gates, time windows, or class-pack redemption.
 */
import { auth } from "@/auth";
import { withTenantContext } from "@/lib/prisma-tenant";
import { NextResponse } from "next/server";
import { checkinRefusal } from "@/lib/checkin-refusal";
import { z } from "zod";
import { logAudit } from "@/lib/audit-log";
import { performCheckin, restorePackCreditsForAttendance } from "@/lib/checkin";
import { assertSameOrigin } from "@/lib/csrf";

export const checkinSchema = z.object({
  classInstanceId: z.string().min(1),
  memberId: z.string().optional(),  // admin flow only — self flow resolves from session
  // Session E (kids feature): a member with kids can check in one of their
  // children. Must be a member of the same tenant whose parentMemberId
  // matches the calling session's memberId. Distinct from `memberId` so a
  // non-staff session can never reach the admin branch.
  onBehalfOfMemberId: z.string().optional(),
  checkInMethod: z.enum(["admin", "self", "auto"]).default("admin"),
  // Staff marks only: what the register asked about and the person admitted
  // anyway (a hold, an unsigned waiver, an adult in a kids class). Recorded on the attendance.mark audit
  // row; it changes no rule — a staff mark is not gated on either.
  acknowledged: z.array(z.enum(["on_hold", "waiver_unsigned", "kids_class"])).max(3).optional(),
});

export async function POST(req: Request) {
  // Defence-in-depth CSRF guard. SameSite=Lax + JSON CORS preflight already
  // mitigate most cross-origin POSTs, but the codebase's stated policy applies
  // assertSameOrigin to every state-mutating route — this one was missed.
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const parsed = checkinSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid data", details: parsed.error.flatten() }, { status: 400 });
  }

  const { classInstanceId, memberId, onBehalfOfMemberId, checkInMethod, acknowledged } = parsed.data;
  const session = await auth();

  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const tenantId: string = session.user.tenantId;
  let resolvedMemberId: string;
  // Server-side determination of the effective method, NOT trusting the
  // client-supplied value. Without this, a member could POST
  // { checkInMethod: "admin" } with no memberId and reach the self path
  // with all enforcement disabled — bypass-of-rank-gate / coverage / time-window
  // (HIGH severity finding, security audit 2026-05-07).
  let effectiveMethod: "admin" | "self" | "auto";
  // The member who pressed the button on a member-side check-in: the member
  // themselves, or the parent checking in a child. Null on the staff path.
  let actorMemberId: string | null = null;

  if (memberId) {
    // Admin checking in a specific member — validate member belongs to this tenant
    const isStaff = ["owner", "manager", "coach", "admin"].includes(session.user.role);
    if (!isStaff) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    // Every staff role may mark any class in the club. Noe, 17 Sep 2026:
    // "coaches should see all classes but theirs should be specifically
    // highlighted" — a covering coach takes what they cover, and the
    // highlight (isMine on /api/coach/today) is guidance, not a lock. The
    // `instructorId` narrowing this route, the card scanner and the coach
    // register all carried was a lock on a column nothing ever wrote, so it
    // refused every coach every class. All five sites now agree: tenancy only.
    // Audit iter-5-database (sweep convergence): existence + id-only select.
    const [adminMember, permittedInstance] = await withTenantContext(tenantId, (tx) =>
      Promise.all([
        tx.member.findFirst({
          where: { id: memberId, tenantId },
          select: { id: true },
        }),
        tx.classInstance.findFirst({
          where: {
            id: classInstanceId,
            class: { tenantId },
          },
          select: { id: true },
        }),
      ]),
    );
    if (!permittedInstance) {
      // 404, not 403 — the same shape the coach register uses, so a coach
      // cannot probe which classes exist in the club.
      return NextResponse.json({ error: "Class not found" }, { status: 404 });
    }
    if (!adminMember) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    resolvedMemberId = adminMember.id;
    // Staff path: trust the staff-supplied method (admin / auto for special flows).
    effectiveMethod = checkInMethod;
  } else if (onBehalfOfMemberId) {
    // Parent checking in a kid. Hard guards:
    //   1. Caller has a memberId on the session (real member, not staff-only User)
    //   2. The kid lives in the same tenant
    //   3. The kid's parentMemberId === caller.memberId
    // Failing any of these returns 404 (never 403) so we don't reveal whether
    // the id exists in another parent's roster.
    const parentMemberId = session.user.memberId as string | undefined;
    if (!parentMemberId) return NextResponse.json({ error: "Not a member account" }, { status: 403 });
    const kid = await withTenantContext(tenantId, (tx) =>
      tx.member.findFirst({
        where: { id: onBehalfOfMemberId, tenantId, parentMemberId },
        select: { id: true },
      }),
    );
    if (!kid) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    resolvedMemberId = kid.id;
    actorMemberId = parentMemberId;
    // Parent-of-kid path inherits the self profile: rank gate, roster gate,
    // time window, and coverage all apply. The parent isn't bypassing
    // anything — the kid still needs an active membership / pack to attend.
    effectiveMethod = "self";
  } else {
    // Member self-check-in — look up their member record by session email
    // Audit iter-5-database (sweep convergence): existence + id-only select.
    const member = await withTenantContext(tenantId, (tx) =>
      tx.member.findFirst({
        where: { tenantId, email: session.user.email! },
        select: { id: true },
      }),
    );
    if (!member) return NextResponse.json({ error: "Member not found" }, { status: 404 });
    resolvedMemberId = member.id;
    actorMemberId = member.id;
    // Self path: force "self" regardless of what the client sent. Otherwise a
    // member could send { checkInMethod: "admin" } and bypass enforcement.
    effectiveMethod = "self";
  }

  // Self-check-in: full rules. Admin / auto: bypass.
  const isSelf = effectiveMethod === "self";
  const result = await performCheckin({
    tenantId,
    memberId: resolvedMemberId,
    classInstanceId,
    method: effectiveMethod,
    enforceRankGate: isSelf,
    enforceRosterGate: isSelf,
    enforceTimeWindow: isSelf,
    requireCoverage: isSelf,
    // A member taking the last place is refused; a staff member deliberately
    // exceeding it is not, and the result says `overCapacity` so the copy and
    // the audit row can carry it rather than the number drifting in silence.
    enforceCapacity: isSelf,
    // The waiver hard gate follows the same line as capacity: the member
    // deciding for themselves (and a parent deciding for their kid, which
    // resolves to "self" above) must have a signed waiver on file; a staff
    // mark does not ask, so a front-desk override for someone who has just
    // signed on paper still goes through.
    enforceWaiverGate: isSelf,
    // A membership on hold is refused on the same line: the member deciding
    // for themselves, not a staff mark.
    enforceHoldGate: isSelf,
    // An adult may not put themselves into a kids class; the desk's register
    // asks instead. A parent checking in their child is judged as the child.
    enforceKidsGate: isSelf,
    // A tier bound to one venue does not cover a class held at another; the
    // desk can still mark them (ADR-001 D2 slice 2).
    enforceVenueGate: isSelf,
    // Record which staff user clicked "check in" so the attendance row can
    // show "by [admin name]". Only stamped on staff-driven check-ins.
    checkedInByUserId: effectiveMethod === "admin" ? session.user.id : null,
  });

  switch (result.kind) {
    case "success":
      if (effectiveMethod === "admin") {
        // A staff mark is audited. The coach register's raw upsert used to be
        // the only staff mark that wrote a row; since 18 Sep 2026 every screen
        // marks through this route, so the row lives here — the same shape as
        // attendance.unmark, so the two read as one event in the log.
        await logAudit({
          tenantId,
          userId: session.user.id,
          action: "attendance.mark",
          entityType: "AttendanceRecord",
          entityId: `${classInstanceId}:${resolvedMemberId}`,
          metadata: {
            classInstanceId,
            memberId: resolvedMemberId,
            method: "admin",
            ...(acknowledged && acknowledged.length > 0 ? { acknowledged: [...new Set(acknowledged)] } : {}),
          },
          req,
        });
      } else if (isSelf) {
        // A member's own check-in (or a parent's for their child) is audited
        // too (functional review round 3, F11). The member is not a staff
        // User, so logAudit writes userId null and names them in
        // metadata.actorId.
        await logAudit({
          tenantId,
          userId: actorMemberId,
          action: "attendance.self_checkin",
          entityType: "AttendanceRecord",
          entityId: result.record.id,
          metadata: {
            classInstanceId,
            memberId: resolvedMemberId,
            method: "self",
            ...(actorMemberId !== resolvedMemberId ? { onBehalfOf: resolvedMemberId } : {}),
          },
          req,
        });
      }
      return NextResponse.json({ success: true, record: result.record, coverage: result.coverage, overCapacity: result.overCapacity ?? null }, { status: 201 });
    case "error":
      return NextResponse.json({ error: "Failed to check in" }, { status: 500 });
    default: {
      // Every refusal, with its customer sentence and machine reason, comes
      // from one place so all three doors read the same thing (F-6).
      // The no-plan sentence depends on how the club takes money (a
      // pay-at-desk club sells no packs online), so that one refusal reads the
      // club's payment rail. A failed lookup falls back to the general
      // sentence — it is copy, not a rule.
      let paymentRail: string | null = null;
      if (result.kind === "no_coverage") {
        try {
          const club = await withTenantContext(tenantId, (tx) =>
            tx.tenant.findUnique({ where: { id: tenantId }, select: { paymentRail: true } }),
          );
          paymentRail = club?.paymentRail ?? null;
        } catch {
          paymentRail = null;
        }
      }
      const refusal = checkinRefusal(result, { paymentRail });
      if (refusal) return NextResponse.json(refusal.body, { status: refusal.status });
      return NextResponse.json({ error: "Unknown check-in result" }, { status: 500 });
    }
  }
}

export async function DELETE(req: Request) {
  const csrfViolation = assertSameOrigin(req);
  if (csrfViolation) return csrfViolation;

  const session = await auth();
  if (!session) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const isStaff = ["owner", "manager", "coach", "admin"].includes(session.user.role);
  if (!isStaff) return NextResponse.json({ error: "Forbidden" }, { status: 403 });

  const { searchParams } = new URL(req.url);
  const classInstanceId = searchParams.get("classInstanceId");
  const memberId = searchParams.get("memberId");

  if (!classInstanceId || !memberId) {
    return NextResponse.json({ error: "Missing parameters" }, { status: 400 });
  }

  try {
    await withTenantContext(session.user.tenantId, async (tx) => {
      // Fetch ids first: the delete may cover more than one row, and any pack
      // credit those rows consumed has to be given back in the same
      // transaction (audit P2-1 — undo used to silently eat a paid credit).
      const records = await tx.attendanceRecord.findMany({
        where: { classInstanceId, memberId, classInstance: { class: { tenantId: session.user.tenantId } } },
        select: { id: true },
      });
      if (records.length === 0) return;
      const ids = records.map((r) => r.id);
      await restorePackCreditsForAttendance(tx, ids);
      await tx.attendanceRecord.deleteMany({ where: { id: { in: ids } } });
    });
    await logAudit({
      tenantId: session.user.tenantId,
      userId: session.user.id,
      action: "attendance.override",
      entityType: "AttendanceRecord",
      entityId: `${classInstanceId}:${memberId}`,
      metadata: { classInstanceId, memberId },
      req,
    });
    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ error: "Failed to remove check-in" }, { status: 500 });
  }
}
