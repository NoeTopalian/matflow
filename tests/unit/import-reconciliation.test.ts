import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReconciliationInput } from "@/lib/import-reconciliation";

/**
 * Independent import reconciliation (3 Oct 2026). The comparison re-counts the
 * club's own rows and compares them with the importer's manifest. These tests
 * pin: a clean import passes every invariant; each class of drift is caught
 * and names its source rows; nothing personal leaves in the result; and every
 * database read is filtered to the caller's tenant.
 */

const txCalls: { model: string; op: string; args: unknown }[] = [];
let fakeDb: Record<string, Record<string, unknown>> = {};

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) => {
    const tx = new Proxy({}, {
      get: (_o, model: string) => new Proxy({}, {
        get: (_p, op: string) => (args: unknown) => {
          txCalls.push({ model, op, args });
          return Promise.resolve(fakeDb[model]?.[op] ?? (op === "count" ? 0 : null));
        },
      }),
    });
    return Promise.resolve(fn(tx));
  },
}));

const d = (s: string) => new Date(`${s}T00:00:00.000Z`);

function cleanInput(): ReconciliationInput {
  return {
    job: {
      id: "job1", source: "teamup", mode: "create", status: "complete",
      totalRows: 5, importedRows: 4, skippedRows: 1, errorRows: 0,
      rolledBackAt: null, createdAt: d("2026-10-03"), completedAt: d("2026-10-03"),
      manifest: {
        reconciles: true,
        input: { rows: 5, people: 5, parseErrors: 0 },
        commitErrors: 0,
        skippedExisting: 1,
        created: {
          total: 4,
          byStatus: { active: 3, cancelled: 1 },
          byAccountType: { adult: 3, kids: 1 },
          byPaymentStatus: { paid: 3, cancelled: 1 },
        },
        teamup2: {
          ledger: { rows: 6, persisted: 6, byEntitlement: { current: 3, history: 2, duplicate: 1 } },
          exceptions: { missingEmailActive: 0, unmatchedPlanLabels: [] },
        },
      },
    },
    members: [
      { id: "m1", accountType: "adult", status: "active", paymentStatus: "paid", billedBy: "teamup", membershipTierId: "t1", email: "alex@example.test", unverifiedEmail: null, name: "Alex Example", dateOfBirth: d("1990-01-01"), parentMemberId: null, guardianConfirmedAt: null },
      { id: "m2", accountType: "adult", status: "active", paymentStatus: "paid", billedBy: "teamup", membershipTierId: "t1", email: "bea@example.test", unverifiedEmail: null, name: "Bea Example", dateOfBirth: null, parentMemberId: null, guardianConfirmedAt: null },
      { id: "m3", accountType: "kids", status: "active", paymentStatus: "paid", billedBy: "teamup", membershipTierId: "t2", email: "kid-00ff@no-login.matflow.local", unverifiedEmail: null, name: "Cal Example", dateOfBirth: d("2016-05-05"), parentMemberId: "m1", guardianConfirmedAt: null },
      { id: "m4", accountType: "adult", status: "cancelled", paymentStatus: "cancelled", billedBy: "teamup", membershipTierId: null, email: "adult-11aa@no-login.matflow.local", unverifiedEmail: null, name: "Dee Example", dateOfBirth: null, parentMemberId: null, guardianConfirmedAt: null },
    ],
    ledger: [
      { sourceRow: 2, memberId: "m1", planLabel: "Adults Advanced 2026", entitlement: "current", disposition: "member_history" },
      { sourceRow: 3, memberId: "m1", planLabel: "Old Plan (OLD)", entitlement: "history", disposition: "member_history" },
      { sourceRow: 4, memberId: "m2", planLabel: "adults advanced 2026 ", entitlement: "current", disposition: "member_history" },
      { sourceRow: 5, memberId: "m3", planLabel: "Kids Unlimited 2026", entitlement: "current", disposition: "member_history" },
      { sourceRow: 6, memberId: "m4", planLabel: "Beginner Course", entitlement: "history", disposition: "member_history" },
      { sourceRow: 7, memberId: null, planLabel: "Adults Advanced 2026", entitlement: "duplicate", disposition: "duplicate_of:2" },
    ],
    // Whitespace and case differ on purpose: the match is trimmed and case-insensitive.
    tierNames: [" Adults Advanced 2026", "KIDS UNLIMITED 2026"],
    paymentsAttached: 0,
    attendanceAttached: 0,
    waiversSigned: 0,
  };
}

