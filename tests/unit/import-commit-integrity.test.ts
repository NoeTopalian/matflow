/**
 * Member import commit and rollback integrity — connection register gaps 12,
 * 13 and 15 (30 Sep 2026). Against the real routes over a small in-memory
 * database:
 *   - 13: a commit that loses the claim to another tab writes nothing (409);
 *   - 12: a run whose slice failed on a system error ends "failed", answers in
 *     words, sends no completion email, and can then be rolled back;
 *   - 15: the rollback records its outcome in the same transaction as the
 *     deletions, so a failure never follows "removed" with "nothing removed".
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  email: vi.fn(),
  files: new Map<string, string>(),
  txCalls: 0,
  failCreate: false,
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
  apiError: (message: string, status: number, e?: unknown) => { if (e && process.env.SHOW_ERR) console.log("APIERR", e); return { status, json: async () => ({ error: message }) }; },
}));
vi.mock("@/lib/import-storage", () => ({
  readImportFile: async (url: string) => h.files.get(url) ?? null,
  deleteImportFile: async () => {},
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) => {
    h.txCalls += 1;
    return fn(makeTx());
  },
}));

type Row = Record<string, unknown> & { id: string };
let db: { jobs: Row[]; members: Row[]; raceOnRead: string | null; rivalStartsOnRead?: { read: string; rival: string } | null };

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Record<string, unknown>[]).some((w) => matches(row, w));
    if (v === null) return (row[k] ?? null) === null;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const op = v as { not?: unknown; in?: unknown[]; notIn?: unknown[]; lt?: Date; gte?: Date };
      if ("not" in op) return row[k] !== op.not;
      if ("in" in op) return op.in!.includes(row[k]);
      if ("notIn" in op) return !op.notIn!.includes(row[k]);
      if ("lt" in op) return row[k] != null && (row[k] as Date) < op.lt!;
      if ("gte" in op) return row[k] != null && (row[k] as Date) >= op.gte!;
      return true;
    }
    return (row[k] ?? null) === v;
  });
}

function makeTx() {
  return {
    importJob: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const j = db.jobs.find((x) => matches(x, where)) ?? null;
        if (j && db.raceOnRead === j.id) {
          // Another tab claims this job the moment after it is read.
          const snapshot = { ...j };
          Object.assign(j, { status: "running", startedAt: new Date() });
          db.raceOnRead = null;
          return snapshot;
        }
        return j;
      },
      findUnique: async ({ where }: { where: { id: string } }) => db.jobs.find((x) => x.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const j = db.jobs.find((x) => x.id === where.id)!;
        Object.assign(j, data);
        return j;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = db.jobs.filter((x) => matches(x, where));
        for (const x of hit) Object.assign(x, data);
        // A rival run of the same file claims its own job in the same instant
        // as this one claims — after this one's "already imported" check.
        if (hit.some((x) => x.id === db.rivalStartsOnRead?.read)) {
          Object.assign(db.jobs.find((x) => x.id === db.rivalStartsOnRead!.rival)!, { status: "running", startedAt: new Date() });
          db.rivalStartsOnRead = null;
        }
        return { count: hit.length };
      },
    },
    membershipTier: { findMany: async () => [] },
    member: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        db.members.filter((m) => matches(m, Object.fromEntries(Object.entries(where).filter(([k]) => k === "tenantId" || k === "importJobId")))).map((m) => ({ ...m, _count: { attendances: 0, payments: 0, signedWaivers: 0 } })),
      createMany: async ({ data }: { data: Row[] }) => {
        if (h.failCreate) throw new Error("connection terminated");
        for (const d of data) db.members.push({ passwordHash: null, stripeCustomerId: null, parentMemberId: null, ...d, id: `m${db.members.length + 1}`, updatedAt: new Date() });
        return { count: data.length };
      },
      updateMany: async () => ({ count: 0 }),
      count: async ({ where }: { where: Record<string, unknown> }) => db.members.filter((m) => matches(m, where)).length,
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        const before = db.members.length;
        db.members = db.members.filter((m) => !where.id.in.includes(m.id));
        return { count: before - db.members.length };
      },
    },
    attendanceRecord: { deleteMany: async () => ({ count: 0 }), groupBy: async () => [] },
    memberStatusEvent: { groupBy: async () => [] },
    user: { findUnique: async () => ({ name: "Owner", email: "owner@example.test", tenant: { name: "Club" } }) },
    // teamup-2: the commit reads the club timezone for the as-of date and
    // writes the per-row ledger (ImportedMembership); a generic CSV has no
    // ledger rows, so these are inert here but must exist on the fake.
    tenant: { findUnique: async () => ({ timezone: "Europe/London" }) },
    importedMembership: { createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }), count: async () => 0 },
  };
}

const CSV = ["name,email", "Ada One,ada@example.test", "Ben Two,ben@example.test", "Cy Three,cy@example.test"].join("\n");

function seed() {
  h.files.clear();
  h.files.set("local-import://f0", CSV);
  db = {
    raceOnRead: null,
    members: [],
    jobs: [{
      id: "job1", tenantId: "t1", source: "generic", mode: "create", status: "preview",
      fileBlobUrl: "local-import://f0", fileName: "people.csv", fileHash: "hash-1",
      sourceExportedAt: null, startedAt: null, completedAt: null, rolledBackAt: null, manifest: null,
    }],
  };
}

const req = () => ({ headers: new Headers(), json: async () => ({}) }) as unknown as Request;
const params = { params: Promise.resolve({ id: "job1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  h.txCalls = 0;
  h.failCreate = false;
  h.gate.mockResolvedValue({ ok: true, tenantId: "t1", userId: "u1" });
  h.email.mockResolvedValue({ ok: true });
  seed();
});

describe("member import commit", () => {
  it("imports the file and says so (control)", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/commit/route");
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    expect(db.members).toHaveLength(3);
    expect(db.jobs[0].status).toBe("complete");
  });

  it("a commit that loses the claim to another tab writes nothing and answers 409 (gap 13)", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/commit/route");
    db.raceOnRead = "job1";
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    expect(db.members).toHaveLength(0);
  });

  it("a run whose slice failed on a system error ends failed, answers in words and sends no completion email (gap 12)", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/commit/route");
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.failCreate = true;
    const res = await POST(req(), params);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/couldn't be saved because of a system error/);
    expect(body.error).toMatch(/Run the import again/);
    expect(db.jobs[0].status).toBe("failed");
    expect(h.email).not.toHaveBeenCalled();
  });
});

describe("member import commit — functional review F6 and F2 (30 Sep 2026)", () => {
  it("of two runs of one file claimed at once, the newer gives its claim back and answers 409", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/commit/route");
    // Two uploads of one file, both previewed: when this request reads its job
    // the other is still idle, and it claims its own job straight after.
    db.jobs.unshift({ ...db.jobs[0], id: "job0", status: "preview", startedAt: null });
    db.rivalStartsOnRead = { read: "job1", rival: "job0" };
    const res = await POST(req(), params);
    expect(res.status).toBe(409);
    expect(db.members).toHaveLength(0);
    expect(db.jobs.find((j) => j.id === "job1")!.status).toBe("preview");
  });

  it("a resumed run does not count its own earlier rows as skipped, and reconciles", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/commit/route");
    // The run stopped after creating Ada; it is stale, so it may be re-run.
    Object.assign(db.jobs[0], { status: "running", startedAt: new Date(Date.now() - 60 * 60 * 1000) });
    db.members.push({ id: "m_ada", tenantId: "t1", name: "Ada One", email: "ada@example.test", importJobId: "job1", updatedAt: new Date() });
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { skipped: number; manifest: { reconciles: boolean } };
    expect(body.skipped).toBe(0);
    expect(body.manifest.reconciles).toBe(true);
    expect(db.members).toHaveLength(3);
  });
});

describe("member import rollback", () => {
  it("records its outcome in the same transaction as the deletions (gap 15), and accepts a failed run (gap 12)", async () => {
    const { POST: commit } = await import("@/app/api/admin/import/[id]/commit/route");
    const { POST: rollback } = await import("@/app/api/admin/import/[id]/rollback/route");
    await commit(req(), params);
    // Pretend the run had failed after creating these people.
    Object.assign(db.jobs[0], { status: "failed" });
    const before = h.txCalls;
    const res = await rollback(req(), params);
    expect(res.status).toBe(200);
    expect(db.members).toHaveLength(0);
    expect(db.jobs[0].rolledBackAt).toBeInstanceOf(Date);
    expect((db.jobs[0].manifest as { rollback: { removed: number } }).rollback.removed).toBe(3);
    // The job read, then one transaction for deletions + outcome.
    expect(h.txCalls - before).toBeLessThanOrEqual(2);
  });
});
