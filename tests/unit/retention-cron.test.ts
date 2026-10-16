import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Audit P0-4 / P2-2: the daily retention sweep. These tests pin the three
// things that make it safe to run unattended against production:
//   1. it is unreachable without CRON_SECRET,
//   2. every rule deletes on the window the privacy policy publishes,
//   3. one failing rule cannot take the others down with it.
// The sweep has NO tenant rule (closed clubs are kept, 16 Oct 2026). The
// explicit erasure path, lib/tenant-purge.ts purgeTenantById, is exercised
// directly at the bottom of this file with the same mocked client.

// The fake prisma below does not model the RateLimitHit store; the limiter is assumed to allow (lane C4, R6-N3).
vi.mock("@/lib/rate-limit", async (orig) => (await import("./sec-c4-allow-rate-limit")).allowRateLimit(orig));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@vercel/blob", () => ({ del: vi.fn().mockResolvedValue(undefined) }));

// The member cascade walk itself is covered by
// tests/integration/member-cascade-delete.test.ts. Here it is a spy: what these
// tests care about is the ORDER purgeTenant feeds ids into it (kids before
// parents, or the Member_kids_must_have_parent CHECK aborts the transaction).
const { cascadeMock, cancelSubMock } = vi.hoisted(() => ({
  cascadeMock: vi.fn(),
  cancelSubMock: vi.fn(),
}));
vi.mock("@/lib/member-delete", () => ({ deleteMemberCascade: cascadeMock }));
vi.mock("@/lib/stripe/subscriptions", () => ({ cancelSubscriptionAtPeriodEnd: cancelSubMock }));

// The mocked client is resolved ONCE in the factory, not per call: purgeTenant
// opens two of these concurrently (`Promise.all` over member photos + waivers)
// and racing `await import("@/lib/prisma")` calls can hand one of them the real
// module, which then tries to open a Neon connection.
vi.mock("@/lib/prisma-tenant", async () => {
  const { prisma } = await import("@/lib/prisma");
  return {
    withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(prisma),
    withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn(prisma),
  };
});

// Every delegate the route touches. Defaults return "nothing left to delete"
// so a test only has to override the model it cares about. `emptyModel` lives
// inside the factory because vi.mock is hoisted above every top-level const.
vi.mock("@/lib/prisma", () => {
  const emptyModel = () => ({
    findMany: vi.fn().mockResolvedValue([]),
    deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
    updateMany: vi.fn().mockResolvedValue({ count: 0 }),
  });
  return {
  prisma: {
    auditLog: { ...emptyModel(), create: vi.fn().mockResolvedValue({}) },
    emailLog: emptyModel(),
    magicLinkToken: emptyModel(),
    passwordResetToken: emptyModel(),
    rateLimitHit: emptyModel(),
    stripeEvent: emptyModel(),
    importJob: emptyModel(),
    tenant: {
      ...emptyModel(),
      delete: vi.fn().mockResolvedValue({}),
      findUnique: vi.fn().mockResolvedValue({ stripeAccountId: null }),
    },
    task: emptyModel(),
    member: emptyModel(),
    // teamup-2 (2 Oct 2026): ImportedMembership is purged with the tenant.
    importedMembership: emptyModel(),
    // 3 Oct 2026: the attendance ledger, source mappings and chunked uploads.
    importedBooking: emptyModel(),
    importSourceMapping: emptyModel(),
    importUpload: emptyModel(),
    memberPhoto: emptyModel(),
    signedWaiver: emptyModel(),
    class: emptyModel(),
    classInstance: emptyModel(),
    classSchedule: emptyModel(),
    classSubscription: emptyModel(),
    classRoster: emptyModel(),
    classWaitlist: emptyModel(),
    attendanceRecord: emptyModel(),
    rankRequirement: emptyModel(),
    rankSystem: emptyModel(),
    pushSubscription: emptyModel(),
    loginEvent: emptyModel(),
    notification: emptyModel(),
    announcement: emptyModel(),
    membershipTier: emptyModel(),
    location: emptyModel(),
    memberClassPack: emptyModel(),
    classPack: emptyModel(),
    payment: emptyModel(),
    dispute: emptyModel(),
    order: emptyModel(),
    product: emptyModel(),
    monthlyReport: emptyModel(),
    initiative: emptyModel(),
    googleDriveConnection: emptyModel(),
    indexedDriveFile: emptyModel(),
    user: emptyModel(),
  },
  };
});

