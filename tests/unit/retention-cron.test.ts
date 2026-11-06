import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

// The daily retention cron. Product rule (Noe, 6 Nov 2026; docs/RULES.md):
// nothing of a club's is deleted automatically. These tests pin:
//   1. it is unreachable without CRON_SECRET,
//   2. its ONLY deletion is sign-in rate-limit counters, and a live run with
//      the gate on touches no other table (Activity, email logs, sign-in
//      records, expired links, Stripe events, imports, clubs),
//   3. a failing rule surfaces as a 500.
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
    mat: emptyModel(),
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

import { del } from "@vercel/blob";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/cron/retention/route";
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
    expect(prisma.rateLimitHit.findMany).not.toHaveBeenCalled();
  });

  it("401s with no Authorization header", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(prisma.rateLimitHit.findMany).not.toHaveBeenCalled();
  });

  it("401s with the wrong bearer token", async () => {
    const res = await GET(req("Bearer wrong-secret"));
    expect(res.status).toBe(401);
    expect(prisma.rateLimitHit.findMany).not.toHaveBeenCalled();
  });

  it("runs with the correct bearer token, and its only rule is the rate-limit counters", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; results: RuleResult[] };
    expect(body.ok).toBe(true);
    // Product rule (Noe, 6 Nov 2026): nothing of a club's is deleted automatically.
    expect(body.results.map((r) => r.rule)).toEqual(["rateLimitHit"]);
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });
});

// ─── Nothing of a club's is ever deleted ─────────────────────────────────────
// Product rule (Noe, 6 Nov 2026; docs/RULES.md): "nothing should be
// automatically deleted" and "all data from the entirety of the club should be
// held". Every model the sweep used to purge is offered rows of every age — a
// day, a year, two years and ten years old — and the live sweep, with the gate
// ON, must not delete, update or even count any of them.

const KEPT_MODELS = [
  "auditLog",
  "emailLog",
  "loginEvent",
  "magicLinkToken",
  "passwordResetToken",
  "stripeEvent",
  "importUpload",
  "importJob",
  "tenant",
] as const;

describe("GET /api/cron/retention — keeps every club record", () => {
  const AGES_DAYS = [1, 365, 400, 730, 3650];

  function offerRowsOfEveryAge() {
    const counts: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const name of KEPT_MODELS) {
      const model = (prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn>>>)[name];
      model.findMany.mockResolvedValue(AGES_DAYS.map((d) => ({ id: `${name}-${d}d`, tenantId: "t1", createdAt: new Date(NOW.getTime() - d * DAY_MS) })));
      counts[name] = vi.fn().mockResolvedValue(AGES_DAYS.length);
      (model as unknown as { count: ReturnType<typeof vi.fn> }).count = counts[name];
    }
    return counts;
  }

  function expectUntouched(counts: Record<string, ReturnType<typeof vi.fn>>) {
    for (const name of KEPT_MODELS) {
      const model = (prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn> | undefined>>)[name];
      expect(model.findMany, `${name}.findMany`).not.toHaveBeenCalled();
      expect(model.deleteMany, `${name}.deleteMany`).not.toHaveBeenCalled();
      expect(model.updateMany, `${name}.updateMany`).not.toHaveBeenCalled();
      expect(model.delete ?? vi.fn(), `${name}.delete`).not.toHaveBeenCalled();
      expect(counts[name], `${name}.count`).not.toHaveBeenCalled();
    }
    // Nor a member, a photo, a waiver, a file, a Stripe subscription or a member cascade.
    for (const [name, model] of Object.entries(prisma as unknown as Record<string, Record<string, ReturnType<typeof vi.fn> | undefined>>)) {
      if (name === "rateLimitHit") continue;
      expect(model.deleteMany ?? vi.fn(), `${name}.deleteMany`).not.toHaveBeenCalled();
      expect(model.updateMany ?? vi.fn(), `${name}.updateMany`).not.toHaveBeenCalled();
      expect(model.delete ?? vi.fn(), `${name}.delete`).not.toHaveBeenCalled();
    }
    expect(cascadeMock).not.toHaveBeenCalled();
    expect(cancelSubMock).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  }

  it("a live run with RETENTION_CRON_ENABLED=true deletes nothing except rate-limit hits", async () => {
    expect(process.env.RETENTION_CRON_ENABLED).toBe("true");
    const counts = offerRowsOfEveryAge();
    vi.mocked(prisma.rateLimitHit.findMany).mockResolvedValueOnce([{ id: "hit-old" }] as never);
    vi.mocked(prisma.rateLimitHit.deleteMany).mockResolvedValueOnce({ count: 1 } as never);

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { ok: boolean; dryRun: boolean; results: RuleResult[] };
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, dryRun: false });
    expect(body.results).toEqual([{ rule: "rateLimitHit", deleted: 1 }]);
    expect(prisma.rateLimitHit.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["hit-old"] } } });
    expectUntouched(counts);
  });

  it("a dry run reports zero for every kept table: none of them is even counted", async () => {
    const counts = offerRowsOfEveryAge();
    (prisma.rateLimitHit as unknown as { count: ReturnType<typeof vi.fn> }).count = vi.fn().mockResolvedValue(4);

    const res = await GET(new Request("https://matflow.studio/api/cron/retention?dryRun=1", { headers: { authorization: `Bearer ${SECRET}` } }));
    const body = (await res.json()) as { ok: boolean; dryRun: boolean; results: Array<RuleResult & { details?: Record<string, unknown> }> };
    expect(body).toMatchObject({ ok: true, dryRun: true });
    const reported = Object.fromEntries(body.results.map((r) => [r.rule, (r.details?.wouldDelete as number | undefined) ?? 0]));
    for (const name of KEPT_MODELS) expect(reported[name] ?? 0, name).toBe(0);
    expect(reported.rateLimitHit).toBe(4);
    expect(prisma.rateLimitHit.deleteMany).not.toHaveBeenCalled();
    expectUntouched(counts);
  });
});

