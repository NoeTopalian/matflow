/**
 * What the nightly class-instances sweep does when its 240 s budget runs out (closure phase, 19 Nov 2026).
 *
 * tests/integration/cron-smoke.test.ts is the FUNCTIONAL test: the sweep makes the rows and a second run makes none.
 * It sweeps every active club in whatever database it is pointed at, so on a database holding hundreds of fixture
 * clubs over a slow link it measures capacity instead and times out. This file is the BUDGET test, and it does not
 * depend on how many clubs the database holds or how fast the link is: the per-club work is replaced by a stub that
 * spends the whole budget after BUDGET_CLUBS clubs, and the route's own loop decides the rest.
 *
 * Found: the clubs not reached are reported `skipped` (per club), the response is 200 ok:true with no top-level
 * marker, and the next run walks the clubs in the same order from the start. A club already up to date costs the
 * same as a stale one (generateClassHorizon re-derives the 56 days and re-inserts with skipDuplicates), so a sweep
 * that cannot finish tonight stops at about the same club tomorrow: the SAME clubs are missed every night. They are
 * still served by the member and kiosk read paths (lib/class-horizon.ts ensureClassHorizon), which is why this is a
 * capacity defect and not an outage. The two `it.fails` cells pin the open behaviour; they turn red when it is fixed.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const horizonCalls: string[] = [];
let spendBudgetAfter = Infinity;
let clockOffsetMs = 0;

vi.mock("@/lib/class-horizon", () => ({
  generateClassHorizon: vi.fn(async (tenantId: string) => {
    horizonCalls.push(tenantId);
    if (horizonCalls.length >= spendBudgetAfter) clockOffsetMs = 241_000;
    return { created: 0 };
  }),
}));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { GET as classInstancesCron } from "@/app/api/cron/class-instances/route";

const HAS_DB = !!process.env.DATABASE_URL;
const SECRET = "cron-budget-not-a-real-secret";
const BUDGET_CLUBS = 3;
const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const CLUBS = Array.from({ length: 6 }, (_, i) => `mfv-budget-${stamp}-${i}`);

type Body = { ok: boolean; partial?: boolean; tenantsProcessed: number; results: Array<{ tenantId: string; skipped?: boolean; created?: number }> };

async function sweep(): Promise<{ status: number; body: Body; reached: string[]; skipped: string[] }> {
  horizonCalls.length = 0;
  clockOffsetMs = 0;
  spendBudgetAfter = BUDGET_CLUBS;
  const realNow = Date.now.bind(Date);
  const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
  try {
    const res = await classInstancesCron(new Request("https://matflow.test/api/cron/class-instances", { headers: { authorization: `Bearer ${SECRET}` } }));
    const body = (await res.json()) as Body;
    return { status: res.status, body, reached: [...horizonCalls], skipped: body.results.filter((r) => r.skipped).map((r) => r.tenantId) };
  } finally {
    spy.mockRestore();
    clockOffsetMs = 0;
  }
}

describe.skipIf(!HAS_DB)("class-instances cron: what happens when the time budget expires", () => {
  let savedSecret: string | undefined;
  let first: Awaited<ReturnType<typeof sweep>>;
  let second: Awaited<ReturnType<typeof sweep>>;

  beforeAll(async () => {
    savedSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = SECRET;
    await withRlsBypass((tx) =>
      tx.tenant.createMany({ data: CLUBS.map((id) => ({ id, name: `Synthetic budget club ${id}`, slug: id, subscriptionStatus: "trial" })) }),
    );
    first = await sweep();
    second = await sweep();
  }, 120_000);

  afterAll(async () => {
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
    await withRlsBypass((tx) => tx.tenant.deleteMany({ where: { id: { in: CLUBS } } }));
  }, 120_000);

  it("stops starting clubs once the budget is spent and reports each club it did not reach as skipped", () => {
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.reached).toHaveLength(BUDGET_CLUBS);
    // Six synthetic clubs were added and only three clubs fit the budget, so at least three clubs were not reached.
    expect(first.skipped.length).toBeGreaterThanOrEqual(CLUBS.length - BUDGET_CLUBS);
    expect(first.body.tenantsProcessed).toBe(first.reached.length + first.skipped.length);
    for (const id of first.skipped) expect(first.reached).not.toContain(id);
  });

  it("the next run starts again from the same club: the clubs reached, and the clubs skipped, are the same both nights", () => {
    expect(second.reached).toEqual(first.reached);
    expect([...second.skipped].sort()).toEqual([...first.skipped].sort());
  });

  it.fails("OPEN: a second budget-limited run reaches at least one club the first run skipped", () => {
    expect(second.reached.some((id) => first.skipped.includes(id))).toBe(true);
  });

  it.fails("OPEN: a truncated sweep says so at the top level (the route header promises `partial: true`)", () => {
    expect(first.body.partial).toBe(true);
  });
});
