/**
 * The failure modes the 2 Oct real-data rehearsal did NOT exercise, pinned at
 * unit level against the real commit and rollback routes (3 Oct 2026, Total
 * BJJ handover; docs/readiness/REAL-DATA-RECONCILIATION.md, 3 Oct section).
 *
 * The rehearsal proved: kill mid-commit → 409 while the claim is live →
 * resume after the stale window without duplicates. It did not prove: a
 * double submit of a live run, a retry after a lost "complete" response, the
 * same file committed from a second job, the exact stale boundary, or that a
 * rollback after a partial failure leaves no child pointing at a deleted
 * parent. Same in-memory harness shape as import-commit-integrity.test.ts,
 * with a member store that honours `parentMemberId: { in }`.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  email: vi.fn(),
  files: new Map<string, string>(),
  failCreate: false,
  ledgerRows: 0,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: () => h.gate() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: (...a: unknown[]) => h.email(...a) }));
vi.mock("@/lib/member-status", () => ({ recordStatusEventsBulk: vi.fn(async () => {}) }));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({ status, json: async () => ({ error: message }) }),
}));
vi.mock("@/lib/import-storage", () => ({
  readImportFile: async (url: string) => h.files.get(url) ?? null,
  deleteImportFile: async () => {},
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) => fn(makeTx()),
}));

type Row = Record<string, unknown> & { id: string };
let db: { jobs: Row[]; members: Row[] };

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Record<string, unknown>[]).some((w) => matches(row, w));
    if (v === null) return (row[k] ?? null) === null;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const op = v as { not?: unknown; in?: unknown[]; notIn?: unknown[]; lt?: Date; gte?: Date; endsWith?: string };
      if ("not" in op) return op.not === null ? (row[k] ?? null) !== null : row[k] !== op.not;
      if ("in" in op) return op.in!.includes(row[k]);
      if ("notIn" in op) return !op.notIn!.includes(row[k]);
      if ("lt" in op) return row[k] != null && (row[k] as Date) < op.lt!;
      if ("gte" in op) return row[k] != null && (row[k] as Date) >= op.gte!;
      return true;
    }
    return (row[k] ?? null) === v;
  });
}

const ZERO_COUNTS = {
  memberRanks: 0, subscriptions: 0, waitlists: 0, signedWaivers: 0, payments: 0, classPacks: 0, orders: 0,
  loginEvents: 0, classRosters: 0, photos: 0, uploadedPhotos: 0, pushSubscriptions: 0, tasksAssigned: 0,
  creditedByMembers: 0, children: 0, attendances: 0,
};

function makeTx() {
  return {
    importJob: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => db.jobs.find((x) => matches(x, where)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => db.jobs.find((x) => x.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const j = db.jobs.find((x) => x.id === where.id)!;
        Object.assign(j, data);
        return j;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = db.jobs.filter((x) => matches(x, where));
        for (const x of hit) Object.assign(x, data);
        return { count: hit.length };
      },
    },
    membershipTier: { findMany: async () => [] },
    member: {
      // Honours every where key the commit and rollback use, so the rollback's
      // "children of these parents" read returns children, not everyone.
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        db.members
          .filter((m) => matches(m, Object.fromEntries(Object.entries(where).filter(([k]) => ["tenantId", "importJobId", "parentMemberId", "email", "id"].includes(k)))))
          .map((m) => ({ ...m, children: [], _count: { ...ZERO_COUNTS } })),
      createMany: async ({ data }: { data: Row[] }) => {
        if (h.failCreate) throw new Error("connection terminated");
        for (const d of data) db.members.push({ passwordHash: null, stripeCustomerId: null, parentMemberId: null, ...d, id: `m${db.members.length + 1}`, updatedAt: new Date(0) });
        return { count: data.length };
      },
      updateMany: async () => ({ count: 0 }),
      count: async ({ where }: { where: Record<string, unknown> }) => db.members.filter((m) => matches(m, where)).length,
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        // Postgres would refuse to delete a parent whose child still points at
        // it only if the FK were RESTRICT; it is SET NULL, so an orphan would
        // be silent. The test asserts the outcome, not the FK.
        const before = db.members.length;
        db.members = db.members.filter((m) => !where.id.in.includes(m.id));
        return { count: before - db.members.length };
      },
    },
    attendanceRecord: { deleteMany: async () => ({ count: 0 }), groupBy: async () => [] },
    memberStatusEvent: { groupBy: async () => [] },
    user: { findUnique: async () => ({ name: "Owner", email: "owner@example.test", tenant: { name: "Club" } }) },
    tenant: { findUnique: async () => ({ timezone: "Europe/London" }) },
    importedMembership: {
      createMany: async ({ data }: { data: unknown[] }) => { h.ledgerRows += data.length; return { count: data.length }; },
      count: async () => h.ledgerRows,
      deleteMany: async () => ({ count: 0 }),
    },
  };
}

const CSV = ["name,email", "Ada One,ada@example.test", "Ben Two,ben@example.test", "Cy Three,cy@example.test"].join("\n");
// The commit route's own rule: (maxDuration 300 + 60) seconds.
const STALE_RUN_MS = 360_000;

function seed() {
  h.files.clear();
  h.files.set("local-import://f0", CSV);
  db = {
    members: [],
    jobs: [{
      id: "job1", tenantId: "t1", source: "generic", mode: "create", status: "preview",
      fileBlobUrl: "local-import://f0", fileName: "people.csv", fileHash: "hash-1",
      sourceExportedAt: null, startedAt: null, completedAt: null, rolledBackAt: null, manifest: null,
    }],
  };
}

const req = () => ({ headers: new Headers(), json: async () => ({}) }) as unknown as Request;
const params = (id = "job1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.failCreate = false;
  h.ledgerRows = 0;
  h.gate.mockResolvedValue({ ok: true, tenantId: "t1", userId: "u1" });
  h.email.mockResolvedValue({ ok: true });
  seed();
});

describe("commit — double submit and lost response", () => {
  it("a second submit while the first run is live answers 409 'Job already running' and writes nothing", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/commit/route");
    const startedAt = new Date(Date.now() - 10_000);
    Object.assign(db.jobs[0], { status: "running", startedAt });
    const res = await POST(req(), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Job already running" });
    expect(db.members).toHaveLength(0);
    // The live run's claim is untouched.
    expect(db.jobs[0]).toMatchObject({ status: "running", startedAt });
  });

  it("a retry after the 'complete' response was lost answers 409 'Job already complete' and creates no second copy", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/commit/route");
    expect((await POST(req(), params())).status).toBe(200);
    expect(db.members).toHaveLength(3);
    const res = await POST(req(), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "Job already complete" });
    expect(db.members).toHaveLength(3);
  });
});

describe("commit — the same file from a second job", () => {
  it("is refused with 409 naming the earlier run while that run stands", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/commit/route");
    db.jobs.unshift({ ...db.jobs[0], id: "job0", status: "complete", completedAt: new Date() });
    const res = await POST(req(), params());
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ priorJobId: "job0" });
    expect(db.members).toHaveLength(0);
    expect(db.jobs.find((j) => j.id === "job1")!.status).toBe("preview");
  });

  it("is refused while the earlier run is still live (not yet stale)", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/commit/route");
    db.jobs.unshift({ ...db.jobs[0], id: "job0", status: "running", startedAt: new Date(Date.now() - 30_000) });
    expect((await POST(req(), params())).status).toBe(409);
    expect(db.members).toHaveLength(0);
  });

  it("is allowed once the earlier run has been rolled back", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/commit/route");
    db.jobs.unshift({ ...db.jobs[0], id: "job0", status: "complete", completedAt: new Date(), rolledBackAt: new Date() });
    expect((await POST(req(), params())).status).toBe(200);
    expect(db.members).toHaveLength(3);
  });
});

describe("commit — the stale-run boundary", () => {
  it("a run claimed just inside the stale window is still live: 409", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/commit/route");
    Object.assign(db.jobs[0], { status: "running", startedAt: new Date(Date.now() - (STALE_RUN_MS - 5_000)) });
    expect((await POST(req(), params())).status).toBe(409);
    expect(db.members).toHaveLength(0);
  });

  it("a run older than the stale window is reclaimed and finishes, without duplicating what it already wrote", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/commit/route");
    Object.assign(db.jobs[0], { status: "running", startedAt: new Date(Date.now() - (STALE_RUN_MS + 5_000)) });
    db.members.push({ id: "m_ada", tenantId: "t1", name: "Ada One", email: "ada@example.test", importJobId: "job1", parentMemberId: null, passwordHash: null, stripeCustomerId: null, updatedAt: new Date(0) });
    const res = await POST(req(), params());
    expect(res.status).toBe(200);
    expect(db.members.map((m) => m.email).sort()).toEqual(["ada@example.test", "ben@example.test", "cy@example.test"]);
    expect(db.jobs[0]).toMatchObject({ status: "complete", importedRows: 3 });
  });
});

describe("rollback after a partial failure leaves no orphan children", () => {
  const orphans = () => db.members.filter((m) => m.parentMemberId && !db.members.some((p) => p.id === m.parentMemberId));
  const member = (id: string, extra: Record<string, unknown> = {}): Row => ({
    id, tenantId: "t1", name: id, email: `${id}@example.test`, importJobId: "job1", parentMemberId: null,
    passwordHash: null, stripeCustomerId: null, updatedAt: new Date(0), ...extra,
  });
  const failedJob = () => Object.assign(db.jobs[0], { status: "failed", completedAt: new Date(1_000) });

  it("a failed run that created a parent and a child removes both", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/rollback/route");
    failedJob();
    db.members.push(member("parent"), member("child", { parentMemberId: "parent" }));
    expect((await POST(req(), params())).status).toBe(200);
    expect(db.members).toHaveLength(0);
  });

  it("a failed run whose child slice never landed removes the parent alone", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/rollback/route");
    failedJob();
    db.members.push(member("parent"));
    expect((await POST(req(), params())).status).toBe(200);
    expect(db.members).toHaveLength(0);
  });

  it("a child kept for a reason keeps its parent too", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/rollback/route");
    failedJob();
    db.members.push(member("parent"), member("child", { parentMemberId: "parent", passwordHash: "x" }), member("loner"));
    const res = await POST(req(), params());
    expect(res.status).toBe(200);
    expect(db.members.map((m) => m.id).sort()).toEqual(["child", "parent"]);
    expect(orphans()).toEqual([]);
  });

  it("a child the club already had, linked to an imported parent, keeps that parent", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/rollback/route");
    failedJob();
    db.members.push(member("parent"), member("own-child", { importJobId: null, parentMemberId: "parent" }));
    expect((await POST(req(), params())).status).toBe(200);
    expect(db.members.map((m) => m.id).sort()).toEqual(["own-child", "parent"]);
    expect(orphans()).toEqual([]);
  });
});
