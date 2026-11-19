/**
 * What the nightly class-instances sweep does when its 240 s budget runs out (closure phase, 19 Nov 2026).
 *
 * tests/integration/cron-smoke.test.ts is the FUNCTIONAL test: the sweep makes the rows and a second run makes none.
 * It sweeps every active club in whatever database it is pointed at, so on a database holding hundreds of fixture
 * clubs over a slow link it measures capacity instead and times out. This file is the BUDGET test, and it does not
 * depend on how many clubs the database holds or how fast the link is: the per-club work is replaced by a stub that
 * spends the whole budget after BUDGET_CLUBS clubs, and the route's own ordering, claim and loop decide the rest.
 *
 * Found on 19 Nov and pinned here as expected failures until this change: the sweep read the clubs in no order and
 * started from the same club each night, so a budget-limited sweep reached, and skipped, the SAME clubs every night;
 * and the response had no top-level marker. Now the sweep takes the least recently attempted clubs first and claims
 * each club's turn before its work (Tenant.classHorizonSweptAt), so:
 *   - a club skipped tonight is ahead of every club attempted tonight tomorrow;
 *   - however often the budget runs out, every club is attempted within ceil(clubs / clubs-per-run) runs;
 *   - a club that fails has still had its turn, so it cannot hold the front of the queue;
 *   - two overlapping invocations do not do the same club twice.
 * Session rows are still deduplicated by the unique constraint; that is cron-smoke's subject, not this file's.
 *
 * The clubs this test adds are synthetic (`mfv-budget-…`) and removed afterwards. The sweeps also stamp the other
 * clubs of the database they run in (the route sweeps every active club); the stub means no session row is written.
 * It assumes no other session adds or removes clubs while it runs (true of the isolated database it is run on).
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const horizonCalls: string[] = [];
let spendBudgetAfter = Infinity;
let clockOffsetMs = 0;
let failFor: string | null = null;

vi.mock("@/lib/class-horizon", () => ({
  generateClassHorizon: vi.fn(async (tenantId: string) => {
    horizonCalls.push(tenantId);
    if (horizonCalls.length >= spendBudgetAfter) clockOffsetMs = 241_000;
    if (tenantId === failFor) throw new Error("synthetic failure for the budget test");
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

type Result = { tenantId: string; skipped?: boolean; created?: number; error?: string; claimedElsewhere?: boolean };
type Body = {
  ok: boolean;
  partial: boolean;
  tenantsTotal: number;
  tenantsProcessed: number;
  tenantsSkipped: number;
  tenantsClaimedElsewhere: number;
  tenantsFailed: number;
  results: Result[];
};
type Sweep = { status: number; body: Body; reached: string[]; skipped: string[] };

const request = () => new Request("https://matflow.test/api/cron/class-instances", { headers: { authorization: `Bearer ${SECRET}` } });

/** One sweep whose budget is spent after `budget` clubs. */
async function sweep(budget: number): Promise<Sweep> {
  horizonCalls.length = 0;
  clockOffsetMs = 0;
  spendBudgetAfter = budget;
  const realNow = Date.now.bind(Date);
  const spy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + clockOffsetMs);
  try {
    const res = await classInstancesCron(request());
    const body = (await res.json()) as Body;
    return { status: res.status, body, reached: [...horizonCalls], skipped: body.results.filter((r) => r.skipped).map((r) => r.tenantId) };
  } finally {
    spy.mockRestore();
    clockOffsetMs = 0;
    spendBudgetAfter = Infinity;
  }
}