const failing = (r: { checks: { ok: boolean | null; kind: string; check: string }[] }) =>
  r.checks.filter((c) => c.ok === false).map((c) => `${c.kind}:${c.check}`);

beforeEach(() => {
  txCalls.length = 0;
  fakeDb = {};
});

describe("compareReconciliation — a clean import", () => {
  it("passes every invariant and moves no baseline", async () => {
    const { compareReconciliation } = await import("@/lib/import-reconciliation");
    const r = compareReconciliation(cleanInput());
    expect(failing(r)).toEqual([]);
    expect(r.summary.invariantsFailed).toBe(0);
    expect(r.summary.baselinesMoved).toBe(0);
    expect(r.summary.passed).toBeGreaterThan(15);
  });

  it("lists plan labels by live rows with their tier match", async () => {
    const { compareReconciliation } = await import("@/lib/import-reconciliation");
    const r = compareReconciliation(cleanInput());
    expect(r.planLabels[0]).toEqual({ label: "Adults Advanced 2026", rows: 3, liveRows: 2, tierMatched: true });
    expect(r.planLabels.find((l) => l.label === "Beginner Course")).toEqual({ label: "Beginner Course", rows: 1, liveRows: 0, tierMatched: false });
  });

  it("carries no name, email or date of birth", async () => {
    const { compareReconciliation } = await import("@/lib/import-reconciliation");
    const json = JSON.stringify(compareReconciliation(cleanInput()));
    for (const leak of ["Alex", "Bea Example", "Cal", "Dee", "@example.test", "no-login.matflow.local", "1990-01-01", "2016-05-05"]) {
      expect(json).not.toContain(leak);
    }
  });
});

