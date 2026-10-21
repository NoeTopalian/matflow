// T7 (Sean note 5) against real Postgres: the class allowance under
// concurrency. This is why the plan blocked T7 (planning evidence §8b.3 C10,
// §8c; execution plan §4): two check-ins for the same member, each locking
// only its own Class row, both counted 0 visits and both inserted.
//
// The engine now takes, inside the write transaction, Class FOR UPDATE, then
// the Member row (FOR NO KEY UPDATE), then one read (statement C), then the
// insert. These
// cases prove on a real database that:
//  1. parked on the Member lock, exactly one of two check-ins into two
//     different classes is admitted at the limit; the other is refused with
//     used 1 of 1 (deterministic interleaving, observed in pg_stat_activity);
//  2. the same holds unparked, repeated;
//  3. a double tap into the same session is "duplicate", never "allowance";
//  4. a desk override under contention is either an admission past the
//     allowance that carries the override, or an admission within it while
//     the member's own check-in is refused - never two admissions with no
//     override recorded;
//  5. a member-deletion cascade concurrent with a pack check-in holding the
//     Member lock completes without a deadlock (§8b.3 C1), because the
//     cascade now locks the Member row before the pack.
// Every case asserts no 40P01. Skips when DATABASE_URL is unset (CI's
// Postgres and the Neon TEST branch run it; never production).

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { performCheckin, type PerformCheckinArgs, type PerformCheckinResult } from "@/lib/checkin";
import { deleteMemberCascade } from "@/lib/member-delete";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

/** The member-app profile, minus the clock: sessions sit on fixed future dates. */
function selfArgs(tenantId: string, memberId: string, classInstanceId: string): PerformCheckinArgs {
  return {
    tenantId, memberId, classInstanceId, method: "self",
    enforceRankGate: true, enforceTimeWindow: false, requireCoverage: true,
    enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true, enforceKidsGate: true,
    enforceVenueGate: true, enforceClassStateGate: true, allowanceGate: "refuse",
  };
}
function deskArgs(tenantId: string, memberId: string, classInstanceId: string, confirmed: boolean): PerformCheckinArgs {
  return {
    tenantId, memberId, classInstanceId, method: "admin",
    enforceRankGate: false, enforceTimeWindow: false, requireCoverage: false,
    enforceCapacity: false, enforceWaiverGate: false, allowanceGate: "ask",
    allowanceOverrideConfirmed: confirmed, checkedInByUserId: null,
  };
}

// Matches the check-in's FOR NO KEY UPDATE and the cascade's FOR UPDATE.
const MEMBER_LOCK_SQL = '%FROM "Member" WHERE "id"%UPDATE%';

/** Polls pg_stat_activity until `n` backends are waiting on a lock in a statement matching `pattern`. */
async function waitForLockWaiters(pattern: string, n: number): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE ${pattern}
    `;
    if ((rows[0]?.n ?? 0) >= n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${n} backend(s) blocked on ${pattern}`);
}

/** A transaction that takes a lock, signals, and holds it until released. */
function holdLock(take: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let ready!: () => void;
  const isReady = new Promise<void>((r) => { ready = r; });
  const done = withRlsBypass(async (tx) => {
    await take(tx);
    ready();
    await released;
  });
  return { isReady, release, done };
}

function noDeadlock(results: unknown[]): void {
  for (const r of results) {
    const err = (r as { kind?: string; error?: { code?: string; message?: string } }).error;
    if ((r as { kind?: string }).kind === "error") {
      expect(String(err?.code ?? err?.message ?? err)).not.toMatch(/40P01|deadlock/i);
    }
  }
}