describe.skipIf(!HAS_DB)("class-instances cron: what happens when the time budget expires", () => {
  let savedSecret: string | undefined;
  let warn: ReturnType<typeof vi.spyOn>;
  let error: ReturnType<typeof vi.spyOn>;
  const runs: Sweep[] = [];
  let total = 0;
  let runsAllowed = 0;

  beforeAll(async () => {
    savedSecret = process.env.CRON_SECRET;
    process.env.CRON_SECRET = SECRET;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    error = vi.spyOn(console, "error").mockImplementation(() => {});
    await withRlsBypass((tx) =>
      tx.tenant.createMany({ data: CLUBS.map((id) => ({ id, name: `Synthetic budget club ${id}`, slug: id, subscriptionStatus: "trial" })) }),
    );
    // Budget-limited sweeps, night after night, until each of this test's clubs has had a turn. The bound is the
    // guarantee itself: with N clubs and room for K per run, every club is attempted within ceil(N / K) runs.
    runs.push(await sweep(BUDGET_CLUBS));
    total = runs[0].body.tenantsTotal;
    runsAllowed = Math.ceil(total / BUDGET_CLUBS);
    const seen = () => new Set(runs.flatMap((r) => r.reached));
    while (runs.length < runsAllowed && !CLUBS.every((id) => seen().has(id))) runs.push(await sweep(BUDGET_CLUBS));
  }, 600_000);

  afterAll(async () => {
    warn?.mockRestore();
    error?.mockRestore();
    if (savedSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = savedSecret;
    await withRlsBypass((tx) => tx.tenant.deleteMany({ where: { id: { in: CLUBS } } }));
  }, 120_000);

  it("stops starting clubs once the budget is spent and reports each club it did not reach as skipped", () => {
    const first = runs[0];
    expect(first.status).toBe(200);
    expect(first.body.ok).toBe(true);
    expect(first.reached).toHaveLength(BUDGET_CLUBS);
    // Six synthetic clubs were added and only three clubs fit the budget, so at least three clubs were not reached.
    expect(first.skipped.length).toBeGreaterThanOrEqual(CLUBS.length - BUDGET_CLUBS);
    for (const id of first.skipped) expect(first.reached).not.toContain(id);
  });

  it("a truncated sweep says so at the top level, with honest counts, and logs a warning", () => {
    const first = runs[0];
    expect(first.body.partial).toBe(true);
    expect(first.body.tenantsProcessed).toBe(BUDGET_CLUBS);
    expect(first.body.tenantsSkipped).toBe(first.skipped.length);
    expect(first.body.tenantsTotal).toBe(first.body.tenantsProcessed + first.body.tenantsSkipped + first.body.tenantsClaimedElsewhere);
    expect(warn.mock.calls.some((c: unknown[]) => /partial sweep: 3 of \d+ clubs attempted/.test(String(c[0])))).toBe(true);
  });

  it("the next budget-limited run starts with clubs the first run skipped, not with the clubs it already did", () => {
    const [first, second] = runs;
    expect(second.reached).toHaveLength(BUDGET_CLUBS);
    for (const id of second.reached) {
      expect(first.skipped).toContain(id);
      expect(first.reached).not.toContain(id);
    }
  });

  it("a repeatedly exhausted budget cannot starve a club: every club has its turn within ceil(clubs / clubs-per-run) runs", () => {
    expect(runs.length).toBeLessThanOrEqual(runsAllowed);
    const reached = runs.flatMap((r) => r.reached);
    for (const id of CLUBS) expect(reached).toContain(id);
    // Until every club has had one turn, no club gets a second: the first `total` turns go to `total` different clubs.
    const firstRound = reached.slice(0, total);
    expect(new Set(firstRound).size).toBe(firstRound.length);
  });

  it("a club that fails has had its turn: the failure is reported, and the next run starts with other clubs", async () => {
    failFor = CLUBS[0];
    try {
      // Budget-limited runs until the failing club comes round.
      let failed: Sweep | undefined;
      for (let i = 0; i <= runsAllowed && !failed; i++) {
        const run = await sweep(BUDGET_CLUBS);
        if (run.reached.includes(CLUBS[0])) failed = run;
      }
      expect(failed).toBeDefined();
      expect(failed!.status).toBe(500);
      expect(failed!.body).toMatchObject({ ok: false, tenantsFailed: 1 });
      expect(failed!.body.results.find((r) => r.tenantId === CLUBS[0])?.error).toMatch(/synthetic failure/);
      const stamped = await withRlsBypass((tx) => tx.tenant.findUnique({ where: { id: CLUBS[0] }, select: { classHorizonSweptAt: true } }));
      expect(stamped?.classHorizonSweptAt).toBeInstanceOf(Date);
      const next = await sweep(BUDGET_CLUBS);
      expect(next.reached).toHaveLength(BUDGET_CLUBS);
      expect(next.reached).not.toContain(CLUBS[0]);
    } finally {
      failFor = null;
    }
  }, 600_000);

  it("two overlapping invocations do not do the same club twice, and between them leave no club undone", async () => {
    horizonCalls.length = 0;
    const [a, b] = await Promise.all([classInstancesCron(request()), classInstancesCron(request())]);
    const bodies = [(await a.json()) as Body, (await b.json()) as Body];
    const done = [...horizonCalls];
    expect(new Set(done).size).toBe(done.length);
    expect(done).toHaveLength(total);
    // Each club was done by one invocation or the other; the one that lost the claim says so and reports no error.
    for (const id of CLUBS) {
      const rows = bodies.map((body) => body.results.find((r) => r.tenantId === id));
      expect(rows.filter((r) => r && !r.claimedElsewhere && !r.skipped)).toHaveLength(1);
      expect(rows.some((r) => r?.error)).toBe(false);
    }
    expect(bodies.every((body) => body.ok && !body.partial)).toBe(true);
  }, 600_000);
});
