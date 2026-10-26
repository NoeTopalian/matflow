// D2 — booking preservation against real Postgres (Neon TEST branch).
//
// Noe, 21 Oct 2026: "Preserve bookings pending an approved migration policy,
// enforce current eligibility at attendance, and explain affected bookings
// visibly. Do not silently delete them." Proved here through the real route
// handlers and the real audit writer:
//  - no loss-of-access path deletes a booking: squad-list rewrite, rank gate
//    raise, membership-list narrowing, single squad removal, demotion;
//  - each writes a durable class.bookings.kept_ineligible row per trigger,
//    in the same transaction (a fault there rolls the whole change back);
//  - the PATCH judges the bookings under the Class lock: a booking committed
//    while it waits on the lock is counted;
//  - the door still refuses the member at attendance;
//  - the member's own cancel still deletes the booking.
// Synthetic data only; skips without DATABASE_URL.
import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
// The real audit writer, with one switch: make the durable D2 row throw.
const fault = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/audit-log", async (orig) => {
  const real = await orig<typeof import("@/lib/audit-log")>();
  return {
    ...real,
    logAudit: async (args: Parameters<typeof real.logAudit>[0]) => {
      if (fault.on && args.action === "class.bookings.kept_ineligible") throw new Error("injected audit failure");
      return real.logAudit(args);
    },
  };
});

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { PATCH as classPATCH } from "@/app/api/classes/[id]/route";
import { DELETE as rosterDELETE } from "@/app/api/classes/[id]/roster/[memberId]/route";
import { POST as demotePOST } from "@/app/api/members/[id]/rank/demote/route";
import { DELETE as bookingDELETE } from "@/app/api/member/class-subscriptions/[classId]/route";
import { performCheckin } from "@/lib/checkin";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