import { Prisma } from "@prisma/client";
import { del } from "@vercel/blob";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/cron/retention/route";
import { auditLogRetentionWhere } from "@/lib/audit-log";
import { purgeTenantById } from "@/lib/tenant-purge";

const SECRET = "test-cron-secret";
const NOW = new Date("2026-08-16T03:30:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function req(auth?: string) {
  return new Request("https://matflow.studio/api/cron/retention", {
    headers: auth ? { authorization: auth } : {},
  });
}

type RuleResult = { rule: string; deleted?: number; error?: string; skipped?: boolean };

/** A closed club, not yet claimed (the shape the erasure's preflight reads). */
function dueClub(over: Record<string, unknown> = {}) {
  return {
    stripeAccountId: null,
    deletedAt: new Date(NOW.getTime() - 40 * DAY_MS),
    purgeStartedAt: null,
    name: "Closed Gym",
    logoUrl: null,
    ...over,
  };
}

/**
 * The `where` a model's first paged findMany ran with. Takes `unknown` because
 * the mocked delegates still carry their generated Prisma types at compile time.
 */
function whereOf(model: unknown) {
  const fn = (model as { findMany: { mock: { calls: Array<[{ where?: unknown }]> } } }).findMany;
  return fn.mock.calls[0]?.[0]?.where;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.CRON_SECRET = SECRET;
  // Lane M1 (10 Oct 2026): the live sweep runs only with RETENTION_CRON_ENABLED exactly "true" (default OFF;
  // tests/unit/sec-m1-retention-cron-gate.test.ts). These tests pin the sweep itself, so the gate is open.
  process.env.RETENTION_CRON_ENABLED = "true";
  // vi.clearAllMocks() wipes the mockResolvedValue defaults too.
  for (const model of Object.values(prisma as unknown as Record<string, Record<string, unknown>>)) {
    const m = model as { findMany?: ReturnType<typeof vi.fn>; deleteMany?: ReturnType<typeof vi.fn>; updateMany?: ReturnType<typeof vi.fn>; create?: ReturnType<typeof vi.fn>; delete?: ReturnType<typeof vi.fn>; findUnique?: ReturnType<typeof vi.fn> };
    m.findMany?.mockResolvedValue([]);
    m.deleteMany?.mockResolvedValue({ count: 0 });
    m.updateMany?.mockResolvedValue({ count: 0 });
    m.create?.mockResolvedValue({});
    m.delete?.mockResolvedValue({});
    m.findUnique?.mockResolvedValue({ stripeAccountId: null });
  }
  // Reopen-vs-erase (lib/tenant-lifecycle.ts, 6 Oct 2026): the erasure claims
  // the club and every step re-validates the claim with a conditional tenant
  // updateMany; the final delete is a conditional deleteMany. Default: one
  // closed, unclaimed club that every conditional write matches.
  vi.mocked(prisma.tenant.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.tenant.deleteMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(prisma.tenant.findUnique).mockResolvedValue(dueClub() as never);
  vi.mocked(del).mockResolvedValue(undefined);
  cascadeMock.mockResolvedValue({ kind: "ok", name: "Member" });
  cancelSubMock.mockResolvedValue({ ok: true, cancelAt: null });
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe("GET /api/cron/retention — auth", () => {
  it("503s when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req("Bearer anything"));
    expect(res.status).toBe(503);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it("401s with no Authorization header", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it("401s with the wrong bearer token", async () => {
    const res = await GET(req("Bearer wrong-secret"));
    expect(res.status).toBe(401);
    expect(prisma.emailLog.findMany).not.toHaveBeenCalled();
  });

  it("runs with the correct bearer token", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; results: RuleResult[] };
    expect(body.ok).toBe(true);
    expect(body.results.map((r) => r.rule)).toEqual([
      "auditLog",
      "emailLog",
      "loginEvent",
      "magicLinkToken",
      "passwordResetToken",
      "rateLimitHit",
      "stripeEvent",
      "importUpload",
      "importJob",
      "importJobDiagnostics",
    ]);
    // Never a club: closed clubs are kept (16 Oct 2026).
    expect(body.results.filter((r) => /tenant|purge/i.test(r.rule))).toEqual([]);
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });
});

// ─── Dry run ──────────────────────────────────────────────────────────────────

describe("GET /api/cron/retention?dryRun=1 — counts, never deletes", () => {
  function dryReq(auth?: string) {
    return new Request("https://matflow.studio/api/cron/retention?dryRun=1", {
      headers: auth ? { authorization: auth } : {},
    });
  }

  it("still needs the bearer — the counts name tenants", async () => {
    expect((await GET(dryReq())).status).toBe(401);
    expect((await GET(dryReq("Bearer wrong"))).status).toBe(401);
  });

  it("reports what every rule would remove and calls no deleteMany, updateMany or cascade", async () => {
    for (const model of [prisma.auditLog, prisma.emailLog, prisma.loginEvent, prisma.magicLinkToken, prisma.passwordResetToken, prisma.rateLimitHit, prisma.stripeEvent, prisma.importUpload, prisma.importJob]) {
      (model as unknown as { count: ReturnType<typeof vi.fn> }).count = vi.fn().mockResolvedValue(7);
    }

    const res = await GET(dryReq(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; dryRun: boolean; results: Array<RuleResult & { details?: Record<string, unknown> }> };
    expect(body.dryRun).toBe(true);
    expect(body.ok).toBe(true);

    const byRule = Object.fromEntries(body.results.map((r) => [r.rule, r]));
    expect(byRule.auditLog).toMatchObject({ deleted: 0, details: { wouldDelete: 7 } });
    expect(byRule.stripeEvent).toMatchObject({ deleted: 0, details: { wouldDelete: 7 } });
    expect(byRule.importUpload).toMatchObject({ deleted: 0, details: { wouldDelete: 7 } });
    expect(byRule.importJob).toMatchObject({ deleted: 0, details: { wouldDelete: 7 } });
    expect(byRule.importJobDiagnostics).toMatchObject({ deleted: 0, details: { wouldScrub: 7 } });
    // A dry run names no club to purge, because no club is ever purged by the sweep.
    expect(Object.keys(byRule).filter((k) => /tenant|purge/i.test(k))).toEqual([]);
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();

    // The count is keyed on the same window the real rule deletes on.
    const auditCount = (prisma.auditLog as unknown as { count: ReturnType<typeof vi.fn> }).count;
    expect(auditCount).toHaveBeenCalledWith({ where: auditLogRetentionWhere(NOW) });

    for (const model of Object.values(prisma as unknown as Record<string, Record<string, unknown>>)) {
      const m = model as { deleteMany?: ReturnType<typeof vi.fn>; updateMany?: ReturnType<typeof vi.fn>; delete?: ReturnType<typeof vi.fn> };
      expect(m.deleteMany ?? vi.fn()).not.toHaveBeenCalled();
      expect(m.updateMany ?? vi.fn()).not.toHaveBeenCalled();
      expect(m.delete ?? vi.fn()).not.toHaveBeenCalled();
    }
    expect(cascadeMock).not.toHaveBeenCalled();
    expect(cancelSubMock).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });

  it("without the flag the sweep deletes as before", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { dryRun: boolean };
    expect(body.dryRun).toBe(false);
    expect(prisma.auditLog.findMany).toHaveBeenCalled();
  });
});

// ─── Cutoff maths ─────────────────────────────────────────────────────────────

describe("GET /api/cron/retention — retention windows", () => {
  // Operator audit 5 Oct 2026 (Q9-4). This pinned "every AuditLog row older
  // than 365 days", operator and erasure evidence included. Ordinary rows keep
  // the published twelve months; platform evidence is kept six years. The
  // predicate's behaviour on real rows is in
  // tests/integration/audit-durability-db.test.ts.
  it("deletes ordinary AuditLog rows after 365 days and platform evidence after six years", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(whereOf(prisma.auditLog)).toEqual(auditLogRetentionWhere(NOW));
    const where = auditLogRetentionWhere(NOW) as { OR: Array<Record<string, unknown>> };
    expect(where.OR[0].createdAt).toEqual({ lt: new Date(NOW.getTime() - 365 * DAY_MS) });
    expect(where.OR[1].createdAt).toEqual({ lt: new Date(NOW.getTime() - 6 * 365 * DAY_MS) });
    expect(JSON.stringify(where.OR[0].NOT)).toContain('"startsWith":"admin."');
    expect(JSON.stringify(where.OR[0].NOT)).toContain('"startsWith":"member.dsar_erase"');
  });

  it("deletes EmailLog rows older than 365 days", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(whereOf(prisma.emailLog)).toEqual({
      createdAt: { lt: new Date(NOW.getTime() - 365 * DAY_MS) },
    });
  });

  it("purges sign-in tokens 24h AFTER expiry, not on expiry", async () => {
    await GET(req(`Bearer ${SECRET}`));
    const cutoff = new Date(NOW.getTime() - DAY_MS);
    expect(whereOf(prisma.magicLinkToken)).toEqual({ expiresAt: { lt: cutoff } });
    expect(whereOf(prisma.passwordResetToken)).toEqual({ expiresAt: { lt: cutoff } });
    // Grace window: a token that expired an hour ago must NOT match, so an
    // in-flight verification still resolves to "expired" not "invalid".
    expect(cutoff.getTime()).toBeLessThan(NOW.getTime());
    expect(NOW.getTime() - cutoff.getTime()).toBe(DAY_MS);
  });

  it("deletes RateLimitHit rows older than 24 hours, keyed on hitAt", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(whereOf(prisma.rateLimitHit)).toEqual({
      hitAt: { lt: new Date(NOW.getTime() - DAY_MS) },
    });
  });

  it("deletes StripeEvent rows older than 90 days, keyed on processedAt", async () => {
    await GET(req(`Bearer ${SECRET}`));
    // StripeEvent has no createdAt column — processedAt is its only timestamp.
    expect(whereOf(prisma.stripeEvent)).toEqual({
      processedAt: { lt: new Date(NOW.getTime() - 90 * DAY_MS) },
    });
  });

  it("deletes only non-complete ImportJobs older than 30 days", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(whereOf(prisma.importJob)).toEqual({
      status: { notIn: ["complete"] },
      createdAt: { lt: new Date(NOW.getTime() - 30 * DAY_MS) },
      // A started attendance import owns bookings and visits; its job row is
      // what a resume or rollback needs, so it is never purged by age.
      NOT: { source: "teamup-attendance", status: { in: ["running", "failed"] } },
    });
  });

  it("deletes expired chunked uploads that never fed an import (consumed ones go with their job)", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(whereOf(prisma.importUpload)).toEqual({
      expiresAt: { lt: NOW },
      status: { not: "consumed" },
    });
  });

  it("batches deletes by id so a timeout cannot leave poison state", async () => {
    vi.mocked(prisma.auditLog.findMany)
      .mockResolvedValueOnce([{ id: "a1" }, { id: "a2" }] as never)
      .mockResolvedValue([] as never);
    vi.mocked(prisma.auditLog.deleteMany).mockResolvedValue({ count: 2 } as never);

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { results: RuleResult[] };

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true }, take: 1000 }),
    );
    expect(prisma.auditLog.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["a1", "a2"] } },
    });
    expect(body.results.find((r) => r.rule === "auditLog")?.deleted).toBe(2);
  });
});

