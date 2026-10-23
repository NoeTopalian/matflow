// T7c — the plan class allowance against real Postgres (Neon child branch or
// CI's Postgres). Product decision 20 Oct 2026: an explicit reset basis.
//
// The unit tests pin the decisions; this proves the migrations and the routes
// really behave on the database:
//  - the CHECKs refuse an inconsistent set and out-of-range values, and accept
//    the previous build's INSERT shape (every new column absent -> NULL);
//  - PATCH writes every allowance column in step and nulls clear them;
//  - a legacy maxClassesPerWeek PATCH (a page loaded before T7c) is read as
//    N each calendar week;
//  - the previous build editing maxClassesPerWeek on a multi-week plan
//    (rollback) is read as a weekly allowance, not a rolling window;
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
import { BILLING_BASIS_UNAVAILABLE_MESSAGE, tierAllowance } from "@/lib/class-allowance";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const NONE = { maxClassesPerWeek: null, classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null };
const ANCHOR = new Date("2026-10-20T00:00:00.000Z");
const FOUR_IN_FOUR = { maxClassesPerWeek: null, classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: ANCHOR };

describe.skipIf(!HAS_DB)("MembershipTier class allowance — real database", () => {
  let tenantA: string;
  let tenantB: string;
  let ownerA: string;
  let tierA: string;
  let tierB: string;

  const cols = (id: string) =>
    withRlsBypass((tx) =>
      tx.membershipTier.findUniqueOrThrow({
        where: { id },
        select: { maxClassesPerWeek: true, classLimit: true, classLimitBasis: true, classLimitWeeks: true, classLimitAnchor: true },
      }),
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

  it("a tier created without the new columns (the previous build's shape) has them NULL, and reads as N each week", async () => {
    expect(await cols(tierA)).toEqual({ ...NONE, maxClassesPerWeek: 3 });
    expect(tierAllowance(await cols(tierA))).toEqual({ limit: 3, basis: "week" });
  });

  it.each([
    ["a limit without a basis", { classLimit: 4, classLimitBasis: null }, "MembershipTier_classLimit_basis_pair_check"],
    ["a basis without a limit", { classLimit: null, classLimitBasis: "week" }, "MembershipTier_classLimit_basis_pair_check"],
    ["an unknown basis", { classLimit: 4, classLimitBasis: "fortnight" }, "MembershipTier_classLimitBasis_check"],
    ["a limit of 0", { classLimit: 0, classLimitBasis: "week" }, "MembershipTier_classLimit_check"],
    ["a limit of 61", { classLimit: 61, classLimitBasis: "week" }, "MembershipTier_classLimit_check"],
    ["every-N-weeks with no weeks", { classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: null, classLimitAnchor: ANCHOR }, "MembershipTier_classLimitWeeks_check"],
    ["every-N-weeks with no start date", { classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: null }, "MembershipTier_classLimitWeeks_check"],
    ["1 week on the weeks basis", { classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 1, classLimitAnchor: ANCHOR }, "MembershipTier_classLimitWeeks_check"],
    ["9 weeks", { classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 9, classLimitAnchor: ANCHOR }, "MembershipTier_classLimitWeeks_check"],
    ["weeks data on the week basis", { classLimit: 4, classLimitBasis: "week", classLimitWeeks: 4, classLimitAnchor: ANCHOR }, "MembershipTier_classLimitWeeks_check"],
  ])("the database refuses %s", async (_label, data, constraint) => {
    await expect(
      withRlsBypass((tx) => tx.membershipTier.update({ where: { id: tierA }, data })),
    ).rejects.toThrow(new RegExp(constraint));
    expect(await cols(tierA)).toEqual({ ...NONE, maxClassesPerWeek: 3 });
  });

  it("every allowance CHECK is validated, and the superseded pair CHECK is gone", async () => {
    const rows = await withRlsBypass((tx) =>
      tx.$queryRaw<{ conname: string; convalidated: boolean }[]>`
        SELECT conname, convalidated FROM pg_constraint
        WHERE conrelid = '"MembershipTier"'::regclass AND conname LIKE 'MembershipTier_classLimit%'
        ORDER BY conname`,
    );
    expect(rows).toEqual([
      { conname: "MembershipTier_classLimitBasis_check", convalidated: true },
      { conname: "MembershipTier_classLimitWeeks_check", convalidated: true },
      { conname: "MembershipTier_classLimit_basis_pair_check", convalidated: true },
      { conname: "MembershipTier_classLimit_check", convalidated: true },
    ]);
  });

  it("PATCH 4 every 4 weeks from 20 October writes the set and nulls the legacy column", async () => {
    const res = await patch(tierA, { classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-10-20" });
    expect(res.status).toBe(200);
    expect(await cols(tierA)).toEqual(FOUR_IN_FOUR);
    expect(tierAllowance(await cols(tierA))).toEqual({ limit: 4, basis: "weeks", weeks: 4, anchor: "2026-10-20" });
  });

  it("PATCH 4 per billing period: refused with a 400 while the basis ships dark, nothing written; the column accepts it once released", async () => {
    // Release gate (22 Oct 2026): BILLING_BASIS_AVAILABLE is false until live
    // Stripe delivery is verified, so the route refuses the basis and the
    // 4-every-4-weeks set the previous case wrote is untouched.
    const res = await patch(tierA, { classLimit: 4, classLimitBasis: "billing" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(BILLING_BASIS_UNAVAILABLE_MESSAGE);
    expect(await cols(tierA)).toEqual(FOUR_IN_FOUR);
    // The schema (migration 20261021230000) already admits the basis, so the
    // release needs no migration: write it directly and read it back.
    await withRlsBypass((tx) => tx.membershipTier.update({ where: { id: tierA }, data: { ...NONE, classLimit: 4, classLimitBasis: "billing" } }));
    expect(tierAllowance(await cols(tierA))).toEqual({ limit: 4, basis: "billing" });
    // Put the 4-every-4-weeks set back: the next case starts from it.
    await patch(tierA, { classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-10-20" });
  });

  it("acceptance 4: the previous build editing maxClassesPerWeek during a rollback is read as N each week (the basis still wins while set)", async () => {
    // The old build writes only the column it knows; the basis row stays as it was.
    await withRlsBypass((tx) => tx.membershipTier.update({ where: { id: tierA }, data: { maxClassesPerWeek: 5 } }));
    expect(tierAllowance(await cols(tierA))).toEqual({ limit: 4, basis: "weeks", weeks: 4, anchor: "2026-10-20" });
    // Once the basis is cleared (the old build cannot do that), the legacy value is what is read.
    await withRlsBypass((tx) => tx.membershipTier.update({ where: { id: tierA }, data: { classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null } }));
    expect(tierAllowance(await cols(tierA))).toEqual({ limit: 5, basis: "week" });
  });

  it("a legacy maxClassesPerWeek PATCH is stored as N each calendar week", async () => {
    const res = await patch(tierA, { maxClassesPerWeek: 2 });
    expect(res.status).toBe(200);
    expect(await cols(tierA)).toEqual({ ...NONE, maxClassesPerWeek: 2, classLimit: 2, classLimitBasis: "week" });
  });

  it("a monthly allowance nulls the legacy column", async () => {
    const res = await patch(tierA, { classLimit: 8, classLimitBasis: "month" });
    expect(res.status).toBe(200);
    expect(await cols(tierA)).toEqual({ ...NONE, classLimit: 8, classLimitBasis: "month" });
  });

  it("nulls clear every allowance column (Unlimited)", async () => {
    const res = await patch(tierA, { classLimit: null, classLimitBasis: null, classLimitWeeks: null, classLimitAnchor: null });
    expect(res.status).toBe(200);
    expect(await cols(tierA)).toEqual(NONE);
    expect(tierAllowance(await cols(tierA))).toBeNull();
  });

  it("an inconsistent set is a 400 and writes nothing", async () => {
    const res = await patch(tierA, { classLimit: 4 });
    expect(res.status).toBe(400);
    expect(await cols(tierA)).toEqual(NONE);
  });

  it("another club's tier is a 404 and stays untouched", async () => {
    const res = await patch(tierB, { classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-10-20" });
    expect(res.status).toBe(404);
    expect(await cols(tierB)).toEqual(NONE);
  });

  it("POST creates with the allowance", async () => {
    const res = await POST(new Request("http://test/api/memberships", {
      method: "POST",
      body: JSON.stringify({ name: "Eight every four", pricePence: 0, currency: "GBP", billingCycle: "monthly", isKids: false, classLimit: 8, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-10-20" }),
    }));
    expect(res.status).toBe(201);
    const id = ((await res.json()) as { id: string }).id;
    expect(await cols(id)).toEqual({ ...FOUR_IN_FOUR, classLimit: 8 });
  });
});