describe.skipIf(!HAS_DB)("Check-in class allowance - real database concurrency", () => {
  let tenantId: string;
  let tierId: string;
  let memberId: string;
  let packMemberId: string;
  let classX: string;
  let classY: string;
  let dayOffset = 0;

  /** Two sessions, X at 18:00 and Y at 19:00, on a date 30 days after the last pair (outside any earlier window). */
  async function freshPair(): Promise<{ x: string; y: string }> {
    dayOffset += 30;
    const date = new Date(Date.UTC(2031, 0, 6) + dayOffset * 86_400_000);
    return withRlsBypass(async (tx) => {
      const x = await tx.classInstance.create({ data: { classId: classX, date, startTime: "18:00", endTime: "19:00" } });
      const y = await tx.classInstance.create({ data: { classId: classY, date, startTime: "19:00", endTime: "20:00" } });
      return { x: x.id, y: y.id };
    });
  }
  const recordsIn = (ids: string[], mid = memberId) =>
    withRlsBypass((tx) => tx.attendanceRecord.count({ where: { memberId: mid, classInstanceId: { in: ids } } }));

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: `Allowance race ${STAMP}`, slug: `allowance-race-${STAMP}` } })).id;
      // 1 class every 2 weeks: the smallest limit, so every pair races for the last place.
      tierId = (await tx.membershipTier.create({
        data: { tenantId, name: "One a fortnight", classLimit: 1, classLimitWeeks: 2 },
      })).id;
      memberId = (await tx.member.create({
        data: {
          tenantId, name: "Race Member", email: `allowance-race-${STAMP}@test.local`,
          membershipTierId: tierId, waiverAccepted: true, paymentStatus: "paid",
        },
      })).id;
      classX = (await tx.class.create({ data: { tenantId, name: "Race X", duration: 60, maxCapacity: 50 } })).id;
      classY = (await tx.class.create({ data: { tenantId, name: "Race Y", duration: 60, maxCapacity: 50 } })).id;
    });
  });

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.classPackRedemption.deleteMany({ where: { memberPack: { tenantId } } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.memberClassPack.deleteMany({ where: { tenantId } });
      await tx.classPack.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.membershipTier.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  it("parked on the Member lock, exactly one of two check-ins into two classes is admitted at the limit", async () => {
    const { x, y } = await freshPair();
    // GATE: hold the member's row so both check-ins take their own Class lock
    // and then queue on the Member lock.
    const gate = holdLock((tx) => tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${memberId} FOR UPDATE`);
    await gate.isReady;
    const a = performCheckin(selfArgs(tenantId, memberId, x));
    const b = performCheckin(selfArgs(tenantId, memberId, y));
    // Both are parked behind the GATE on the Member row (each already holds
    // its own Class row: different classes, so they never waited on each other).
    await waitForLockWaiters(MEMBER_LOCK_SQL, 2);
    gate.release();
    await gate.done;
    const results = await Promise.all([a, b]);
    noDeadlock(results);
    const kinds = results.map((r) => r.kind).sort();
    expect(kinds).toEqual(["allowance_reached", "success"]);
    const refused = results.find((r) => r.kind === "allowance_reached") as Extract<PerformCheckinResult, { kind: "allowance_reached" }>;
    expect(refused).toMatchObject({ used: 1, limit: 1, weeks: 2, askable: false });
    expect(await recordsIn([x, y])).toBe(1);
  });

  it("unparked and repeated, two simultaneous check-ins never both pass the last place", async () => {
    for (let i = 0; i < 8; i += 1) {
      const { x, y } = await freshPair();
      const results = await Promise.all([
        performCheckin(selfArgs(tenantId, memberId, x)),
        performCheckin(selfArgs(tenantId, memberId, y)),
      ]);
      noDeadlock(results);
      expect(results.filter((r) => r.kind === "success")).toHaveLength(1);
      expect(results.filter((r) => r.kind === "allowance_reached")).toHaveLength(1);
      expect(await recordsIn([x, y])).toBe(1);
    }
  });

  it("a limit set while two check-ins are in flight is honoured: the lock does not depend on the plan (C10 / IT-A2)", async () => {
    // A member on an Unlimited plan; both check-ins are parked on the Member
    // row, already holding their Class rows, when the owner sets the limit.
    let tier2 = "";
    let member2 = "";
    await withRlsBypass(async (tx) => {
      tier2 = (await tx.membershipTier.create({ data: { tenantId, name: "Was unlimited" } })).id;
      member2 = (await tx.member.create({
        data: {
          tenantId, name: "Limit Later", email: `allowance-later-${STAMP}@test.local`,
          membershipTierId: tier2, waiverAccepted: true, paymentStatus: "paid",
        },
      })).id;
    });
    const { x, y } = await freshPair();
    const gate = holdLock((tx) => tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${member2} FOR UPDATE`);
    await gate.isReady;
    const a = performCheckin(selfArgs(tenantId, member2, x));
    const b = performCheckin(selfArgs(tenantId, member2, y));
    await waitForLockWaiters(MEMBER_LOCK_SQL, 2);
    // The owner's edit commits without waiting for either check-in (a plain
    // UPDATE of the tier row; the check-ins hold no lock on it).
    await withRlsBypass((tx) => tx.membershipTier.update({ where: { id: tier2 }, data: { classLimit: 1, classLimitWeeks: 2 } }));
    gate.release();
    await gate.done;
    const results = await Promise.all([a, b]);
    noDeadlock(results);
    expect(results.map((r) => r.kind).sort()).toEqual(["allowance_reached", "success"]);
    expect(await recordsIn([x, y], member2)).toBe(1);
  });

  it("a double tap into the same session is duplicate, never allowance_reached", async () => {
    const { x } = await freshPair();
    const results = await Promise.all([
      performCheckin(selfArgs(tenantId, memberId, x)),
      performCheckin(selfArgs(tenantId, memberId, x)),
    ]);
    noDeadlock(results);
    expect(results.map((r) => r.kind).sort()).toEqual(["duplicate", "success"]);
    expect(await recordsIn([x])).toBe(1);
  });

  it("desk override under contention: past the allowance only with the override recorded", async () => {
    const { x, y } = await freshPair();
    const gate = holdLock((tx) => tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${memberId} FOR UPDATE`);
    await gate.isReady;
    const own = performCheckin(selfArgs(tenantId, memberId, x));
    const desk = performCheckin(deskArgs(tenantId, memberId, y, true));
    await waitForLockWaiters(MEMBER_LOCK_SQL, 2);
    gate.release();
    await gate.done;
    const [o, d] = await Promise.all([own, desk]);
    noDeadlock([o, d]);
    expect(d.kind).toBe("success");
    if (d.kind !== "success") return;
    if (o.kind === "success") {
      // The member's own check-in won the lock; the desk then admitted past
      // the allowance, and says so with the count.
      expect(d.overrides).toEqual(["allowance_reached"]);
      expect(d.overAllowance).toMatchObject({ used: 1, limit: 1, weeks: 2 });
      expect(await recordsIn([x, y])).toBe(2);
    } else {
      // The desk won within the allowance (no override); the member's own
      // check-in then counted the desk's visit and was refused.
      expect(d.overrides).toBeUndefined();
      expect(o).toMatchObject({ kind: "allowance_reached", used: 1, limit: 1 });
      expect(await recordsIn([x, y])).toBe(1);
    }
  });

  it("an unconfirmed desk mark under contention: exactly one admission", async () => {
    const { x, y } = await freshPair();
    const results = await Promise.all([
      performCheckin(selfArgs(tenantId, memberId, x)),
      performCheckin(deskArgs(tenantId, memberId, y, false)),
    ]);
    noDeadlock(results);
    expect(results.filter((r) => r.kind === "success")).toHaveLength(1);
    const loser = results.find((r) => r.kind !== "success")!;
    expect(loser.kind).toBe("allowance_reached");
    expect(await recordsIn([x, y])).toBe(1);
  });

  it("a member-deletion cascade concurrent with a pack check-in holding the Member lock: no deadlock (C1)", async () => {
    // A pack-covered member (no plan): the check-in takes Class, Member, then the pack.
    let packId = "";
    await withRlsBypass(async (tx) => {
      packMemberId = (await tx.member.create({
        data: { tenantId, name: "Pack Member", email: `allowance-pack-${STAMP}@test.local`, waiverAccepted: true, paymentStatus: "overdue" },
      })).id;
      const template = await tx.classPack.create({ data: { tenantId, name: "Ten", totalCredits: 10, validityDays: 90, pricePence: 9000 } });
      packId = (await tx.memberClassPack.create({
        data: {
          tenantId, memberId: packMemberId, packId: template.id, creditsRemaining: 3, status: "active",
          expiresAt: new Date(Date.now() + 60 * 86_400_000),
        },
      })).id;
    });
    const { x } = await freshPair();

    // GATE holds the pack, so the check-in parks at its decrement while it
    // already holds Class X and the Member row.
    const gate = holdLock((tx) => tx.$queryRaw`SELECT "id" FROM "MemberClassPack" WHERE "id" = ${packId} FOR UPDATE`);
    await gate.isReady;
    const checkin = performCheckin(selfArgs(tenantId, packMemberId, x));
    await waitForLockWaiters('%MemberClassPack%', 1);

    // The cascade (as the DSAR child cascade and the tenant purge call it: no
    // prior lock) now waits on the Member row BEFORE touching the pack.
    const deletion = withRlsBypass((tx) => deleteMemberCascade(tx, { id: packMemberId, tenantId })).then(
      (v) => v,
      (e: unknown) => ({ kind: "threw" as const, error: e as { code?: string; message?: string } }),
    );
    await waitForLockWaiters(MEMBER_LOCK_SQL, 1);
    gate.release();
    await gate.done;

    const [c, del] = await Promise.all([checkin, deletion]);
    noDeadlock([c]);
    if ((del as { kind: string }).kind === "threw") {
      const e = (del as { error: { code?: string; message?: string } }).error;
      throw new Error(`cascade failed: ${e?.code ?? ""} ${e?.message ?? String(e)}`);
    }
    expect(c.kind).toBe("success");
    expect(del).toMatchObject({ kind: "ok" });
    const left = await withRlsBypass(async (tx) => ({
      member: await tx.member.count({ where: { id: packMemberId } }),
      attendance: await tx.attendanceRecord.count({ where: { memberId: packMemberId } }),
      packs: await tx.memberClassPack.count({ where: { memberId: packMemberId } }),
    }));
    expect(left).toEqual({ member: 0, attendance: 0, packs: 0 });
  });
});