// ─── Runtime cap ──────────────────────────────────────────────────────────────

describe("GET /api/cron/retention — runtime cap", () => {
  it("reports a deadline-truncated rule as partial, not as a failure, and skips the rest", async () => {
    // A full page whose fetch burns past the 240s budget: the rule commits
    // what it deleted, reports { partial, processed }, and the sweep stops
    // starting new rules. Every rule is idempotent, so tomorrow's run resumes.
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `a${i}` }));
    vi.mocked(prisma.auditLog.findMany).mockImplementation((async () => {
      vi.advanceTimersByTime(241_000);
      return page;
    }) as never);
    vi.mocked(prisma.auditLog.deleteMany).mockResolvedValue({ count: 1000 } as never);

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { ok: boolean; results: RuleResult[] };

    const auditRule = body.results.find((r) => r.rule === "auditLog")!;
    expect(auditRule).toMatchObject({ deleted: 1000, partial: true, processed: 1000 });
    expect(auditRule.error).toBeUndefined();
    // A truncated sweep is still a healthy sweep.
    expect(body.ok).toBe(true);

    for (const rule of body.results.filter((r) => r.rule !== "auditLog")) {
      expect(rule).toMatchObject({ skipped: true });
    }
    expect(prisma.emailLog.findMany).not.toHaveBeenCalled();
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });
});

