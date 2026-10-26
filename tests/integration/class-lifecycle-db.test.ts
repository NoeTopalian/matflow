// T6b — class lifecycle against real Postgres (Neon child branch).
//
// The unit tests pin the decisions against fakes; this proves the real
// writes, the guarded updateMany and the Undo inside a real transaction:
//  - Pause keeps the class's future sessions and bookings, and the per-class
//    Generate mints nothing for it (acceptance 1, 6);
//  - Archive of a class PAUSED first records that, and Undo of the archive
//    returns it to PAUSED, not active (acceptance 4), in a real transaction;
//  - Resume clears both markers and mints the rolling window (acceptance 2);
//  - an imported history class cannot be reactivated (acceptance 5).
//
// Skips when DATABASE_URL is unset (run on a Neon child branch, never prod).

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
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
const audit = vi.hoisted(() => ({ rows: [] as { action: string; entityId: string; metadata: unknown; tenantId: string }[] }));
vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn(async (r: { action: string; entityId: string; metadata: unknown; tenantId: string }) => {
    audit.rows.push(r);
  }),
}));

import { auth } from "@/auth";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { POST } from "@/app/api/classes/route";
import { PATCH, DELETE } from "@/app/api/classes/[id]/route";
import { POST as GENERATE } from "@/app/api/classes/[id]/instances/route";
import { applyUndo, decideUndo, type AuditRowLike } from "@/lib/undo-registry";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

describe.skipIf(!HAS_DB)("class lifecycle — real database", () => {
  let tenantId: string;
  let ownerId: string;
  let memberId: string;
  let classId: string;
  let importedClassId: string;

  const state = () =>
    withRlsBypass((tx) => tx.class.findUniqueOrThrow({ where: { id: classId }, select: { isActive: true, deletedAt: true } }));
  const sessions = () => withRlsBypass((tx) => tx.classInstance.count({ where: { classId } }));
  const bookings = () => withRlsBypass((tx) => tx.classSubscription.count({ where: { classId } }));
  const patch = (id: string, body: unknown) =>
    PATCH(new Request(`http://test/api/classes/${id}`, { method: "PATCH", body: JSON.stringify(body) }), {
      params: Promise.resolve({ id }),
    });

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `Lifecycle ${STAMP}`, slug: `lifecycle-${STAMP}` } });
      tenantId = t.id;
      ownerId = (await tx.user.create({
        data: { tenantId, email: `life-owner-${STAMP}@test.local`, name: "Owner", role: "owner", passwordHash: "x" },
      })).id;
      memberId = (await tx.member.create({
        data: { tenantId, name: "Lou Lifecycle", email: `life-m-${STAMP}@test.local`, waiverAccepted: true, paymentStatus: "paid" },
      })).id;
      importedClassId = (await tx.class.create({
        data: { tenantId, name: "Imported history", isActive: false, sourceImportJobId: `job-${STAMP}` },
      })).id;
    });
    mockAuth.mockResolvedValue({ user: { id: ownerId, role: "owner", tenantId } } as never);

    const res = await POST(new Request("http://test/api/classes", {
      method: "POST",
      body: JSON.stringify({ name: "Fundamentals", duration: 60, schedules: [{ dayOfWeek: 1, startTime: "19:00", endTime: "20:00" }] }),
    }));
    classId = ((await res.json()) as { id: string }).id;
    await withRlsBypass((tx) => tx.classSubscription.create({ data: { classId, memberId } }));
  });

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.classSubscription.deleteMany({ where: { class: { tenantId } } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  it("acceptance 1 + 6: Pause keeps sessions and bookings; Generate mints nothing and says it is paused", async () => {
    const before = await sessions();
    expect(before).toBeGreaterThan(0);
    expect((await patch(classId, { isActive: false })).status).toBe(200);
    expect(await state()).toEqual({ isActive: false, deletedAt: null });
    expect(await sessions()).toBe(before);
    expect(await bookings()).toBe(1);

    const gen = await GENERATE(
      new Request(`http://test/api/classes/${classId}/instances`, { method: "POST", body: JSON.stringify({ weeks: 4 }) }),
      { params: Promise.resolve({ id: classId }) },
    );
    expect(gen.status).toBe(409);
    expect(((await gen.json()) as { error: string }).error).toMatch(/paused/);
    expect(await sessions()).toBe(before);
  });

  it("acceptance 4: archiving a PAUSED class, then undoing the archive in a real transaction, returns it to PAUSED", async () => {
    audit.rows = [];
    const res = await DELETE(new Request(`http://test/api/classes/${classId}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: classId }),
    });
    expect(res.status).toBe(200);
    const archived = await state();
    expect(archived.isActive).toBe(false);
    expect(archived.deletedAt).toBeInstanceOf(Date);

    const logged = audit.rows.find((r) => r.action === "class.deleted");
    expect(logged).toBeDefined();
    const row: AuditRowLike = {
      id: "audit-1", tenantId, userId: ownerId, action: "class.deleted", entityType: "Class",
      entityId: classId, metadata: JSON.parse(JSON.stringify(logged!.metadata)), createdAt: new Date(),
    };
    expect(decideUndo(row, false)).toEqual({ ok: true });
    await withTenantContext(tenantId, (tx) => applyUndo(tx, row));
    expect(await state()).toEqual({ isActive: false, deletedAt: null });
    expect(await bookings()).toBe(1);
  });

  it("acceptance 2: Resume clears both markers, keeps the booking and mints the rolling window", async () => {
    await withRlsBypass((tx) => tx.classInstance.deleteMany({ where: { classId, date: { gte: new Date() } } }));
    const res = await patch(classId, { isActive: true });
    expect(res.status).toBe(200);
    expect(await state()).toEqual({ isActive: true, deletedAt: null });
    expect(((await res.json()) as { sessionsCreatedOnResume: number }).sessionsCreatedOnResume).toBeGreaterThan(0);
    expect(await bookings()).toBe(1);
  });

  it("acceptance 5: an imported history class cannot be reactivated, and nothing changes", async () => {
    const res = await patch(importedClassId, { isActive: true });
    expect(res.status).toBe(409);
    const row = await withRlsBypass((tx) => tx.class.findUniqueOrThrow({ where: { id: importedClassId }, select: { isActive: true, deletedAt: true } }));
    expect(row).toEqual({ isActive: false, deletedAt: null });
  });
});
