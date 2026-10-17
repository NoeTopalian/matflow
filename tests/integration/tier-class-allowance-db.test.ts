// T7c — the tier class allowance against real Postgres (Neon child branch or
// CI's Postgres).
//
// The unit tests pin the decisions; this proves the migration and the routes
// really behave on the database:
//  - the CHECKs refuse a split pair and out-of-range values, and accept the
//    previous build's INSERT shape (both new columns absent -> NULL);
//  - PATCH writes the three columns in step and a null pair clears them;
//  - a legacy maxClassesPerWeek PATCH (a page loaded before T7c) is read as
//    N every 1 week;
//  - the previous build editing maxClassesPerWeek on a multi-week plan
//    (rollback) is the value the reader rule returns (acceptance 4);
//  - the PATCH is tenant-scoped (another club's tier is a 404, untouched).
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
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST } from "@/app/api/memberships/route";
import { PATCH } from "@/app/api/memberships/[id]/route";
import { tierAllowance } from "@/lib/class-allowance";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

describe.skipIf(!HAS_DB)("MembershipTier class allowance — real database", () => {
  let tenantA: string;
  let tenantB: string;
  let ownerA: string;
  let tierA: string;
  let tierB: string;

  const cols = (id: string) =>
    withRlsBypass((tx) =>
      tx.membershipTier.findUniqueOrThrow({ where: { id }, select: { maxClassesPerWeek: true, classLimit: true, classLimitWeeks: true } }),
    );
  const patch = (id: string, body: unknown) =>
    PATCH(new Request(`http://test/api/memberships/${id}`, { method: "PATCH", body: JSON.stringify(body) }), {
      params: Promise.resolve({ id }),
    });

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const a = await tx.tenant.create({ data: { name: `Allow A ${STAMP}`, slug: `allow-a-${STAMP}` } });
      const b = await tx.tenant.create({ data: { name: `Allow B ${STAMP}`, slug: `allow-b-${STAMP}` } });
      tenantA = a.id;
      tenantB = b.id;
      ownerA = (await tx.user.create({
        data: { tenantId: tenantA, email: `allow-owner-${STAMP}@test.local`, name: "Owner", role: "owner", passwordHash: "x" },
      })).id;
      tierA = (await tx.membershipTier.create({ data: { tenantId: tenantA, name: "Four weekly", maxClassesPerWeek: 3 } })).id;
      tierB = (await tx.membershipTier.create({ data: { tenantId: tenantB, name: "Other club" } })).id;
    });
    mockAuth.mockResolvedValue({ user: { id: ownerA, role: "owner", tenantId: tenantA } } as never);
  });

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      for (const t of [tenantA, tenantB]) {
        if (!t) continue;
        await tx.membershipTier.deleteMany({ where: { tenantId: t } });
        await tx.user.deleteMany({ where: { tenantId: t } });
        await tx.tenant.deleteMany({ where: { id: t } });
      }
    });
  });

  it("a tier created without the new columns (the previous build's shape) has them NULL", async () => {
    expect(await cols(tierA)).toEqual({ maxClassesPerWeek: 3, classLimit: null, classLimitWeeks: null });
    expect(tierAllowance(await cols(tierA))).toEqual({ limit: 3, weeks: 1 });
  });

  it.each([
    ["a limit without weeks", { classLimit: 4, classLimitWeeks: null }, "MembershipTier_classLimit_pair_check"],
    ["weeks without a limit", { classLimit: null, classLimitWeeks: 4 }, "MembershipTier_classLimit_pair_check"],
    ["a limit of 0", { classLimit: 0, classLimitWeeks: 4 }, "MembershipTier_classLimit_check"],
    ["a limit of 61", { classLimit: 61, classLimitWeeks: 4 }, "MembershipTier_classLimit_check"],
    ["9 weeks", { classLimit: 4, classLimitWeeks: 9 }, "MembershipTier_classLimitWeeks_check"],
  ])("the database refuses %s", async (_label, data, constraint) => {
    await expect(
      withRlsBypass((tx) => tx.membershipTier.update({ where: { id: tierA }, data })),
    ).rejects.toThrow(new RegExp(constraint));
    expect(await cols(tierA)).toEqual({ maxClassesPerWeek: 3, classLimit: null, classLimitWeeks: null });
  });

  it("every new CHECK is validated", async () => {
    const rows = await withRlsBypass((tx) =>
      tx.$queryRaw<{ conname: string; convalidated: boolean }[]>`
        SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = '"MembershipTier"'::regclass AND conname LIKE 'MembershipTier_classLimit%'
        ORDER BY conname`,
    );
    expect(rows).toEqual([
      { conname: "MembershipTier_classLimitWeeks_check", convalidated: true },
      { conname: "MembershipTier_classLimit_check", convalidated: true },
      { conname: "MembershipTier_classLimit_pair_check", convalidated: true },
    ]);
  });

  it("PATCH 4 every 4 weeks writes the pair and nulls the legacy column", async () => {
    const res = await patch(tierA, { classLimit: 4, classLimitWeeks: 4 });
    expect(res.status).toBe(200);
    expect(await cols(tierA)).toEqual({ maxClassesPerWeek: null, classLimit: 4, classLimitWeeks: 4 });
    expect(tierAllowance(await cols(tierA))).toEqual({ limit: 4, weeks: 4 });
  });

  it("acceptance 4: the previous build editing maxClassesPerWeek during a rollback is what the new build then reads", async () => {
    // The old build writes only the column it knows.
    await withRlsBypass((tx) => tx.membershipTier.update({ where: { id: tierA }, data: { maxClassesPerWeek: 5 } }));
    expect(tierAllowance(await cols(tierA))).toEqual({ limit: 5, weeks: 1 });
  });

  it("a legacy maxClassesPerWeek PATCH is stored as N every 1 week", async () => {
    const res = await patch(tierA, { maxClassesPerWeek: 2 });
    expect(res.status).toBe(200);
    expect(await cols(tierA)).toEqual({ maxClassesPerWeek: 2, classLimit: 2, classLimitWeeks: 1 });
  });

  it("a null pair clears all three columns (Unlimited)", async () => {
    const res = await patch(tierA, { classLimit: null, classLimitWeeks: null });
    expect(res.status).toBe(200);
    expect(await cols(tierA)).toEqual({ maxClassesPerWeek: null, classLimit: null, classLimitWeeks: null });
    expect(tierAllowance(await cols(tierA))).toBeNull();
  });

  it("half a pair is a 400 and writes nothing", async () => {
    const res = await patch(tierA, { classLimit: 4 });
    expect(res.status).toBe(400);
    expect(await cols(tierA)).toEqual({ maxClassesPerWeek: null, classLimit: null, classLimitWeeks: null });
  });

  it("another club's tier is a 404 and stays untouched", async () => {
    const res = await patch(tierB, { classLimit: 4, classLimitWeeks: 4 });
    expect(res.status).toBe(404);
    expect(await cols(tierB)).toEqual({ maxClassesPerWeek: null, classLimit: null, classLimitWeeks: null });
  });

  it("POST creates with the allowance", async () => {
    const res = await POST(new Request("http://test/api/memberships", {
      method: "POST",
      body: JSON.stringify({ name: "Eight every four", pricePence: 0, currency: "GBP", billingCycle: "monthly", isKids: false, classLimit: 8, classLimitWeeks: 4 }),
    }));
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    expect(await cols(id)).toEqual({ maxClassesPerWeek: null, classLimit: 8, classLimitWeeks: 4 });
  });
});