// ─── Rule independence ────────────────────────────────────────────────────────

describe("GET /api/cron/retention — rule independence", () => {
  it("keeps running the remaining rules when one rule throws", async () => {
    vi.mocked(prisma.emailLog.findMany).mockRejectedValue(new Error("connection reset"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { ok: boolean; results: RuleResult[] };

    // Hardening 2026-08-16: failed sweeps must surface as 500 so status-code
    // monitoring (Vercel cron dashboard) can see them — 200 + ok:false is
    // invisible to uptime checks.
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.results.find((r) => r.rule === "emailLog")?.error).toBe("connection reset");

    // Every other rule still ran and reported a clean result.
    for (const rule of body.results.filter((r) => r.rule !== "emailLog")) {
      expect(rule.error).toBeUndefined();
      expect(rule.deleted).toBe(0);
    }
    // Rules after the failure specifically.
    expect(prisma.magicLinkToken.findMany).toHaveBeenCalled();
    expect(prisma.rateLimitHit.findMany).toHaveBeenCalled();
    expect(prisma.importJob.findMany).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

// ─── ImportJob blob handling ──────────────────────────────────────────────────

describe("GET /api/cron/retention — abandoned import CSVs", () => {
  it("deletes only Vercel Blob URLs and still drops every row", async () => {
    vi.mocked(prisma.importJob.findMany)
      .mockResolvedValueOnce([
        { id: "j1", tenantId: "t1", fileBlobUrl: "https://abc123.blob.vercel-storage.com/tenants/t1/imports/a.csv" },
        { id: "j2", tenantId: "t1", fileBlobUrl: "https://evil.example.com/imports/b.csv" },
        { id: "j3", tenantId: "t1", fileBlobUrl: "" },
        { id: "j4", tenantId: "t1", fileBlobUrl: "https://blob.vercel-storage.com/tenants/t1/imports/d.csv" },
        // Another club namespace on a row of THIS club: left in place (14 Oct 2026).
        { id: "j5", tenantId: "t1", fileBlobUrl: "https://abc123.blob.vercel-storage.com/tenants/t2/imports/e.csv" },
      ] as never)
      .mockResolvedValue([] as never);
    vi.mocked(prisma.importJob.deleteMany).mockResolvedValue({ count: 5 } as never);

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { results: RuleResult[] };

    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith([
      "https://abc123.blob.vercel-storage.com/tenants/t1/imports/a.csv",
      "https://blob.vercel-storage.com/tenants/t1/imports/d.csv",
    ]);
    // The non-blob and empty URLs are skipped, but their rows still go.
    expect(prisma.importJob.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["j1", "j2", "j3", "j4", "j5"] } },
    });
    expect(body.results.find((r) => r.rule === "importJob")?.deleted).toBe(5);
  });

  it("deletes a chunked upload (db-upload://) with its abandoned job, scoped to the job's tenant", async () => {
    vi.mocked(prisma.importJob.findMany)
      .mockResolvedValueOnce([
        { id: "j1", tenantId: "t1", fileBlobUrl: "db-upload://up1" },
        { id: "j2", tenantId: "t2", fileBlobUrl: "https://abc.blob.vercel-storage.com/tenants/t2/imports/b.csv" },
      ] as never)
      .mockResolvedValue([] as never);
    vi.mocked(prisma.importJob.deleteMany).mockResolvedValue({ count: 2 } as never);
    vi.mocked(prisma.importUpload.deleteMany).mockResolvedValue({ count: 1 } as never);

    await GET(req(`Bearer ${SECRET}`));
    expect(prisma.importUpload.deleteMany).toHaveBeenCalledWith({ where: { OR: [{ id: "up1", tenantId: "t1" }] } });
    expect(del).toHaveBeenCalledWith(["https://abc.blob.vercel-storage.com/tenants/t2/imports/b.csv"]);
    expect(prisma.importJob.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["j1", "j2"] } } });
  });

  it("does not call del() when no job holds a blob URL", async () => {
    vi.mocked(prisma.importJob.findMany)
      .mockResolvedValueOnce([{ id: "j1", fileBlobUrl: "" }] as never)
      .mockResolvedValue([] as never);
    vi.mocked(prisma.importJob.deleteMany).mockResolvedValue({ count: 1 } as never);

    await GET(req(`Bearer ${SECRET}`));
    expect(del).not.toHaveBeenCalled();
  });

  it("survives a blob-storage failure and still deletes the rows", async () => {
    vi.mocked(prisma.importJob.findMany)
      .mockResolvedValueOnce([
        { id: "j1", tenantId: "t1", fileBlobUrl: "https://abc.blob.vercel-storage.com/tenants/t1/imports/a.csv" },
      ] as never)
      .mockResolvedValue([] as never);
    vi.mocked(prisma.importJob.deleteMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(del).mockRejectedValue(new Error("blob store down"));
    const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { ok: boolean; results: RuleResult[] };

    expect(body.ok).toBe(true);
    expect(body.results.find((r) => r.rule === "importJob")?.deleted).toBe(1);
    consoleWarn.mockRestore();
  });
});