// ─── Dry run ──────────────────────────────────────────────────────────────────

describe("GET /api/cron/retention?dryRun=1 — counts, never deletes", () => {
  function dryReq(auth?: string) {
    return new Request("https://matflow.studio/api/cron/retention?dryRun=1", {
      headers: auth ? { authorization: auth } : {},
    });
  }

  it("still needs the bearer", async () => {
    expect((await GET(dryReq())).status).toBe(401);
    expect((await GET(dryReq("Bearer wrong"))).status).toBe(401);
  });

  it("counts on the same window the live rule deletes on", async () => {
    const count = vi.fn().mockResolvedValue(7);
    (prisma.rateLimitHit as unknown as { count: typeof count }).count = count;
    const res = await GET(dryReq(`Bearer ${SECRET}`));
    const body = (await res.json()) as { results: Array<RuleResult & { details?: Record<string, unknown> }> };
    expect(body.results).toEqual([{ rule: "rateLimitHit", deleted: 0, details: { wouldDelete: 7 } }]);
    expect(count).toHaveBeenCalledWith({ where: { hitAt: { lt: new Date(NOW.getTime() - DAY_MS) } } });
    expect(prisma.rateLimitHit.deleteMany).not.toHaveBeenCalled();
  });
});

// ─── The one rule left ────────────────────────────────────────────────────────

describe("GET /api/cron/retention — rate-limit counters", () => {
  it("deletes RateLimitHit rows older than 24 hours, keyed on hitAt", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(whereOf(prisma.rateLimitHit)).toEqual({
      hitAt: { lt: new Date(NOW.getTime() - DAY_MS) },
    });
  });

  it("batches deletes by id so a timeout cannot leave poison state", async () => {
    vi.mocked(prisma.rateLimitHit.findMany)
      .mockResolvedValueOnce([{ id: "h1" }, { id: "h2" }] as never)
      .mockResolvedValue([] as never);
    vi.mocked(prisma.rateLimitHit.deleteMany).mockResolvedValue({ count: 2 } as never);

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { results: RuleResult[] };

    expect(prisma.rateLimitHit.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ select: { id: true }, take: 1000 }),
    );
    expect(prisma.rateLimitHit.deleteMany).toHaveBeenCalledWith({
      where: { id: { in: ["h1", "h2"] } },
    });
    expect(body.results.find((r) => r.rule === "rateLimitHit")?.deleted).toBe(2);
  });

  it("reports a deadline-truncated run as partial, not as a failure", async () => {
    // A full page whose fetch burns past the 240s budget: the rule commits what
    // it deleted and reports { partial, processed }; tomorrow's run resumes.
    const page = Array.from({ length: 1000 }, (_, i) => ({ id: `h${i}` }));
    vi.mocked(prisma.rateLimitHit.findMany).mockImplementation((async () => {
      vi.advanceTimersByTime(241_000);
      return page;
    }) as never);
    vi.mocked(prisma.rateLimitHit.deleteMany).mockResolvedValue({ count: 1000 } as never);

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { ok: boolean; results: RuleResult[] };

    const rule = body.results.find((r) => r.rule === "rateLimitHit")!;
    expect(rule).toMatchObject({ deleted: 1000, partial: true, processed: 1000 });
    expect(rule.error).toBeUndefined();
    expect(body.ok).toBe(true);
  });

  it("a failing rule surfaces as 500 with its error", async () => {
    vi.mocked(prisma.rateLimitHit.findMany).mockRejectedValue(new Error("connection reset"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as { ok: boolean; results: RuleResult[] };

    // Hardening 2026-08-16: failed sweeps must surface as 500 so status-code
    // monitoring (Vercel cron dashboard) can see them.
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.results).toEqual([{ rule: "rateLimitHit", error: "connection reset" }]);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
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