describe.skipIf(!HAS_DB)("D2 booking preservation — real database", () => {
  let tenantId = "";
  let ownerId = "";
  let tierBeg = "";
  let tierAdv = "";
  let white = "";
  let blue = "";
  const m: Record<"ann" | "ben" | "cat" | "dan" | "eve", string> = { ann: "", ben: "", cat: "", dan: "", eve: "" };

  const asOwner = () => mockAuth.mockResolvedValue({ user: { id: ownerId, role: "owner", tenantId } } as never);
  const newClass = async (name: string) =>
    withRlsBypass(async (tx) => (await tx.class.create({ data: { tenantId, name, duration: 60 } })).id);
  const book = (classId: string, memberId: string) =>
    withRlsBypass((tx) => tx.classSubscription.create({ data: { classId, memberId } }));
  const bookings = (classId: string) =>
    withRlsBypass(async (tx) => (await tx.classSubscription.findMany({ where: { classId }, select: { memberId: true } })).map((s) => s.memberId).sort());
  const keptRows = (classId: string) =>
    withRlsBypass((tx) =>
      tx.auditLog.findMany({ where: { tenantId, action: "class.bookings.kept_ineligible", entityId: classId }, orderBy: { createdAt: "asc" } }),
    ).then((rows) => rows.map((r) => r.metadata as Record<string, unknown>));
  const patch = (classId: string, body: unknown) => {
    asOwner();
    return classPATCH(new Request(`http://test/api/classes/${classId}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: classId }) });
  };

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: `D2 keep ${STAMP}`, slug: `d2-keep-${STAMP}` } })).id;
      ownerId = (await tx.user.create({ data: { tenantId, email: `d2-owner-${STAMP}@example.test`, name: "Owner", role: "owner", passwordHash: "x" } })).id;
      tierBeg = (await tx.membershipTier.create({ data: { tenantId, name: "Beginners" } })).id;
      tierAdv = (await tx.membershipTier.create({ data: { tenantId, name: "Advanced" } })).id;
      white = (await tx.rankSystem.create({ data: { tenantId, discipline: "BJJ", name: "White", order: 0 } })).id;
      blue = (await tx.rankSystem.create({ data: { tenantId, discipline: "BJJ", name: "Blue", order: 2 } })).id;
      for (const key of Object.keys(m) as Array<keyof typeof m>) {
        m[key] = (await tx.member.create({
          data: {
            tenantId, name: `D2 ${key}`, email: `d2-${key}-${STAMP}@example.test`,
            membershipTierId: key === "ann" ? tierBeg : tierAdv, waiverAccepted: true, paymentStatus: "paid",
          },
        })).id;
      }
      // Ben and Dan are blue belts; the others are white.
      for (const key of Object.keys(m) as Array<keyof typeof m>) {
        await tx.memberRank.create({ data: { memberId: m[key], rankSystemId: key === "ben" || key === "dan" ? blue : white } });
      }
    });
  }, 60_000);

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.classSubscription.deleteMany({ where: { class: { tenantId } } });
      await tx.classRoster.deleteMany({ where: { tenantId } });
      await tx.classMembershipTier.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.rankHistory.deleteMany({ where: { memberRank: { member: { tenantId } } } });
      await tx.memberRank.deleteMany({ where: { member: { tenantId } } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.rankSystem.deleteMany({ where: { tenantId } });
      await tx.membershipTier.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  }, 60_000);

  it("a squad-list rewrite keeps the bookings of members it drops, recorded durably (trigger squad)", async () => {
    const c = await newClass("Squad rewrite");
    await book(c, m.ann);
    await book(c, m.ben);
    expect((await patch(c, { roster: [{ memberId: m.ben }] })).status).toBe(200);
    expect(await bookings(c)).toEqual([m.ann, m.ben].sort());
    expect(await keptRows(c)).toEqual([expect.objectContaining({ trigger: "squad", memberIds: [m.ann], cause: "class.updated", bookingsKept: true })]);
  }, 60_000);

  it("raising the rank gate keeps the bookings of members below it (trigger rank)", async () => {
    const c = await newClass("Rank raise");
    await book(c, m.cat); // white
    await book(c, m.dan); // blue
    expect((await patch(c, { requiredRankId: blue })).status).toBe(200);
    expect(await bookings(c)).toEqual([m.cat, m.dan].sort());
    expect(await keptRows(c)).toEqual([expect.objectContaining({ trigger: "rank", memberIds: [m.cat] })]);
  }, 60_000);

  it("narrowing the membership list keeps the excluded booking (trigger membership), and the door still refuses at attendance", async () => {
    const c = await newClass("Narrowed");
    await book(c, m.ann); // Beginners
    await book(c, m.eve); // Advanced
    expect((await patch(c, { allowedTierIds: [tierAdv] })).status).toBe(200);
    expect(await bookings(c)).toEqual([m.ann, m.eve].sort());
    expect(await keptRows(c)).toEqual([expect.objectContaining({ trigger: "membership", memberIds: [m.ann] })]);
    const session = await withRlsBypass((tx) => tx.classInstance.create({ data: { classId: c, date: new Date("2031-03-03T00:00:00.000Z"), startTime: "18:00", endTime: "19:00" } }));
    const result = await performCheckin({
      tenantId, memberId: m.ann, classInstanceId: session.id, method: "self",
      enforceRankGate: true, enforceTimeWindow: false, requireCoverage: false, enforceCapacity: true, enforceWaiverGate: true,
    });
    expect(result.kind).toBe("tier_not_included");
  }, 60_000);

  it("a single squad removal takes the Class lock, keeps the booking and records it (trigger squad)", async () => {
    const c = await newClass("Single removal");
    await withRlsBypass(async (tx) => {
      await tx.classRoster.createMany({ data: [m.ann, m.ben].map((memberId) => ({ tenantId, classId: c, memberId })) });
    });
    await book(c, m.ann);
    asOwner();
    const res = await rosterDELETE(new Request("http://test", { method: "DELETE" }), { params: Promise.resolve({ id: c, memberId: m.ann }) });
    expect(res.status).toBe(200);
    expect(await bookings(c)).toEqual([m.ann]);
    expect(await withRlsBypass((tx) => tx.classRoster.count({ where: { classId: c, memberId: m.ann } }))).toBe(0);
    expect(await keptRows(c)).toEqual([expect.objectContaining({ trigger: "squad", memberIds: [m.ann], cause: "class.roster.remove" })]);
  }, 60_000);

  it("a demotion keeps the bookings it now fails, one durable row per class (trigger rank)", async () => {
    const c = await newClass("Blue only");
    await withRlsBypass((tx) => tx.class.update({ where: { id: c }, data: { requiredRankId: blue } }));
    await book(c, m.dan);
    asOwner();
    const res = await demotePOST(new Request("http://test", { method: "POST", body: JSON.stringify({ toRankId: white }) }), { params: Promise.resolve({ id: m.dan }) });
    expect(res.status).toBe(200);
    expect(await bookings(c)).toEqual([m.dan]);
    expect(await keptRows(c)).toEqual([expect.objectContaining({ trigger: "rank", memberIds: [m.dan], cause: "member.rank.demote" })]);
  }, 60_000);

  it("the durable row is part of the transaction: if it cannot be written, the change rolls back too", async () => {
    const c = await newClass("Atomic");
    await book(c, m.ann);
    fault.on = true;
    try {
      expect((await patch(c, { allowedTierIds: [tierAdv] })).status).toBe(500);
    } finally {
      fault.on = false;
    }
    expect(await withRlsBypass((tx) => tx.classMembershipTier.count({ where: { classId: c } }))).toBe(0);
    expect(await bookings(c)).toEqual([m.ann]);
    expect(await keptRows(c)).toEqual([]);
  }, 60_000);

  it("a booking committed while the PATCH waits on the Class lock is judged too (no stale pre-flight set)", async () => {
    const c = await newClass("Race");
    await book(c, m.ben);
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => { locked = r; });
    // A writer holding the Class lock (as the booking route does) books Cat and holds.
    const holder = withRlsBypass(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "Class" WHERE "id" = ${c} FOR UPDATE`;
      await tx.classSubscription.create({ data: { classId: c, memberId: m.cat } });
      locked();
      await gate;
    });
    await lockTaken;
    const edit = patch(c, { roster: [{ memberId: m.ben }] });
    await new Promise((r) => setTimeout(r, 500)); // the PATCH reaches the lock and waits
    release();
    await holder;
    expect((await edit).status).toBe(200);
    expect(await bookings(c)).toEqual([m.ben, m.cat].sort());
    expect(await keptRows(c)).toEqual([expect.objectContaining({ trigger: "squad", memberIds: [m.cat] })]);
  }, 60_000);

  it("the member's own cancel still deletes their booking", async () => {
    const c = await newClass("Own cancel");
    await book(c, m.eve);
    mockAuth.mockResolvedValue({ user: { id: "x", role: "member", tenantId, memberId: m.eve } } as never);
    const res = await bookingDELETE(new Request("http://test", { method: "DELETE" }), { params: Promise.resolve({ classId: c }) });
    expect(res?.status).toBe(200);
    expect(await bookings(c)).toEqual([]);
  }, 60_000);
});