// ─── Explicit club erasure (lib/tenant-purge.ts purgeTenantById) ─────────────
// Closed clubs are kept (16 Oct 2026): the sweep has no tenant rule, so the
// erasure path is exercised directly, the way an operator runs it on a club's
// written request. Same mocked client: a closed, unclaimed club that every
// conditional write matches.

describe("purgeTenantById — explicit erasure of one closed club", () => {
  it("erases a club closed yesterday when asked: there is no age requirement", async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue(dueClub({ deletedAt: new Date(NOW.getTime() - DAY_MS) }) as never);

    const out = await purgeTenantById("t1", NOW, () => false);

    expect(out).toMatchObject({ kind: "purged", resumed: false });
    // The claim is keyed on "closed and unclaimed" only — no date predicate.
    expect(prisma.tenant.updateMany).toHaveBeenCalledWith({
      where: { id: "t1", deletedAt: { not: null }, purgeStartedAt: null },
      data: { purgeStartedAt: NOW },
    });
  });

  it("never erases an open club: skipped as 'restored' with no claim, no Stripe call and no delete", async () => {
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue(dueClub({ deletedAt: null }) as never);

    const out = await purgeTenantById("t1", NOW, () => false);

    expect(out).toEqual({ kind: "skipped", reason: "restored" });
    expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
    expect(cancelSubMock).not.toHaveBeenCalled();
    expect(prisma.tenant.deleteMany).not.toHaveBeenCalled();
    expect(cascadeMock).not.toHaveBeenCalled();
  });

  it("writes the erasure-evidence audit row in the same transaction as the tenant delete, naming the written request", async () => {
    const out = await purgeTenantById("t1", NOW, () => false);

    expect(out).toMatchObject({ kind: "purged" });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "t1",
          action: "admin.tenant.hard_deleted",
          entityType: "Tenant",
          entityId: "t1",
          metadata: expect.objectContaining({ reason: expect.stringMatching(/written request/i) }),
        }),
      }),
    );
    // Conditional on the club still being closed under this run's claim.
    expect(prisma.tenant.deleteMany).toHaveBeenCalledWith({
      where: { id: "t1", deletedAt: { not: null }, purgeStartedAt: NOW },
    });
    // Location RESTRICTs Tenant; the tenant delete fails unless it is emptied first.
    expect(vi.mocked(prisma.location.findMany)).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1" } }),
    );
  });

  it("a failing step throws to the operator — never reported as a clean erasure", async () => {
    vi.mocked(prisma.tenant.deleteMany).mockRejectedValueOnce(new Error("FK still referenced"));
    await expect(purgeTenantById("t1", NOW, () => false)).rejects.toThrow("FK still referenced");
  });
});