describe("compareReconciliation — drift is caught", () => {
  it("a member deleted after the import breaks the people balance", async () => {
    const { compareReconciliation } = await import("@/lib/import-reconciliation");
    const input = cleanInput();
    input.members = input.members.filter((m) => m.id !== "m2");
    input.ledger = input.ledger.filter((l) => l.memberId !== "m2");
    const f = failing(compareReconciliation(input));
    expect(f).toContain("invariant:Members created (manifest)");
    expect(f).toContain("invariant:Members created (job counter)");
    expect(f).toContain("invariant:Every person accounted for (created + already in club + refused)");
  });

  it("a live member with no tier is flagged with its source rows", async () => {
    const { compareReconciliation } = await import("@/lib/import-reconciliation");
    const input = cleanInput();
    input.members[1].membershipTierId = null;
    const r = compareReconciliation(input);
    const c = r.checks.find((x) => x.check === "Members on a live plan with no tier")!;
    expect(c).toMatchObject({ kind: "baseline", expected: 0, actual: 1, ok: false, sourceRows: [4] });
  });

  it("a live plan label with no tier of that name is counted", async () => {
    const { compareReconciliation } = await import("@/lib/import-reconciliation");
    const input = cleanInput();
    input.tierNames = ["Adults Advanced 2026"];
    const c = compareReconciliation(input).checks.find((x) => x.check.startsWith("Plan labels on live rows"))!;
    expect(c).toMatchObject({ expected: 0, actual: 1, ok: false });
  });

  it("the same name and date of birth created twice is an invariant failure naming both people's rows", async () => {
    const { compareReconciliation } = await import("@/lib/import-reconciliation");
    const input = cleanInput();
    input.members.push({ ...input.members[0], id: "m5", email: "alex.two@example.test", name: "  alex   EXAMPLE " });
    input.ledger.push({ sourceRow: 8, memberId: "m5", planLabel: "Adults Advanced 2026", entitlement: "current", disposition: "member_history" });
    const c = compareReconciliation(input).checks.find((x) => x.check === "Same name and date of birth, created twice")!;
    expect(c).toMatchObject({ kind: "invariant", actual: 1, ok: false, sourceRows: [2, 3, 8] });
  });

  it("a ledger that lost rows, or a history row with no member, fails", async () => {
    const { compareReconciliation } = await import("@/lib/import-reconciliation");
    const input = cleanInput();
    input.ledger[1] = { ...input.ledger[1], memberId: null };
    input.ledger.pop();
    const f = failing(compareReconciliation(input));
    expect(f).toContain("invariant:Source rows recorded (manifest vs ledger)");
    expect(f).toContain("invariant:By entitlement: duplicate");
    expect(f).toContain("invariant:Member-history rows with no member");
  });

  it("payments, check-ins, waivers and confirmed guardians read as changes since import, not defects", async () => {
    const { compareReconciliation } = await import("@/lib/import-reconciliation");
    const input = cleanInput();
    input.paymentsAttached = 2;
    input.attendanceAttached = 9;
    input.waiversSigned = 1;
    input.members[2].guardianConfirmedAt = d("2026-10-04");
    const r = compareReconciliation(input);
    expect(r.summary.invariantsFailed).toBe(0);
    expect(r.summary.baselinesMoved).toBe(4);
  });

  it("a rolled-back or unfinished job fails the job checks", async () => {
    const { compareReconciliation } = await import("@/lib/import-reconciliation");
    const input = cleanInput();
    input.job.status = "failed";
    input.job.rolledBackAt = d("2026-10-04");
    const f = failing(compareReconciliation(input));
    expect(f).toContain("invariant:Import finished");
    expect(f).toContain("invariant:Not rolled back");
  });

  it("a manifest that never recorded a figure cannot pass on it", async () => {
    const { compareReconciliation } = await import("@/lib/import-reconciliation");
    const input = cleanInput();
    input.job.manifest = null;
    const f = failing(compareReconciliation(input));
    expect(f).toContain("invariant:Members created (manifest)");
    expect(f).toContain("invariant:Importer's own balance check");
  });

  it("a status refresh is not reconciled as if it created people", async () => {
    const { compareReconciliation } = await import("@/lib/import-reconciliation");
    const input = cleanInput();
    input.job.mode = "refresh";
    input.members = [];
    const r = compareReconciliation(input);
    expect(r.checks.map((c) => c.check)).toEqual(["Import finished", "Not rolled back", "Status refresh"]);
  });
});

describe("reconcileImport — reads are tenant-scoped", () => {
  it("returns null for a job that is not this club's", async () => {
    const { reconcileImport } = await import("@/lib/import-reconciliation");
    fakeDb = { importJob: { findFirst: null } };
    expect(await reconcileImport("t1", "job-of-another-club")).toBeNull();
    expect(txCalls).toHaveLength(1);
    expect(txCalls[0].args).toMatchObject({ where: { id: "job-of-another-club", tenantId: "t1" } });
  });

  it("filters every query on the tenant", async () => {
    const { reconcileImport } = await import("@/lib/import-reconciliation");
    const input = cleanInput();
    fakeDb = {
      importJob: { findFirst: input.job },
      member: { findMany: input.members },
      importedMembership: { findMany: input.ledger },
      membershipTier: { findMany: input.tierNames.map((name) => ({ name })) },
      payment: { count: 0 },
      attendanceRecord: { count: 0 },
      signedWaiver: { count: 0 },
    };
    const r = await reconcileImport("t1", "job1");
    expect(r?.summary.invariantsFailed).toBe(0);
    expect(txCalls.map((c) => `${c.model}.${c.op}`)).toEqual([
      "importJob.findFirst", "member.findMany", "importedMembership.findMany", "membershipTier.findMany",
      "payment.count", "attendanceRecord.count", "signedWaiver.count",
    ]);
    for (const c of txCalls) expect((c.args as { where: { tenantId: string } }).where.tenantId).toBe("t1");
    // Attachments are counted for exactly this job's members.
    expect((txCalls[4].args as { where: { memberId: { in: string[] } } }).where.memberId.in).toEqual(["m1", "m2", "m3", "m4"]);
  });
});
