// D1 (24 Oct 2026): lock-order contention on real Postgres, for the riskiest
// pairs in docs/design/LOCK-ORDER-2026-10-24.md. Every check-in takes the
// Class row (FOR UPDATE), then the Member row (FOR NO KEY UPDATE); a writer
// that holds a Member row and then wants the Class row would deadlock with
// it. Each case forces the worst interleaving (a check-in parked on the
// Member lock while holding the Class lock) and observes it in
// pg_stat_activity, then lets it go.
//
//  A. deadlock probe, control: two transactions locking two Member rows in
//     opposite orders DO deadlock (Postgres detects it) — so a case below
//     that completes is evidence, not luck;
//  B. a writer locking Member then Class (the wrong order) against a parked
//     check-in deadlocks — the rule the writers follow is load-bearing;
//  C. the undo batch's own lock (lib/undo-batch.ts lockBatchRows: Classes,
//     then Members, id order) against a parked check-in: no deadlock;
//  D. a class PATCH squad rewrite (real route) against a parked check-in: it
//     queues on the Class lock; both complete; the check-in is judged on the
//     list it locked first;
//  E. a single squad removal (real route, which now takes the Class lock,
//     D2) against a parked check-in: it queues; both complete;
//  F. two multi-member writers in the same (ascending id) order — the undo
//     batch and the TeamUp status refresh batch since 24 Oct 2026 — queue
//     instead of deadlocking.
// Synthetic data; skips without DATABASE_URL.
import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));

import type { Prisma } from "@prisma/client";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { performCheckin, type PerformCheckinArgs } from "@/lib/checkin";
import { lockBatchRows, type PlanItem } from "@/lib/undo-batch";
import { PATCH as classPATCH } from "@/app/api/classes/[id]/route";
import { DELETE as rosterDELETE } from "@/app/api/classes/[id]/roster/[memberId]/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const DEADLOCK = /deadlock|40P01|P2034/i;

const MEMBER_LOCK_SQL = '%FROM "Member" WHERE "id"%UPDATE%';
const CLASS_LOCK_SQL = '%FROM "Class"%FOR UPDATE%';
/** lib/undo-batch.ts lockBatchRows: the Member and the Class statements. */
const BATCH_MEMBER_SQL = '%FROM "Member"%ORDER BY "id" FOR NO KEY UPDATE%';
const BATCH_CLASS_SQL = '%FROM "Class"%ORDER BY "id" FOR NO KEY UPDATE%';

async function waitForLockWaiters(pattern: string, n: number): Promise<void> {
  // Generous: from a distant client a request reaches its lock only after a dozen ~0.2 s round trips.
  const deadline = Date.now() + 30_000;
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
  }, { timeout: 90_000 });
  return { isReady, release, done };
}