// ─── Kids-before-parents ordering (MAJOR-1) ──────────────────────────────────

describe("purgeTenantById — deletes kids before parents", () => {
  /**
   * `Member_kids_must_have_parent` (migration 20260515000001) is a validated,
   * non-deferrable CHECK — `accountType <> 'kids' OR parentMemberId IS NOT NULL`
   * — and Member.parentMemberId is ON DELETE SET NULL. Drop a parent while its
   * kid still exists and the RI SET NULL trips the CHECK, aborting the whole
   * transaction; the stall guard then throws and the gym never gets erased.
   */
  function tenantWithFamily() {
    const kidPages = [[{ id: "kid1" }], []];
    const parentPages = [[{ id: "parent1" }], []];
    vi.mocked(prisma.member.findMany).mockImplementation((async (args: {
      where: { stripeSubscriptionId?: unknown; parentMemberId?: unknown; AND?: Array<{ id?: { in: string[] } }> };
    }) => {
      if (args.where.stripeSubscriptionId) return []; // billing preflight
      // The guarded cascade transaction re-selects the batch it just read.
      if (args.where.AND) return (args.where.AND[1]?.id?.in ?? []).map((id) => ({ id }));
      if (args.where.parentMemberId) return kidPages.shift() ?? [];
      return parentPages.shift() ?? [];
    }) as never);
  }

  it("drains child rows first, then the parentless remainder", async () => {
    tenantWithFamily();

    const out = await purgeTenantById("t1", NOW, () => false);

    // The kid is handed to the cascade before the parent — this is the whole
    // point of the two-pass walk.
    expect(cascadeMock.mock.calls.map((c) => (c[1] as { id: string }).id)).toEqual([
      "kid1",
      "parent1",
    ]);
    expect(out).toMatchObject({ kind: "purged", membersDeleted: 2 });
    expect(prisma.tenant.deleteMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: "t1" }) }));
  });

  it("scopes the first pass to rows that have a parent link, batched at 10", async () => {
    tenantWithFamily();
    await purgeTenantById("t1", NOW, () => false);

    const wheres = vi
      .mocked(prisma.member.findMany)
      .mock.calls.map((c) => (c[0] as { where: unknown }).where);
    // [0] is the Stripe billing preflight; [1] opens the kids pass.
    expect(wheres[1]).toEqual({ tenantId: "t1", parentMemberId: { not: null } });
    expect(wheres).toContainEqual({ tenantId: "t1" });
    // MEMBER_BATCH: 10 members × ~10 cascade statements fits the transaction
    // budget where 25 did not (MINOR-2).
    expect(prisma.member.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true }, take: 10 }),
    );
  });
});

