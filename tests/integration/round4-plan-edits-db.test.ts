// Round 4 (10 Nov 2026): a membership plan edited in two places keeps both
// changes, and a save from an older screen cannot put back an old price.
// Real PATCH /api/memberships/[id], Neon TEST branch, both database roles
// (db-tests.mjs). Synthetic clubs (r4p-), torn down here.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }) },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
const gate = vi.hoisted(() => ({ value: null as unknown }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: vi.fn(async () => gate.value) }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async (e: Record<string, unknown>) => { audit.calls.push(e); }) }));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { PATCH as patchTier } from "@/app/api/memberships/[id]/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r4p${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 120_000 });

type Res = { status: number; body: Record<string, unknown> };

describe.skipIf(!HAS_DB)("plan edits: no silent overwrite", () => {
  const club = { A: "", B: "" };
  let tierId = "";
  const as = (k: "A" | "B") => { gate.value = { ok: true, tenantId: club[k], userId: `${STAMP}-owner-${k}` }; };
  const patch = async (body: unknown): Promise<Res> => {
    const r = (await patchTier(
      new Request("https://test.local/", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: tierId }) },
    )) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
    return { status: r.status, body: await r.json() };
  };
  const row = () => withRlsBypass((tx) => tx.membershipTier.findUniqueOrThrow({ where: { id: tierId }, select: { name: true, pricePence: true, isKids: true } }));
  const reset = () => withRlsBypass((tx) => tx.membershipTier.update({ where: { id: tierId }, data: { name: "Adult Unlimited", pricePence: 6500, isKids: false } }));
  // What the plan editor sent before Round 4: every field, from when it opened.
  const wholeForm = (over: Record<string, unknown>) => ({ name: "Adult Unlimited", pricePence: 6500, currency: "GBP", billingCycle: "monthly", isKids: false, stripePriceId: null, stripeProductId: null, locationId: null, ...over });

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      for (const k of ["A", "B"] as const) {
        club[k] = (await tx.tenant.create({ data: { name: `${STAMP} ${k}`, slug: `${STAMP}-${k.toLowerCase()}` } })).id;
      }
      tierId = (await tx.membershipTier.create({ data: { tenantId: club.A, name: "Adult Unlimited", pricePence: 6500, currency: "GBP", billingCycle: "monthly" } })).id;
    });
  });
  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.membershipTier.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.tenant.deleteMany({ where: { id: { in: [club.A, club.B] } } });
    });
  });

  it("reproduction, the whole-form body sent before Round 4: a rename from an older tab puts the old price back", async () => {
    as("A");
    await reset();
    expect((await patch(wholeForm({ pricePence: 7000 }))).status).toBe(200); // tab 1: new price
    expect((await patch(wholeForm({ name: "Adults" }))).status).toBe(200);   // tab 2, opened earlier: rename
    expect(await row()).toMatchObject({ name: "Adults", pricePence: 6500 }); // the price change is lost
  });

  it("only changed fields with what they replace: a rename from an older tab keeps the new price", async () => {
    as("A");
    await reset();
    expect((await patch({ pricePence: 7000, expected: { pricePence: 6500 } })).status).toBe(200);
    expect((await patch({ name: "Adults", expected: { name: "Adult Unlimited" } })).status).toBe(200);
    expect(await row()).toMatchObject({ name: "Adults", pricePence: 7000 });
  });

  it("the same field from an older tab is refused with the current value; nothing in that save is written", async () => {
    as("A");
    await reset();
    expect((await patch({ pricePence: 7000, expected: { pricePence: 6500 } })).status).toBe(200);
    audit.calls.length = 0;
    const stale = await patch({ pricePence: 6000, isKids: true, expected: { pricePence: 6500, isKids: false } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ reason: "stale_plan", conflicts: [{ field: "pricePence", current: 7000 }] });
    expect(await row()).toMatchObject({ pricePence: 7000, isKids: false });
    expect(audit.calls).toHaveLength(0);
  });

  it("a retry after a lost reply succeeds once and is audited once", async () => {
    as("A");
    await reset();
    audit.calls.length = 0;
    const save = { pricePence: 7000, expected: { pricePence: 6500 } };
    expect((await patch(save)).status).toBe(200);
    expect((await patch(save)).status).toBe(200);
    expect((await row()).pricePence).toBe(7000);
    expect(audit.calls.filter((c) => c.action === "membership.tier.update")).toHaveLength(1);
  });

  it("two price edits at once from the same screen: exactly one is written", async () => {
    as("A");
    await reset();
    const results = await Promise.all([patch({ pricePence: 7000, expected: { pricePence: 6500 } }), patch({ pricePence: 8000, expected: { pricePence: 6500 } })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await row()).pricePence).toBe(results[0].status === 200 ? 7000 : 8000);
  });

  it("another club cannot edit this plan", async () => {
    as("B");
    await reset();
    expect((await patch({ pricePence: 1, expected: { pricePence: 6500 } })).status).toBe(404);
    expect((await row()).pricePence).toBe(6500);
  });

  // Review M: the allowance expects what the editor loaded too.
  it("two tabs change the class limit from 4: one wins, the other is told", async () => {
    as("A");
    await withRlsBypass((tx) => tx.membershipTier.update({ where: { id: tierId }, data: { classLimit: 4, classLimitBasis: "week", maxClassesPerWeek: 4, classLimitWeeks: null, classLimitAnchor: null } }));
    const base = { classLimit: 4, classLimitBasis: "week", classLimitWeeks: null, classLimitAnchor: null };
    const tabA = await patch({ classLimit: 8, classLimitBasis: "week", classLimitWeeks: null, classLimitAnchor: null, expected: base });
    const tabB = await patch({ classLimit: 6, classLimitBasis: "week", classLimitWeeks: null, classLimitAnchor: null, expected: base });
    expect([tabA.status, tabB.status]).toEqual([200, 409]);
    expect(tabB.body).toMatchObject({ reason: "stale_plan" });
    expect((await withRlsBypass((tx) => tx.membershipTier.findUniqueOrThrow({ where: { id: tierId } }))).classLimit).toBe(8);
  });

  it("a weekly-run allowance with an anchor date expects it as the page shows it (YYYY-MM-DD)", async () => {
    as("A");
    await withRlsBypass((tx) => tx.membershipTier.update({ where: { id: tierId }, data: { classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: new Date("2026-11-02T00:00:00.000Z"), maxClassesPerWeek: null } }));
    const r = await patch({ classLimit: 6, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-11-02", expected: { classLimit: 4, classLimitBasis: "weeks", classLimitWeeks: 4, classLimitAnchor: "2026-11-02" } });
    expect(r.status).toBe(200);
  });
});
