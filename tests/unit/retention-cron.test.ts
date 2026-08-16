import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// Audit P0-4 / P1-6 / P2-2: the daily retention sweep. These tests pin the
// three things that make it safe to run unattended against production:
//   1. it is unreachable without CRON_SECRET,
//   2. every rule deletes on the window the privacy policy publishes,
//   3. one failing rule cannot take the others down with it.

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

const SECRET = "test-cron-secret";
const NOW = new Date("2026-08-16T03:30:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function req(auth?: string) {
  return new Request("https://matflow.studio/api/cron/retention", {
    headers: auth ? { authorization: auth } : {},
  });
}

type RuleResult = { rule: string; deleted?: number; error?: string; skipped?: boolean };

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
      "magicLinkToken",
      "passwordResetToken",
      "rateLimitHit",
      "stripeEvent",
      "importJob",
      "importJobDiagnostics",
      "tenantHardDelete",
    ]);
  });
});

// ─── Cutoff maths ─────────────────────────────────────────────────────────────

describe("GET /api/cron/retention — retention windows", () => {
  it("deletes AuditLog rows older than 365 days (privacy policy: twelve months)", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(whereOf(prisma.auditLog)).toEqual({
      createdAt: { lt: new Date(NOW.getTime() - 365 * DAY_MS) },
    });
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
    expect(prisma.tenant.findMany).toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});

// ─── ImportJob blob handling ──────────────────────────────────────────────────

describe("GET /api/cron/retention — abandoned import CSVs", () => {
  it("deletes only Vercel Blob URLs and still drops every row", async () => {
    vi.mocked(prisma.importJob.findMany)
      .mockResolvedValueOnce([
        { id: "j1", fileBlobUrl: "https://abc123.blob.vercel-storage.com/imports/a.csv" },
        { id: "j2", fileBlobUrl: "https://evil.example.com/imports/b.csv" },
        { id: "j3", fileBlobUrl: "" },
        { id: "j4", fileBlobUrl: "https://blob.vercel-storage.com/imports/d.csv" },
      ] as never)
      .mockResolvedValue([] as never);
    vi.mocked(prisma.importJob.deleteMany).mockResolvedValue({ count: 4 } as never);

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { results: RuleResult[] };

    expect(del).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledWith([
      "https://abc123.blob.vercel-storage.com/imports/a.csv",
      "https://blob.vercel-storage.com/imports/d.csv",
    ]);
    // The non-blob and empty URLs are skipped, but their rows still go.
    expect(prisma.importJob.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["j1", "j2", "j3", "j4"] } },
    });
    expect(body.results.find((r) => r.rule === "importJob")?.deleted).toBe(4);
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
        { id: "j1", fileBlobUrl: "https://abc.blob.vercel-storage.com/imports/a.csv" },
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

// ─── Tenant hard delete ───────────────────────────────────────────────────────

describe("GET /api/cron/retention — tenant hard delete", () => {
  it("only considers tenants soft-deleted more than 30 days ago, oldest first, max 2 per run", async () => {
    await GET(req(`Bearer ${SECRET}`));

    expect(prisma.tenant.findMany).toHaveBeenCalledWith({
      where: { deletedAt: { not: null, lt: new Date(NOW.getTime() - 30 * DAY_MS) } },
      select: { id: true, name: true, deletedAt: true, logoUrl: true },
      orderBy: { deletedAt: "asc" },
      take: 2,
    });
  });

  it("never touches a tenant that is inside the 30-day recovery window", async () => {
    // The route hands the window to Postgres, so the guarantee is the cutoff
    // itself: a tenant soft-deleted yesterday sits above it and cannot match.
    await GET(req(`Bearer ${SECRET}`));
    const where = whereOf(prisma.tenant) as { deletedAt: { lt: Date } };
    const softDeletedYesterday = new Date(NOW.getTime() - DAY_MS);
    expect(softDeletedYesterday.getTime()).toBeGreaterThan(where.deletedAt.lt.getTime());
  });

  it("writes the erasure-evidence audit row in the same transaction as the tenant delete", async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: "t1", name: "Closed Gym", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS), logoUrl: null },
    ] as never);

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { results: RuleResult[] };

    expect(prisma.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          tenantId: "t1",
          action: "admin.tenant.hard_deleted",
          entityType: "Tenant",
          entityId: "t1",
        }),
      }),
    );
    expect(prisma.tenant.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
    expect(body.results.find((r) => r.rule === "tenantHardDelete")?.deleted).toBe(1);
  });

  it("reports a failing tenant without aborting the rule", async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: "t1", name: "Gym A", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS), logoUrl: null },
      { id: "t2", name: "Gym B", deletedAt: new Date(NOW.getTime() - 35 * DAY_MS), logoUrl: null },
    ] as never);
    vi.mocked(prisma.tenant.delete)
      .mockRejectedValueOnce(new Error("FK still referenced"))
      .mockResolvedValue({} as never);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as {
      results: Array<RuleResult & { details?: { failures: Array<{ tenantId: string }> } }>;
    };

    const rule = body.results.find((r) => r.rule === "tenantHardDelete")!;
    expect(rule.deleted).toBe(1);
    expect(rule.details?.failures).toEqual([
      { tenantId: "t1", error: "FK still referenced" },
    ]);
    expect(prisma.tenant.delete).toHaveBeenCalledTimes(2);
    consoleError.mockRestore();
  });
});