// ─── Fail-closed on live Stripe subscriptions (MED-3) ────────────────────────

describe("purgeTenantById — fail-closed on live billing", () => {
  /** One member on a live subscription. */
  const subscribed = () =>
    vi.mocked(prisma.member.findMany).mockImplementation((async (args: {
      where: { tenantId?: string; stripeSubscriptionId?: unknown };
    }) =>
      args.where.stripeSubscriptionId
        ? [{ id: "m1", name: "Ann", stripeSubscriptionId: "sub_1" }]
        : []) as never);

  it("a cancellation that fails blocks the erasure: the club is left intact, unclaimed and reopenable, and the reason is reported", async () => {
    subscribed();
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue(dueClub({ stripeAccountId: "acct_1" }) as never);
    cancelSubMock.mockResolvedValue({ ok: false, status: 500, error: "card network down" });

    const out = await purgeTenantById("t1", NOW, () => false);

    expect(out).toEqual({
      kind: "billing-blocked",
      reason: expect.stringContaining("card network down"),
      claimed: false,
      cancelledBeforeBlock: 0,
    });
    // No claim was stamped, so a reopen still succeeds; nothing was deleted.
    expect(prisma.tenant.updateMany).not.toHaveBeenCalled();
    expect(prisma.tenant.deleteMany).not.toHaveBeenCalled();
    expect(cascadeMock).not.toHaveBeenCalled();
  });

  it("subscriptions but no connected Stripe account: blocked without calling Stripe", async () => {
    subscribed();
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue(dueClub() as never);

    const out = await purgeTenantById("t1", NOW, () => false);

    expect(cancelSubMock).not.toHaveBeenCalled();
    expect(out).toMatchObject({ kind: "billing-blocked", reason: expect.stringContaining("no connected Stripe account"), claimed: false });
    expect(prisma.tenant.deleteMany).not.toHaveBeenCalled();
  });

  it("records successful cancellations in the erasure audit row", async () => {
    subscribed();
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue(dueClub({ stripeAccountId: "acct_1" }) as never);

    const out = await purgeTenantById("t1", NOW, () => false);

    expect(cancelSubMock).toHaveBeenCalledWith({
      tenant: { stripeAccountId: "acct_1" },
      stripeSubscriptionId: "sub_1",
    });
    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "t1",
          metadata: expect.objectContaining({ stripeSubscriptionsCancelled: 1 }),
        }),
      }),
    );
    expect(out).toMatchObject({ kind: "purged" });
  });
});

// ─── ImportJob diagnostics scrub (GDPR NEW-1) ────────────────────────────────

