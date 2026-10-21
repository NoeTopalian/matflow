/**
 * T6a: "Who can attend" on POST /api/classes and PATCH /api/classes/[id].
 *
 *  - allowedTierIds is destructured, never spread into class.create, and the
 *    rows are written in the class's own transaction with its tenantId;
 *  - another club's tier id is a 400 and nothing is written (acceptance 7);
 *  - PATCH replaces the rows AFTER the Class row lock, and the narrowing
 *    cascade (bookings of members the new list excludes) is computed inside
 *    the write transaction and audited by member id (acceptance 8);
 *  - a rostered class is narrowed exactly the same way (roster AND tier
 *    both hold, 20 Oct 2026); a roster edit alone cascades nothing on tier
 *    grounds;
 *  - before/after tier ids ride on class.created / class.updated.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const db = vi.hoisted(() => ({
  order: [] as string[],
  class: { findFirst: vi.fn(), updateMany: vi.fn(), create: vi.fn() },
  classRoster: { deleteMany: vi.fn(), createMany: vi.fn(), count: vi.fn() },
  classSubscription: { findMany: vi.fn(), deleteMany: vi.fn() },
  classInstance: { createMany: vi.fn() },
  classMembershipTier: { findMany: vi.fn(), deleteMany: vi.fn(), createMany: vi.fn() },
  membershipTier: { findMany: vi.fn() },
  rankSystem: { findFirst: vi.fn() },
  member: { findMany: vi.fn() },
  user: { findFirst: vi.fn() },
  location: { findFirst: vi.fn() },
  tenant: { findUnique: vi.fn(), findFirst: vi.fn() },
  $queryRaw: vi.fn(),
}));
const mockAuth = vi.hoisted(() => vi.fn());
const logAudit = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/auth", () => ({ auth: mockAuth }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: vi.fn(async (_t: string, fn: (tx: unknown) => unknown) => fn(db)),
}));

import { PATCH } from "@/app/api/classes/[id]/route";
import { POST } from "@/app/api/classes/route";
import { CLASS_REF_ERRORS } from "@/lib/class-refs";
import { classCreateSchema } from "@/lib/schemas/class";

const T = "tenant_a";
const OURS = ["tier_beg", "tier_adv"];
const params = { params: Promise.resolve({ id: "c1" }) };
const patch = (body: unknown, qs = "") =>
  PATCH(new Request(`http://test/api/classes/c1${qs}`, { method: "PATCH", body: JSON.stringify(body) }), params);
const post = (body: unknown) => POST(new Request("http://test/api/classes", { method: "POST", body: JSON.stringify(body) }));
const base = { name: "Advanced", duration: 60, schedules: [{ dayOfWeek: 1, startTime: "19:00", endTime: "20:00" }] };

beforeEach(() => {
  vi.clearAllMocks();
  db.order.length = 0;
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "owner", tenantId: T } });
  db.class.findFirst.mockResolvedValue({ id: "c1", tenantId: T, allowedTiers: [] });
  db.class.updateMany.mockResolvedValue({ count: 1 });
  db.class.create.mockResolvedValue({ id: "c-new", name: "Advanced", schedules: [] });
  db.classRoster.count.mockResolvedValue(0);
  db.classSubscription.findMany.mockResolvedValue([]);
  db.classSubscription.deleteMany.mockResolvedValue({ count: 0 });
  db.classInstance.createMany.mockResolvedValue({ count: 0 });
  db.classMembershipTier.findMany.mockResolvedValue([]);
  db.classMembershipTier.deleteMany.mockImplementation(async () => { db.order.push("tiers.delete"); return { count: 0 }; });
  db.classMembershipTier.createMany.mockResolvedValue({ count: 0 });
  db.membershipTier.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] }; tenantId: string } }) =>
    where.tenantId === T ? where.id.in.filter((id) => OURS.includes(id)).map((id) => ({ id })) : [],
  );
  db.tenant.findUnique.mockResolvedValue({ timezone: "Europe/London" });
  db.tenant.findFirst.mockResolvedValue({ timezone: "Europe/London" });
  db.$queryRaw.mockImplementation(async () => { db.order.push("lock"); return [{ id: "c1" }]; });
});

describe("schema", () => {
  it("accepts up to 50 tier ids and removes duplicates", () => {
    const parsed = classCreateSchema.parse({ ...base, allowedTierIds: ["a", "a", "b"] });
    expect(parsed.allowedTierIds).toEqual(["a", "b"]);
    expect(classCreateSchema.safeParse({ ...base, allowedTierIds: Array.from({ length: 51 }, (_, i) => `t${i}`) }).success).toBe(false);
  });
});

describe("POST /api/classes", () => {
  it("writes the tier rows with the class's tenantId and never spreads the key into class.create", async () => {
    const res = await post({ ...base, allowedTierIds: ["tier_adv"] });
    expect(res.status).toBe(201);
    expect(db.class.create.mock.calls[0][0].data).not.toHaveProperty("allowedTierIds");
    expect(db.classMembershipTier.createMany).toHaveBeenCalledWith({
      data: [{ tenantId: T, classId: "c-new", tierId: "tier_adv", createdByUserId: "u1" }],
      skipDuplicates: true,
    });
    const audit = logAudit.mock.calls.find((c) => (c as unknown as [{ action: string }])[0].action === "class.created") as unknown as [{ metadata: Record<string, unknown> }];
    expect(audit[0].metadata.allowedTierIds).toEqual({ before: [], after: ["tier_adv"] });
  });

  it("returns allowedTiers ({id, name, isActive}) so the new timetable row shows its list without a refresh", async () => {
    db.membershipTier.findMany.mockImplementation(async () => [{ id: "tier_adv", name: "Advanced", isActive: true }]);
    const res = await post({ ...base, allowedTierIds: ["tier_adv"] });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { allowedTiers: unknown; allowedTierIds: unknown };
    expect(body.allowedTiers).toEqual([{ id: "tier_adv", name: "Advanced", isActive: true }]);
    expect(body.allowedTierIds).toEqual(["tier_adv"]);
  });

  it("no tiers = everyone: no rows written", async () => {
    const res = await post(base);
    expect(res.status).toBe(201);
    expect(db.classMembershipTier.createMany).not.toHaveBeenCalled();
  });

  it("acceptance 7: another club's tier id is a 400 and creates nothing", async () => {
    const res = await post({ ...base, allowedTierIds: ["tier_adv", "tier_other_club"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(CLASS_REF_ERRORS.tier);
    expect(db.class.create).not.toHaveBeenCalled();
    expect(db.classMembershipTier.createMany).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/classes/[id]", () => {
  it("acceptance 7: another club's tier id is a 400 before any write", async () => {
    const res = await patch({ allowedTierIds: ["tier_other_club"] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(CLASS_REF_ERRORS.tier);
    expect(db.classMembershipTier.deleteMany).not.toHaveBeenCalled();
    expect(db.classMembershipTier.createMany).not.toHaveBeenCalled();
    expect(db.class.updateMany).not.toHaveBeenCalled();
  });

  it("replaces the rows after the Class row lock", async () => {
    const res = await patch({ allowedTierIds: ["tier_adv"] });
    expect(res.status).toBe(200);
    expect(db.order).toEqual(["lock", "tiers.delete"]);
    expect(db.classMembershipTier.createMany).toHaveBeenCalledWith({
      data: [{ tenantId: T, classId: "c1", tierId: "tier_adv", createdByUserId: "u1" }],
      skipDuplicates: true,
    });
  });

  it("[] reopens the class to everyone", async () => {
    db.classMembershipTier.findMany.mockResolvedValue([{ tierId: "tier_adv" }]);
    const res = await patch({ allowedTierIds: [] });
    expect(res.status).toBe(200);
    expect(db.classMembershipTier.deleteMany).toHaveBeenCalledWith({ where: { classId: "c1", tenantId: T } });
    expect(db.classMembershipTier.createMany).not.toHaveBeenCalled();
  });

  it("an unchanged list is not rewritten and cascades nothing", async () => {
    db.classMembershipTier.findMany.mockResolvedValue([{ tierId: "tier_adv" }]);
    db.classSubscription.findMany.mockResolvedValue([{ memberId: "m_beg", member: { membershipTierId: "tier_beg" } }]);
    const res = await patch({ name: "Advanced BJJ", allowedTierIds: ["tier_adv"] });
    expect(res.status).toBe(200);
    expect(db.classMembershipTier.deleteMany).not.toHaveBeenCalled();
    expect(db.classSubscription.deleteMany).not.toHaveBeenCalled();
  });

  it("an edit that does not name tiers leaves them alone", async () => {
    await patch({ name: "Advanced BJJ" });
    expect(db.classMembershipTier.deleteMany).not.toHaveBeenCalled();
  });

  it("acceptance 8: narrowing removes the bookings it excludes and the audit lists them", async () => {
    db.classSubscription.findMany.mockResolvedValue([
      { memberId: "m_beg", member: { membershipTierId: "tier_beg" } },
      { memberId: "m_adv", member: { membershipTierId: "tier_adv" } },
      { memberId: "m_none", member: { membershipTierId: null } },
    ]);
    const res = await patch({ allowedTierIds: ["tier_adv"] });
    expect(res.status).toBe(200);
    expect(db.classSubscription.deleteMany).toHaveBeenCalledWith({
      where: { classId: "c1", memberId: { in: ["m_beg", "m_none"] }, member: { tenantId: T } },
    });
    const audit = logAudit.mock.calls.find((c) => (c as unknown as [{ action: string }])[0].action === "class.updated") as unknown as [{ metadata: Record<string, unknown> }];
    expect(audit[0].metadata.tierCascadeMemberIds).toEqual(["m_beg", "m_none"]);
    expect(audit[0].metadata.allowedTierIds).toEqual({ before: [], after: ["tier_adv"] });
    expect(audit[0].metadata.cascadeCancelledMemberIds).toEqual(["m_beg", "m_none"]);
  });

  it("the dry run previews the members a narrowing would remove and writes nothing", async () => {
    db.classSubscription.findMany.mockResolvedValue([{ memberId: "m_beg", member: { membershipTierId: "tier_beg" } }]);
    const res = await patch({ allowedTierIds: ["tier_adv"] }, "?dryRun=1");
    expect(await res.json()).toMatchObject({ dryRun: true, tierAffectedMemberIds: ["m_beg"] });
    expect(db.classMembershipTier.deleteMany).not.toHaveBeenCalled();
    expect(db.classSubscription.deleteMany).not.toHaveBeenCalled();
  });

  it("narrowing a ROSTERED class removes the bookings it excludes too (both must hold), audited by member id", async () => {
    db.classRoster.count.mockResolvedValue(2);
    db.classSubscription.findMany.mockResolvedValue([
      { memberId: "m_beg", member: { membershipTierId: "tier_beg" } },
      { memberId: "m_adv", member: { membershipTierId: "tier_adv" } },
    ]);
    const preview = await patch({ allowedTierIds: ["tier_adv"] }, "?dryRun=1");
    expect(await preview.json()).toMatchObject({ tierAffectedMemberIds: ["m_beg"] });

    const res = await patch({ allowedTierIds: ["tier_adv"] });
    expect(res.status).toBe(200);
    expect(db.classSubscription.deleteMany).toHaveBeenCalledWith({
      where: { classId: "c1", memberId: { in: ["m_beg"] }, member: { tenantId: T } },
    });
    const audit = logAudit.mock.calls.find((c) => (c as unknown as [{ action: string }])[0].action === "class.updated") as unknown as [{ metadata: Record<string, unknown> }];
    expect(audit[0].metadata.tierCascadeMemberIds).toEqual(["m_beg"]);
  });

  it("removing the roster with the list unchanged cascades nothing on tier grounds (the list already applied)", async () => {
    db.classRoster.count.mockResolvedValue(2); // the class had a roster
    db.classMembershipTier.findMany.mockResolvedValue([{ tierId: "tier_adv" }]); // list unchanged by this edit
    db.rankSystem.findFirst.mockResolvedValue({ id: "r_white", order: 0, discipline: "BJJ" });
    const ranked = [{ rankSystem: { discipline: "BJJ", order: 1 } }];
    db.classSubscription.findMany.mockResolvedValue([
      { memberId: "m_adv", member: { membershipTierId: "tier_adv", memberRanks: ranked } },
    ]);
    const preview = await patch({ requiredRankId: "r_white" }, "?dryRun=1");
    expect(await preview.json()).toMatchObject({ tierAffectedMemberIds: [] });
    const res = await patch({ requiredRankId: "r_white" });
    expect(res.status).toBe(200);
    expect(db.classSubscription.deleteMany).not.toHaveBeenCalled();
  });

  it("an edit that leaves the roster in place cascades nothing on tier grounds", async () => {
    db.classRoster.count.mockResolvedValue(2);
    db.classMembershipTier.findMany.mockResolvedValue([{ tierId: "tier_adv" }]);
    db.classSubscription.findMany.mockResolvedValue([{ memberId: "m_beg", member: { membershipTierId: "tier_beg" } }]);
    await patch({ name: "Comp Squad" });
    expect(db.classSubscription.deleteMany).not.toHaveBeenCalled();
  });

  it("a tier deleted between the check and the write rolls the edit back with a 400", async () => {
    let calls = 0;
    db.membershipTier.findMany.mockImplementation(async ({ where }: { where: { id: { in: string[] } } }) => {
      calls += 1;
      // First (pre-flight) sees it; the write-phase re-read does not.
      return calls === 1 ? where.id.in.map((id) => ({ id })) : [];
    });
    const res = await patch({ allowedTierIds: ["tier_adv"] });
    expect(res.status).toBe(400);
    expect(db.class.updateMany).not.toHaveBeenCalled();
  });
});
