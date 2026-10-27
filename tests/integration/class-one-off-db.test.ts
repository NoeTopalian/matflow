// G4 (owner, 27 Oct 2026): a coach's one-off, against real Postgres.
//
// The unit tests (tests/unit/checkin-one-off.test.ts and friends) pin the
// decisions; this proves the table, the transaction and the count:
//  - POST /api/checkin with oneOff writes the attendance row and the
//    ClassOneOff row together, granted by the session's user, audited;
//  - it admits past the squad list and the plan restriction;
//  - a one-off for a member at their limit is not counted, and their own
//    check-in to another session in the same period is still refused;
//  - deleting the attendance row (the register's unmark, the Activity undo)
//    removes the one-off with it, and the count recomputes;
//  - the reason CHECK (3 to 200 characters);
//  - RLS: another club can neither see nor write one.
// Run as both roles by .claude/skills/matflow-verify-local/scripts/db-tests.mjs.
// Skips when DATABASE_URL is unset (the Neon TEST branch, never production).

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));
const session = vi.hoisted(() => ({ user: { id: "", role: "coach", tenantId: "", email: "coach@example.test" } }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => session) }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn(async (entry: Record<string, unknown>) => {
    audit.calls.push(entry);
  }),
}));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { prisma } from "@/lib/prisma";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { performCheckin, type PerformCheckinArgs } from "@/lib/checkin";
import { memberAllowanceUsage } from "@/lib/class-allowance-count";
import { applyUndo } from "@/lib/undo-registry";
import { POST, DELETE } from "@/app/api/checkin/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

type Res = { status: number; body: Record<string, unknown> };
async function post(body: unknown): Promise<Res> {
  const res = (await POST(new Request("http://test/api/checkin", { method: "POST", body: JSON.stringify(body) }))) as unknown as {
    status: number; json: () => Promise<Record<string, unknown>>;
  };
  return { status: res.status, body: await res.json() };
}
async function unmark(classInstanceId: string, memberId: string): Promise<number> {
  const res = (await DELETE(new Request(`http://test/api/checkin?classInstanceId=${classInstanceId}&memberId=${memberId}`, { method: "DELETE" }))) as unknown as { status: number };
  return res.status;
}

function selfArgs(tenantId: string, memberId: string, classInstanceId: string): PerformCheckinArgs {
  return {
    tenantId, memberId, classInstanceId, method: "self",
    enforceRankGate: true, enforceTimeWindow: false, requireCoverage: true,
    enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true, enforceKidsGate: true,
    enforceVenueGate: true, enforceClassStateGate: true, allowanceGate: "refuse",
  };
}