const lockMember = (tx: Prisma.TransactionClient, id: string) =>
  tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${id} FOR NO KEY UPDATE`;
/** What an ordinary member UPDATE takes (the refresh batch's updateMany). */
const touchMember = (tx: Prisma.TransactionClient, id: string) =>
  tx.$executeRaw`UPDATE "Member" SET "notes" = "notes" WHERE "id" = ${id}`;

const memberItem = (id: string): PlanItem => ({
  row: { id: `audit-${id}`, tenantId: null, userId: null, action: "member.update", entityType: "Member", entityId: id, metadata: {}, createdAt: new Date() },
  decision: { ok: true },
});
const classItem = (id: string): PlanItem => ({
  row: { id: `audit-${id}`, tenantId: null, userId: null, action: "class.updated", entityType: "Class", entityId: id, metadata: {}, createdAt: new Date() },
  decision: { ok: true },
});

describe.skipIf(!HAS_DB)("D1 lock-order contention — real database", () => {
  let tenantId = "";
  let ownerId = "";
  let classId = "";
  let lowId = "";
  let highId = "";
  let other = "";
  let session = 0;

  const desk = (memberId: string, classInstanceId: string): PerformCheckinArgs => ({
    tenantId, memberId, classInstanceId, method: "admin",
    enforceRankGate: false, enforceTimeWindow: false, requireCoverage: false,
    enforceCapacity: false, enforceWaiverGate: false, checkedInByUserId: ownerId,
  });
  const newSession = () =>
    withRlsBypass(async (tx) => (await tx.classInstance.create({
      data: { classId, date: new Date(Date.UTC(2031, 4, 1 + session++)), startTime: "18:00", endTime: "19:00" },
    })).id);

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: `D1 locks ${STAMP}`, slug: `d1-locks-${STAMP}` } })).id;
      ownerId = (await tx.user.create({ data: { tenantId, email: `d1-owner-${STAMP}@example.test`, name: "Owner", role: "owner", passwordHash: "x" } })).id;
      classId = (await tx.class.create({ data: { tenantId, name: "Locks", duration: 60 } })).id;
      const ids: string[] = [];
      for (const n of [1, 2, 3]) {
        ids.push((await tx.member.create({
          data: { tenantId, name: `D1 ${n}`, email: `d1-${n}-${STAMP}@example.test`, waiverAccepted: true, paymentStatus: "paid" },
        })).id);
      }
      ids.sort();
      [lowId, highId, other] = ids;
    });
    mockAuth.mockResolvedValue({ user: { id: ownerId, role: "owner", tenantId } } as never);
  }, 60_000);

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.classSubscription.deleteMany({ where: { class: { tenantId } } });
      await tx.classRoster.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  }, 60_000);

  it("A (control): a refresh-style writer in DESCENDING order against the undo batch's ascending lock deadlocks — the probe can see one", async () => {
    // The TeamUp refresh batch before 24 Oct 2026 updated its slice in file
    // order; the undo batch locks members in id order. Opposite orders cycle.
    let goSecond!: () => void;
    const second = new Promise<void>((r) => { goSecond = r; });
    let firstHeld!: () => void;
    const held = new Promise<void>((r) => { firstHeld = r; });
    const a = withRlsBypass(async (tx) => {
      await touchMember(tx, highId);
      firstHeld();
      await second;
      await touchMember(tx, lowId);
    });
    await held;
    // The batch locks low, then parks on high (held by `a`).
    const b = withRlsBypass((tx) => lockBatchRows(tx, tenantId, [memberItem(lowId), memberItem(highId)]));
    await waitForLockWaiters(BATCH_MEMBER_SQL, 1);
    goSecond(); // `a` now wants low, which the batch holds: a cycle
    const results = await Promise.allSettled([a, b]);
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failed).toHaveLength(1);
    expect(String(failed[0].reason?.message ?? failed[0].reason)).toMatch(DEADLOCK);
  }, 60_000);

  it("B (control): a writer that locks Member then Class deadlocks with a check-in parked on that member", async () => {
    const sessionId = await newSession();
    let goClass!: () => void;
    const toClass = new Promise<void>((r) => { goClass = r; });
    let memberHeld!: () => void;
    const held = new Promise<void>((r) => { memberHeld = r; });
    const wrongOrder = withRlsBypass(async (tx) => {
      await lockMember(tx, lowId);
      memberHeld();
      await toClass;
      await tx.$queryRaw`SELECT "id" FROM "Class" WHERE "id" = ${classId} FOR UPDATE`;
    });
    await held;
    const checkin = performCheckin(desk(lowId, sessionId)); // takes Class, parks on Member
    await waitForLockWaiters(MEMBER_LOCK_SQL, 1);
    goClass();
    const [writer, result] = await Promise.allSettled([wrongOrder, checkin]);
    const writerDeadlocked = writer.status === "rejected" && DEADLOCK.test(String((writer as PromiseRejectedResult).reason?.message));
    const checkinDeadlocked = result.status === "fulfilled" && result.value.kind === "error" && DEADLOCK.test(String((result.value as { error: { message?: string } }).error?.message));
    expect(writerDeadlocked || checkinDeadlocked).toBe(true);
  }, 60_000);

  it("C: the undo batch's lock (Classes, then Members) queues behind a parked check-in — no deadlock", async () => {
    const sessionId = await newSession();
    const parker = holdLock((tx) => lockMember(tx, lowId));
    await parker.isReady;
    const checkin = performCheckin(desk(lowId, sessionId));
    await waitForLockWaiters(MEMBER_LOCK_SQL, 1); // holds Class, waits on Member
    const batch = withTenantContext(tenantId, (tx) => lockBatchRows(tx, tenantId, [classItem(classId), memberItem(lowId)]));
    await waitForLockWaiters(BATCH_CLASS_SQL, 1); // the batch waits on the Class row
    parker.release();
    await parker.done;
    const [result] = await Promise.all([checkin, batch]);
    expect(result.kind).toBe("success");
  }, 60_000);

  it("D: a squad rewrite (class PATCH) queues on the Class lock behind a parked check-in; the check-in is judged on the list it locked first", async () => {
    const sessionId = await newSession();
    await withRlsBypass((tx) => tx.classSubscription.create({ data: { classId, memberId: other } }));
    const parker = holdLock((tx) => lockMember(tx, highId));
    await parker.isReady;
    const checkin = performCheckin(desk(highId, sessionId)); // open class at lock time
    await waitForLockWaiters(MEMBER_LOCK_SQL, 1);
    const edit = classPATCH(new Request(`http://test/api/classes/${classId}`, { method: "PATCH", body: JSON.stringify({ roster: [{ memberId: lowId }] }) }), {
      params: Promise.resolve({ id: classId }),
    });
    await waitForLockWaiters(CLASS_LOCK_SQL, 1);
    parker.release();
    await parker.done;
    const [result, res] = await Promise.all([checkin, edit]);
    expect(result.kind).toBe("success");
    expect(res.status).toBe(200);
    // D2: the rewrite kept the booking of the member it dropped.
    expect(await withRlsBypass((tx) => tx.classSubscription.count({ where: { classId, memberId: other } }))).toBe(1);
  }, 60_000);

  it("E: a single squad removal (now under the Class lock) queues behind a parked check-in; both complete", async () => {
    const sessionId = await newSession();
    await withRlsBypass(async (tx) => {
      await tx.classRoster.deleteMany({ where: { tenantId, classId } });
      await tx.classRoster.createMany({ data: [lowId, highId].map((memberId) => ({ tenantId, classId, memberId })) });
    });
    const parker = holdLock((tx) => lockMember(tx, lowId));
    await parker.isReady;
    const checkin = performCheckin(desk(lowId, sessionId)); // on the squad list at lock time
    await waitForLockWaiters(MEMBER_LOCK_SQL, 1);
    const removal = rosterDELETE(new Request("http://test", { method: "DELETE" }), { params: Promise.resolve({ id: classId, memberId: lowId }) });
    await waitForLockWaiters(CLASS_LOCK_SQL, 1);
    parker.release();
    await parker.done;
    const [result, res] = await Promise.all([checkin, removal]);
    expect(result.kind).toBe("success");
    expect(res.status).toBe(200);
    expect(await withRlsBypass((tx) => tx.classRoster.count({ where: { classId, memberId: lowId } }))).toBe(0);
    // And after the removal the member is turned away at the next session.
    const later = await newSession();
    expect((await performCheckin(desk(lowId, later))).kind).toBe("roster_not_listed");
  }, 60_000);

  it("F: two multi-member writers in the same ascending order (undo batch, refresh batch) queue instead of deadlocking", async () => {
    let goSecond!: () => void;
    const second = new Promise<void>((r) => { goSecond = r; });
    let firstHeld!: () => void;
    const held = new Promise<void>((r) => { firstHeld = r; });
    // The refresh batch since 24 Oct 2026: its slice updated in member-id order.
    const refresh = withRlsBypass(async (tx) => {
      await touchMember(tx, lowId);
      firstHeld();
      await second;
      await touchMember(tx, highId);
    });
    await held;
    const undo = withRlsBypass((tx) => lockBatchRows(tx, tenantId, [memberItem(highId), memberItem(lowId)]));
    await waitForLockWaiters(BATCH_MEMBER_SQL, 1); // the batch waits on the low row, holding nothing
    goSecond();
    const results = await Promise.allSettled([refresh, undo]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"]);
  }, 60_000);

  it("G (C-2): a member deletion's lock and roster cascade against a squad rewrite that keeps that member — no deadlock", async () => {
    const squad = await withRlsBypass(async (tx) => {
      const id = (await tx.class.create({ data: { tenantId, name: "Squad G", duration: 60 } })).id;
      await tx.classRoster.createMany({ data: [lowId, highId].map((memberId) => ({ tenantId, classId: id, memberId })) });
      return id;
    });
    // The deletion's first step: the Member row FOR UPDATE (lib/member-delete.ts).
    let goCascade!: () => void;
    const toCascade = new Promise<void>((r) => { goCascade = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const deletion = withRlsBypass(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${lowId} FOR UPDATE`;
      held();
      await toCascade;
      // What ON DELETE CASCADE does to the member's roster rows.
      await tx.$executeRaw`DELETE FROM "ClassRoster" WHERE "memberId" = ${lowId} AND "classId" = ${squad}`;
    }, { timeout: 90_000 });
    await isHeld;
    const edit = classPATCH(new Request(`http://test/api/classes/${squad}`, { method: "PATCH", body: JSON.stringify({ roster: [{ memberId: lowId }] }) }), {
      params: Promise.resolve({ id: squad }),
    });
    // The rewrite parks on the member's KEY SHARE before it has touched a roster row.
    await waitForLockWaiters('%FROM "Member"%FOR KEY SHARE%', 1);
    goCascade();
    const [del, res] = await Promise.allSettled([deletion, edit]);
    expect(del.status).toBe("fulfilled");
    expect(res.status).toBe("fulfilled");
    expect((res as PromiseFulfilledResult<{ status: number }>).value.status).toBe(200);
    expect(await withRlsBypass((tx) => tx.classRoster.findMany({ where: { classId: squad }, select: { memberId: true } }))).toEqual([{ memberId: lowId }]);
  }, 90_000);

  it("G2 (C-2, review 25 Oct): the member is really deleted while the rewrite waits — the save succeeds without them", async () => {
    const { squad, goneId } = await withRlsBypass(async (tx) => {
      const goneId = (await tx.member.create({
        data: { tenantId, name: "D1 gone", email: `d1-gone-${STAMP}@example.test`, waiverAccepted: true, paymentStatus: "paid" },
      })).id;
      const squad = (await tx.class.create({ data: { tenantId, name: "Squad G2", duration: 60 } })).id;
      await tx.classRoster.createMany({ data: [goneId, highId].map((memberId) => ({ tenantId, classId: squad, memberId })) });
      return { squad, goneId };
    });
    let goDelete!: () => void;
    const toDelete = new Promise<void>((r) => { goDelete = r; });
    let held!: () => void;
    const isHeld = new Promise<void>((r) => { held = r; });
    const deletion = withRlsBypass(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${goneId} FOR UPDATE`;
      held();
      await toDelete;
      await tx.member.delete({ where: { id: goneId } });
    }, { timeout: 90_000 });
    await isHeld;
    const edit = classPATCH(new Request(`http://test/api/classes/${squad}`, {
      method: "PATCH",
      body: JSON.stringify({ roster: [{ memberId: goneId }, { memberId: highId }] }),
    }), { params: Promise.resolve({ id: squad }) });
    await waitForLockWaiters('%FROM "Member"%FOR KEY SHARE%', 1);
    goDelete();
    const [del, res] = await Promise.allSettled([deletion, edit]);
    expect(del.status).toBe("fulfilled");
    expect(res.status).toBe("fulfilled");
    expect((res as PromiseFulfilledResult<{ status: number }>).value.status).toBe(200);
    expect(await withRlsBypass((tx) => tx.classRoster.findMany({ where: { classId: squad }, select: { memberId: true } }))).toEqual([{ memberId: highId }]);
  }, 90_000);
});