describe("GET /api/cron/retention — import diagnostics scrub", () => {
  /** The `where` the scrub rule's single updateMany ran with. */
  function scrubArgs() {
    const fn = prisma.importJob.updateMany as unknown as {
      mock: { calls: Array<[{ where: Record<string, unknown>; data: Record<string, unknown> }]> };
    };
    return fn.mock.calls[0]![0];
  }

  it("nulls dryRunSummary and errorLog on jobs older than 30 days", async () => {
    vi.mocked(prisma.importJob.updateMany).mockResolvedValue({ count: 3 } as never);

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { results: RuleResult[] };

    expect(prisma.importJob.updateMany).toHaveBeenCalledWith({
      where: {
        createdAt: { lt: new Date(NOW.getTime() - 30 * DAY_MS) },
        OR: [{ dryRunSummary: { not: Prisma.DbNull } }, { errorLog: { not: Prisma.DbNull } }],
      },
      // Both columns are Json? — plain null is a Prisma type error and
      // Prisma.JsonNull would store the JSON value `null`, not SQL NULL.
      data: { dryRunSummary: Prisma.DbNull, errorLog: Prisma.DbNull },
    });
    expect(body.results.find((r) => r.rule === "importJobDiagnostics")?.deleted).toBe(3);
  });

  it("applies to every status including `complete`, and keeps the row itself", async () => {
    await GET(req(`Bearer ${SECRET}`));
    const args = scrubArgs();

    // The `complete` exemption on rule f is what made this PII permanent, so
    // the scrub must not inherit any status filter.
    expect(args.where).not.toHaveProperty("status");
    // Only the two diagnostic columns are written — counters and the row stay.
    expect(Object.keys(args.data).sort()).toEqual(["dryRunSummary", "errorLog"]);
    expect(prisma.importJob.deleteMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: undefined }) }),
    );
  });

  it("leaves jobs inside the 30-day window alone", async () => {
    await GET(req(`Bearer ${SECRET}`));
    const cutoff = (scrubArgs().where.createdAt as { lt: Date }).lt;
    // A job imported 29 days ago sits above the cutoff and cannot match.
    const twentyNineDaysAgo = new Date(NOW.getTime() - 29 * DAY_MS);
    expect(twentyNineDaysAgo.getTime()).toBeGreaterThan(cutoff.getTime());
    expect(cutoff).toEqual(new Date(NOW.getTime() - 30 * DAY_MS));
  });
});

// ─── LoginEvent (review of lane I, 6 Oct 2026) ────────────────────────────────
// Sign-in records are now written on every sign-in (lib/login-event.ts), so
// they need a retention rule: a device not seen for twelve months is purged.

describe("rule loginEvent — devices not seen for twelve months", () => {
  it("deletes on lastSeenAt older than 365 days", async () => {
    vi.mocked(prisma.loginEvent.findMany).mockResolvedValueOnce([{ id: "le-1" }, { id: "le-2" }] as never);
    vi.mocked(prisma.loginEvent.deleteMany).mockResolvedValueOnce({ count: 2 } as never);
    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { results: RuleResult[] };
    expect(whereOf(prisma.loginEvent)).toEqual({ lastSeenAt: { lt: new Date(NOW.getTime() - 365 * DAY_MS) } });
    expect(prisma.loginEvent.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["le-1", "le-2"] } } });
    expect(body.results.find((r) => r.rule === "loginEvent")?.deleted).toBe(2);
  });

  it("dry run counts on the same window and deletes nothing", async () => {
    const count = vi.fn().mockResolvedValue(5);
    (prisma.loginEvent as unknown as { count: typeof count }).count = count;
    const res = await GET(new Request("https://matflow.studio/api/cron/retention?dryRun=1", { headers: { authorization: `Bearer ${SECRET}` } }));
    const body = (await res.json()) as { results: Array<RuleResult & { details?: Record<string, unknown> }> };
    expect(count).toHaveBeenCalledWith({ where: { lastSeenAt: { lt: new Date(NOW.getTime() - 365 * DAY_MS) } } });
    expect(body.results.find((r) => r.rule === "loginEvent")).toMatchObject({ deleted: 0, details: { wouldDelete: 5 } });
    expect(prisma.loginEvent.deleteMany).not.toHaveBeenCalled();
  });
});