// ─── Kids-before-parents ordering (MAJOR-1) ──────────────────────────────────

describe("GET /api/cron/retention — tenant purge deletes kids before parents", () => {
  /**
   * `Member_kids_must_have_parent` (migration 20260515000001) is a validated,
   * non-deferrable CHECK — `accountType <> 'kids' OR parentMemberId IS NOT NULL`
   * — and Member.parentMemberId is ON DELETE SET NULL. Drop a parent while its
   * kid still exists and the RI SET NULL trips the CHECK, aborting the whole
   * transaction; the stall guard then throws and the gym never gets erased.
   */
  function tenantWithFamily() {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: "t1", name: "Family Gym", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS), logoUrl: null },
    ] as never);
    const kidPages = [[{ id: "kid1" }], []];
    const parentPages = [[{ id: "parent1" }], []];
    vi.mocked(prisma.member.findMany).mockImplementation((async (args: {
      where: { stripeSubscriptionId?: unknown; parentMemberId?: unknown };
    }) => {
      if (args.where.stripeSubscriptionId) return []; // billing preflight
      if (args.where.parentMemberId) return kidPages.shift() ?? [];
      return parentPages.shift() ?? [];
    }) as never);
  }

  it("drains child rows first, then the parentless remainder", async () => {
    tenantWithFamily();

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { results: RuleResult[] };

    // The kid is handed to the cascade before the parent — this is the whole
    // point of the two-pass walk.
    expect(cascadeMock.mock.calls.map((c) => (c[1] as { id: string }).id)).toEqual([
      "kid1",
      "parent1",
    ]);
    expect(body.results.find((r) => r.rule === "tenantHardDelete")?.deleted).toBe(1);
    expect(prisma.tenant.delete).toHaveBeenCalledWith({ where: { id: "t1" } });
  });

  it("scopes the first pass to rows that have a parent link, batched at 10", async () => {
    tenantWithFamily();
    await GET(req(`Bearer ${SECRET}`));

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

describe("GET /api/cron/retention — tenant purge is fail-closed on live billing", () => {
  const twoTenants = () =>
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: "t1", name: "Gym A", deletedAt: new Date(NOW.getTime() - 40 * DAY_MS), logoUrl: null },
      { id: "t2", name: "Gym B", deletedAt: new Date(NOW.getTime() - 35 * DAY_MS), logoUrl: null },
    ] as never);

  /** Only t1 has a member on a live subscription. */
  const onlyT1Subscribed = () =>
    vi.mocked(prisma.member.findMany).mockImplementation((async (args: {
      where: { tenantId?: string; stripeSubscriptionId?: unknown };
    }) =>
      args.where.stripeSubscriptionId && args.where.tenantId === "t1"
        ? [{ id: "m1", name: "Ann", stripeSubscriptionId: "sub_1" }]
        : []) as never);

  it("skips the tenant whose cancellation fails, reports it, and purges the next one", async () => {
    twoTenants();
    onlyT1Subscribed();
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ stripeAccountId: "acct_1" } as never);
    cancelSubMock.mockResolvedValue({ ok: false, status: 500, error: "card network down" });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as {
      results: Array<RuleResult & { details?: { failures: Array<Record<string, string>> } }>;
    };

    const rule = body.results.find((r) => r.rule === "tenantHardDelete")!;
    expect(rule.details?.failures).toEqual([
      { tenantId: "t1", reason: expect.stringContaining("card network down") },
    ]);
    // t1's rows survive for the operator; t2 is unaffected by its neighbour.
    expect(prisma.tenant.delete).toHaveBeenCalledTimes(1);
    expect(prisma.tenant.delete).toHaveBeenCalledWith({ where: { id: "t2" } });
    expect(rule.deleted).toBe(1);
    consoleError.mockRestore();
  });

  it("skips a tenant that has subscriptions but no connected Stripe account", async () => {
    twoTenants();
    onlyT1Subscribed();
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ stripeAccountId: null } as never);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as {
      results: Array<RuleResult & { details?: { failures: Array<Record<string, string>> } }>;
    };

    const rule = body.results.find((r) => r.rule === "tenantHardDelete")!;
    expect(cancelSubMock).not.toHaveBeenCalled();
    expect(rule.details?.failures).toEqual([
      { tenantId: "t1", reason: expect.stringContaining("no connected Stripe account") },
    ]);
    expect(prisma.tenant.delete).toHaveBeenCalledTimes(1);
    expect(prisma.tenant.delete).toHaveBeenCalledWith({ where: { id: "t2" } });
    consoleError.mockRestore();
  });

  it("records successful cancellations in the erasure audit row", async () => {
    twoTenants();
    onlyT1Subscribed();
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ stripeAccountId: "acct_1" } as never);

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { results: RuleResult[] };

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
    expect(body.results.find((r) => r.rule === "tenantHardDelete")?.deleted).toBe(2);
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