describe.skipIf(!HAS_DB)("G4 coach one-off - real database", () => {
  let tenantId: string;
  let otherTenantId: string;
  let coachId: string;
  let tierId: string;
  let compTierId: string;
  let plainClass: string;
  let squadClass: string;
  let otherMemberId: string;
  let bypassesRls = false;
  let periodStart = Date.UTC(2032, 0, 5); // a Monday; the tier's periods are two weeks from here
  const memberIds: string[] = [];

  /** Three sessions of the plain class and one of the squad class, inside one two-week period. */
  async function freshPeriod() {
    periodStart += 28 * 86_400_000;
    const day = (n: number) => new Date(periodStart + n * 86_400_000);
    return withRlsBypass(async (tx) => {
      const mk = (classId: string, n: number) =>
        tx.classInstance.create({ data: { classId, date: day(n), startTime: "18:00", endTime: "19:00" } }).then((i) => i.id);
      return {
        p1: await mk(plainClass, 1), p2: await mk(plainClass, 2), p3: await mk(plainClass, 3), squad: await mk(squadClass, 2),
        noon: new Date(periodStart + 2 * 86_400_000 + 12 * 3_600_000),
      };
    });
  }
  async function newMember(): Promise<string> {
    const id = await withRlsBypass(async (tx) => (await tx.member.create({
      data: {
        tenantId, name: `One-off ${memberIds.length}`, email: `g4-oneoff-${STAMP}-${memberIds.length}@example.test`,
        membershipTierId: tierId, waiverAccepted: true, paymentStatus: "paid",
      },
    })).id);
    memberIds.push(id);
    return id;
  }
  const oneOffsFor = (memberId: string) =>
    withRlsBypass((tx) => tx.classOneOff.findMany({ where: { memberId }, orderBy: { createdAt: "asc" } }));
  const usageAt = (memberId: string, now: Date) =>
    withRlsBypass((tx) => memberAllowanceUsage(tx, { tenantId, memberId, now }));

  beforeAll(async () => {
    const [{ bypass }] = await prisma.$queryRawUnsafe<{ bypass: boolean }[]>(
      `SELECT rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`,
    );
    bypassesRls = bypass;
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: `One-off A ${STAMP}`, slug: `g4-oneoff-a-${STAMP}` } })).id;
      otherTenantId = (await tx.tenant.create({ data: { name: `One-off B ${STAMP}`, slug: `g4-oneoff-b-${STAMP}` } })).id;
      coachId = (await tx.user.create({
        data: { tenantId, email: `g4-coach-${STAMP}@example.test`, name: "Coach Jo", role: "coach", passwordHash: "x" },
      })).id;
      tierId = (await tx.membershipTier.create({
        data: { tenantId, name: "One a fortnight", classLimit: 1, classLimitBasis: "weeks", classLimitWeeks: 2, classLimitAnchor: new Date("2032-01-05") },
      })).id;
      compTierId = (await tx.membershipTier.create({ data: { tenantId, name: "Competition team" } })).id;
      plainClass = (await tx.class.create({ data: { tenantId, name: "Fundamentals", duration: 60, maxCapacity: 50 } })).id;
      squadClass = (await tx.class.create({ data: { tenantId, name: "Comp squad", duration: 60, maxCapacity: 50 } })).id;
      otherMemberId = (await tx.member.create({
        data: { tenantId, name: "Squad Member", email: `g4-squad-${STAMP}@example.test`, membershipTierId: compTierId, waiverAccepted: true },
      })).id;
      // The squad class: its list holds someone else, and only the competition plan may attend.
      await tx.classRoster.create({ data: { tenantId, classId: squadClass, memberId: otherMemberId } });
      await tx.classMembershipTier.create({ data: { tenantId, classId: squadClass, tierId: compTierId } });
    });
    session.user.id = coachId;
    session.user.tenantId = tenantId;
  });

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      for (const t of [tenantId, otherTenantId]) {
        await tx.classOneOff.deleteMany({ where: { tenantId: t } });
        await tx.classPackRedemption.deleteMany({ where: { memberPack: { tenantId: t } } });
        await tx.attendanceRecord.deleteMany({ where: { tenantId: t } });
        await tx.classRoster.deleteMany({ where: { tenantId: t } });
        await tx.classMembershipTier.deleteMany({ where: { tenantId: t } });
        await tx.classInstance.deleteMany({ where: { class: { tenantId: t } } });
        await tx.class.deleteMany({ where: { tenantId: t } });
        await tx.member.deleteMany({ where: { tenantId: t } });
        await tx.membershipTier.deleteMany({ where: { tenantId: t } });
        await tx.user.deleteMany({ where: { tenantId: t } });
        await tx.tenant.deleteMany({ where: { id: t } });
      }
    });
  }, 120_000);

  it("a member at their limit: refused by a mark, admitted by a one-off (not counted), and their own next check-in is still refused", async () => {
    const memberId = await newMember();
    const { p1, p2, p3, noon } = await freshPeriod();
    expect((await performCheckin(selfArgs(tenantId, memberId, p1))).kind).toBe("success");
    expect(await usageAt(memberId, noon)).toMatchObject({ used: 1, limit: 1 });

    const refused = await post({ classInstanceId: p2, memberId, checkInMethod: "admin" });
    expect(refused).toMatchObject({ status: 403, body: { reason: "allowance_reached" } });

    audit.calls.length = 0;
    const added = await post({ classInstanceId: p2, memberId, checkInMethod: "admin", oneOff: { reason: "  Trial for the comp squad  " } });
    expect(added.status).toBe(201);
    const recordId = (added.body.record as { id: string }).id;
    const [row] = await oneOffsFor(memberId);
    expect(row).toMatchObject({
      tenantId, classInstanceId: p2, memberId, attendanceRecordId: recordId, grantedById: coachId, reason: "Trial for the comp squad",
    });
    expect(audit.calls).toHaveLength(1);
    expect(audit.calls[0]).toMatchObject({
      action: "attendance.one_off", userId: coachId,
      metadata: { classInstanceId: p2, memberId, recordId, reason: "Trial for the comp squad", oneOffId: row.id, created: true },
    });

    // Not counted: still 1 of 1 for the period, and the member's own check-in
    // to another session in the same period is refused on that same count.
    expect(await usageAt(memberId, noon)).toMatchObject({ used: 1, limit: 1 });
    const own = await performCheckin(selfArgs(tenantId, memberId, p3));
    expect(own).toMatchObject({ kind: "allowance_reached", used: 1, limit: 1 });
    expect(await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { memberId, classInstanceId: p3 } }))).toBe(0);

    // A second one-off for the same session is "already checked in".
    const again = await post({ classInstanceId: p2, memberId, checkInMethod: "admin", oneOff: { reason: "Second go" } });
    expect(again).toMatchObject({ status: 409, body: { reason: "already_checked_in" } });
    expect(await oneOffsFor(memberId)).toHaveLength(1);
  }, 120_000);

  it("admits past the squad list and the plan restriction, for that session only", async () => {
    const memberId = await newMember();
    const { squad } = await freshPeriod();
    const refused = await post({ classInstanceId: squad, memberId, checkInMethod: "admin" });
    expect(refused).toMatchObject({ status: 403, body: { reason: "roster_not_listed" } });
    const added = await post({ classInstanceId: squad, memberId, checkInMethod: "admin", oneOff: { reason: "Sparring partner needed" } });
    expect(added.status).toBe(201);
    expect(await oneOffsFor(memberId)).toHaveLength(1);
    // The next session of the same class is not opened by it.
    const next = await withRlsBypass((tx) =>
      tx.classInstance.create({ data: { classId: squadClass, date: new Date(periodStart + 9 * 86_400_000), startTime: "18:00", endTime: "19:00" } }));
    expect(await post({ classInstanceId: next.id, memberId, checkInMethod: "admin" })).toMatchObject({ status: 403, body: { reason: "roster_not_listed" } });
  }, 120_000);

  it("the register's unmark removes the one-off with the visit, and the count recomputes", async () => {
    const memberId = await newMember();
    const { p1, p2, noon } = await freshPeriod();
    expect((await post({ classInstanceId: p2, memberId, checkInMethod: "admin", oneOff: { reason: "Guest of the coach" } })).status).toBe(201);
    expect(await oneOffsFor(memberId)).toHaveLength(1);
    expect(await unmark(p2, memberId)).toBe(200);
    expect(await oneOffsFor(memberId)).toHaveLength(0);
    expect(await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { memberId } }))).toBe(0);
    // Nothing counted before or after; their own class is still theirs to take.
    expect(await usageAt(memberId, noon)).toMatchObject({ used: 0, limit: 1 });
    expect((await performCheckin(selfArgs(tenantId, memberId, p1))).kind).toBe("success");
  }, 120_000);

  it("the Activity undo of attendance.one_off removes the visit and the one-off", async () => {
    const memberId = await newMember();
    const { p2 } = await freshPeriod();
    audit.calls.length = 0;
    expect((await post({ classInstanceId: p2, memberId, checkInMethod: "admin", oneOff: { reason: "Make-up class" } })).status).toBe(201);
    const entry = audit.calls[0];
    await withRlsBypass((tx) =>
      applyUndo(tx as never, {
        id: "audit-1", tenantId, userId: coachId, action: entry.action as string, entityType: entry.entityType as string,
        entityId: entry.entityId as string, metadata: entry.metadata, createdAt: new Date(),
      }));
    expect(await oneOffsFor(memberId)).toHaveLength(0);
    expect(await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { memberId, classInstanceId: p2 } }))).toBe(0);
  }, 120_000);

  it("the database refuses a reason under 3 or over 200 characters (CHECK)", async () => {
    const memberId = await newMember();
    const { p3 } = await freshPeriod();
    const recordId = await withRlsBypass(async (tx) =>
      (await tx.attendanceRecord.create({ data: { tenantId, memberId, classInstanceId: p3, checkInMethod: "admin" } })).id);
    for (const reason of ["ab", "x".repeat(201)]) {
      await expect(withRlsBypass((tx) =>
        tx.classOneOff.create({ data: { tenantId, classInstanceId: p3, memberId, attendanceRecordId: recordId, grantedById: coachId, reason } }),
      )).rejects.toThrow(/ClassOneOff_reason_length|check constraint/i);
    }
    await withRlsBypass((tx) => tx.attendanceRecord.delete({ where: { id: recordId } }));
  }, 120_000);

  it("RLS: another club can neither see, change nor create one in this club", async (ctx) => {
    const memberId = await newMember();
    const { p2, p3 } = await freshPeriod();
    expect((await post({ classInstanceId: p2, memberId, checkInMethod: "admin", oneOff: { reason: "Visiting from another gym" } })).status).toBe(201);
    const [row] = await oneOffsFor(memberId);
    // Own club, in context: visible.
    expect(await withTenantContext(tenantId, (tx) => tx.classOneOff.count({ where: { id: row.id } }))).toBe(1);
    if (bypassesRls) {
      // This connection's role bypasses RLS (the owner role): the enforcement
      // half runs under the restricted role (matflow_app) in the second pass.
      ctx.skip();
    }
    expect(await withTenantContext(otherTenantId, (tx) => tx.classOneOff.findMany({ where: { id: row.id } }))).toEqual([]);
    expect(await withTenantContext(otherTenantId, (tx) => tx.classOneOff.updateMany({ where: { id: row.id }, data: { reason: "Rewritten by another club" } }))).toEqual({ count: 0 });
    expect(await withTenantContext(otherTenantId, (tx) => tx.classOneOff.deleteMany({ where: { id: row.id } }))).toEqual({ count: 0 });
    const recordId = await withRlsBypass(async (tx) =>
      (await tx.attendanceRecord.create({ data: { tenantId, memberId, classInstanceId: p3, checkInMethod: "admin" } })).id);
    await expect(withTenantContext(otherTenantId, (tx) =>
      tx.classOneOff.create({ data: { tenantId, classInstanceId: p3, memberId, attendanceRecordId: recordId, grantedById: coachId, reason: "Planted by another club" } }),
    )).rejects.toThrow(/row-level security|policy/i);
    expect(await withRlsBypass((tx) => tx.classOneOff.findFirst({ where: { id: row.id }, select: { reason: true } }))).toEqual({ reason: "Visiting from another gym" });
  }, 120_000);
});
