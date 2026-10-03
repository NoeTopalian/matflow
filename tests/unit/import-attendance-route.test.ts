/**
 * The attendance-history import route (app/api/admin/import/attendance):
 * owner only, CSRF-guarded, preview → commit → rollback. An import writes
 * history with plain inserts — `checkInMethod: "import"`, skip-on-conflict so a
 * live check-in wins, never through lib/checkin.ts — and its manifest must
 * reconcile every input row. Rollback removes by `importJobId` only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

// ── Mocks ────────────────────────────────────────────────────────────────────

const gateMock = vi.fn();
const csrfMock = vi.fn();
const auditMock = vi.fn();
const checkinTouched = vi.fn();
const files = new Map<string, string>();

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: () => gateMock() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: (req: Request) => csrfMock(req) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: (...a: unknown[]) => auditMock(...a) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number, e?: unknown) => {
    if (e) console.error(e);
    return { status, json: async () => ({ error: message }) };
  },
}));
vi.mock("@/lib/checkin", () => {
  checkinTouched();
  return {};
});
vi.mock("@/lib/import-storage", () => ({
  importStorageAvailable: () => true,
  sha256: (b: Uint8Array) => `hash-${b.length}-${Buffer.from(b).toString("base64").slice(0, 16)}`,
  putImportFile: async (_t: string, b: Uint8Array) => {
    const url = `local-import://f${files.size}`;
    files.set(url, new TextDecoder().decode(b));
    return url;
  },
  readImportFile: async (url: string) => files.get(url) ?? null,
  deleteImportFile: async (url: string) => { files.delete(url); },
}));

// ── A small in-memory database ───────────────────────────────────────────────

type Job = Record<string, unknown> & { id: string };
type Instance = { id: string; classId: string; date: Date; startTime: string; endTime: string };
type Attendance = { id: string; tenantId: string; memberId: string; classInstanceId: string; checkInTime: Date; checkInMethod: string; importJobId: string | null; sourceRowId: string | null };

let db: { jobs: Job[]; instances: Instance[]; attendance: Attendance[]; raceOnRead?: string | null };
// The club's timezone as the tenant row holds it; reset to London per test.
let tenantTimezone = "Europe/London";
const attendanceCreateMany = vi.fn();
const attendanceDeleteMany = vi.fn();

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  // HARNESS FIX (30 Sep 2026): the import routes now claim a run with a
  // conditional updateMany (OR, notIn, gte, lt, null — connection register
  // gaps 13 and 14). The fake follows Prisma's meaning for each; no assertion
  // in this file changed.
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
      return true; // relation filters (class: { tenantId }) — one tenant in this fake
    }
    if (v instanceof Date) return (row[k] as Date)?.getTime?.() === v.getTime();
    return (row[k] ?? null) === v;
  });
}

function makeTx() {
  return {
    tenant: { findUnique: async () => ({ timezone: tenantTimezone }) },
    member: {
      findMany: async () => [
        { id: "m1", name: "Alice Smith", email: "alice@example.com", externalRef: null },
        { id: "m2", name: "Bob Jones", email: "bob@example.com", externalRef: "c-2" },
        { id: "k1", name: "Kid Smith", email: "kid-abc@no-login.matflow.local", externalRef: null },
      ],
    },
    class: { findMany: async () => [{ id: "c1", name: "Fundamentals", duration: 60 }] },
    importJob: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const j = db.jobs.find((x) => matches(x as unknown as Record<string, unknown>, where)) ?? null;
        // Race hook: another tab claims this job the moment after it is read.
        if (j && db.raceOnRead === j.id) {
          const snapshot = { ...j };
          Object.assign(j, { status: "running", startedAt: new Date() });
          db.raceOnRead = null;
          return snapshot;
        }
        return j;
      },
      // Other attendance jobs, read by the rollback to find sessions an earlier import created.
      findMany: async () => db.jobs,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const job = { id: `job${db.jobs.length + 1}`, rolledBackAt: null, startedAt: null, completedAt: null, manifest: null, ...data } as Job;
        db.jobs.push(job);
        return job;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const job = db.jobs.find((j) => j.id === where.id)!;
        Object.assign(job, data);
        return job;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = db.jobs.filter((j) => matches(j as unknown as Record<string, unknown>, where));
        for (const j of hit) Object.assign(j, data);
        return { count: hit.length };
      },
    },
    classInstance: {
      findMany: async ({ where }: { where: Record<string, unknown> & { OR?: Record<string, unknown>[] } }) => {
        const { OR, ...rest } = where;
        return db.instances
          .filter((i) => matches(i, rest) && (!OR || OR.some((o) => matches(i, o))))
          .map((i) => ({
            ...i,
            _count: {
              attendances: db.attendance.filter((a) => a.classInstanceId === i.id).length,
              waitlists: 0,
            },
          }));
      },
      createMany: async ({ data }: { data: Omit<Instance, "id">[] }) => {
        let count = 0;
        for (const d of data) {
          if (db.instances.some((i) => i.classId === d.classId && i.date.getTime() === d.date.getTime() && i.startTime === d.startTime)) continue;
          db.instances.push({ id: `inst${db.instances.length + 1}`, ...d });
          count += 1;
        }
        return { count };
      },
      deleteMany: async ({ where }: { where: Record<string, unknown> }) => {
        const before = db.instances.length;
        db.instances = db.instances.filter((i) => !matches(i, where));
        return { count: before - db.instances.length };
      },
    },
    attendanceRecord: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        db.attendance
          .filter((a) => matches(a, where))
          .map((a) => ({ ...a, classInstance: db.instances.find((i) => i.id === a.classInstanceId)! })),
      createMany: async (args: { data: Omit<Attendance, "id">[]; skipDuplicates?: boolean }) => {
        attendanceCreateMany(args);
        let count = 0;
        for (const d of args.data) {
          if (db.attendance.some((a) => a.memberId === d.memberId && a.classInstanceId === d.classInstanceId)) {
            if (!args.skipDuplicates) throw new Error("unique violation");
            continue;
          }
          db.attendance.push({ id: `att${db.attendance.length + 1}`, ...d });
          count += 1;
        }
        return { count };
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        attendanceDeleteMany(args);
        const before = db.attendance.length;
        db.attendance = db.attendance.filter((a) => !matches(a, args.where));
        return { count: before - db.attendance.length };
      },
    },
  };
}

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_tenantId: string, fn: (tx: unknown) => unknown) => fn(makeTx()),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CSV = [
  "Attendance ID,Customer ID,Customer Email,Customer Name,Event Name,Start Date,Start Time,Status",
  "a1,,alice@example.com,Alice Smith,Fundamentals,2026-09-01,18:00,Attended", // created (existing session)
  "a2,c-2,bob@example.com,Bob Jones,Fundamentals,2026-09-01,18:00,Attended", // live check-in already there
  "a3,,alice@example.com,Alice Smith,Fundamentals,2026-09-08,18:00,Cancelled", // excluded
  "a4,,nobody@example.com,Nobody,Fundamentals,2026-09-08,18:00,Attended", // unresolved person
  "a5,,alice@example.com,Alice Smith,Fundamentals,2099-01-01,18:00,Attended", // future session
  "a6,,alice@example.com,Alice Smith,Mystery Class,2026-09-01,18:00,Attended", // unknown class
  "a7,,alice@example.com,Alice Smith,Fundamentals,2026-09-15,18:00,Attended", // created (new session)
  "a8,,kid-abc@no-login.matflow.local,Kid Smith,Fundamentals,2026-09-15,18:00,Attended", // synthesised email never matched
].join("\n");

const URL_BASE = "http://localhost/api/admin/import/attendance";

async function route() {
  return import("@/app/api/admin/import/attendance/route");
}

function form(fields: Record<string, string | File>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  return fd;
}

async function preview(csv = CSV, extra: Record<string, string> = {}) {
  const { POST } = await route();
  const file = new File([csv], "attendance.csv", { type: "text/csv" });
  return POST(new Request(URL_BASE, { method: "POST", body: form({ mode: "preview", file, ...extra }) }));
}

async function commit(jobId: string) {
  const { POST } = await route();
  return POST(new Request(URL_BASE, { method: "POST", body: form({ mode: "commit", jobId }) }));
}

async function rollback(jobId: string) {
  const { DELETE } = await route();
  return DELETE(new Request(`${URL_BASE}?jobId=${jobId}`, { method: "DELETE" }));
}

beforeEach(() => {
  vi.clearAllMocks();
  files.clear();
  gateMock.mockResolvedValue({ ok: true, tenantId: "t1", userId: "u1", role: "owner" });
  csrfMock.mockReturnValue(null);
  tenantTimezone = "Europe/London";
  // A session that already exists (made by the cron) with a live check-in on it.
  const existing: Instance = { id: "inst0", classId: "c1", date: new Date("2026-09-01T00:00:00Z"), startTime: "18:00", endTime: "19:00" };
  db = {
    jobs: [],
    instances: [existing],
    attendance: [{ id: "live1", tenantId: "t1", memberId: "m2", classInstanceId: "inst0", checkInTime: new Date("2026-09-01T17:05:00Z"), checkInMethod: "kiosk", importJobId: null, sourceRowId: null }],
  };
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe("POST /api/admin/import/attendance — gates", () => {
  it("is owner only", async () => {
    gateMock.mockResolvedValue({ ok: false, response: { status: 403, json: async () => ({ error: "forbidden" }) } });
    expect((await preview()).status).toBe(403);
    expect((await rollback("job1")).status).toBe(403);
    expect(db.jobs).toHaveLength(0);
  });

  it("refuses a cross-origin request before anything else", async () => {
    csrfMock.mockReturnValue({ status: 403, json: async () => ({ error: "Cross-origin request refused" }) });
    expect((await preview()).status).toBe(403);
    expect((await rollback("job1")).status).toBe(403);
    expect(gateMock).not.toHaveBeenCalled();
  });

  it("refuses an export date in the future", async () => {
    const res = await preview(CSV, { sourceExportedAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/not in the future/);
    expect(db.jobs).toHaveLength(0);
  });

  it("refuses a file already committed and not rolled back, naming the prior job", async () => {
    const first = await preview();
    const { jobId } = await first.json();
    expect((await commit(jobId)).status).toBe(200);
    const again = await preview();
    expect(again.status).toBe(409);
    expect((await again.json()).priorJobId).toBe(jobId);
  });
});

// ── Export time in club time (3 Oct 2026) ──────────────────────────────────
//
// The panel sends the datetime-local value the owner typed. The route reads it
// in the CLUB's timezone with the member upload's helper, never the laptop's,
// and still takes an ISO instant from API callers.

describe("POST /api/admin/import/attendance — export time in club time", () => {
  async function exportedAt(extra: Record<string, string>) {
    const res = await preview(CSV, extra);
    expect(res.status).toBe(201);
    const { jobId } = await res.json();
    return db.jobs.find((j) => j.id === jobId)!;
  }

  it("reads a BST wall-clock time in London as UTC+1", async () => {
    const job = await exportedAt({ sourceExportedAtLocal: "2026-03-29T09:00" });
    expect((job.sourceExportedAt as Date).toISOString()).toBe("2026-03-29T08:00:00.000Z");
    expect(job.sourceExportedAtProvenance).toBe("owner_stated");
  });

  it("reads a GMT wall-clock time the same night, before the clocks went forward, as UTC+0", async () => {
    const job = await exportedAt({ sourceExportedAtLocal: "2026-03-29T00:30" });
    expect((job.sourceExportedAt as Date).toISOString()).toBe("2026-03-29T00:30:00.000Z");
  });

  it("keeps the club date across the October changeover: 00:30 on 26 Oct 2025 (still BST) is 23:30Z on the 25th", async () => {
    const job = await exportedAt({ sourceExportedAtLocal: "2025-10-26T00:30" });
    expect((job.sourceExportedAt as Date).toISOString()).toBe("2025-10-25T23:30:00.000Z");
  });

  it("uses the tenant's timezone, not London and not the machine's", async () => {
    tenantTimezone = "Asia/Makassar"; // UTC+8, no daylight saving
    const job = await exportedAt({ sourceExportedAtLocal: "2026-09-02T09:30" });
    expect((job.sourceExportedAt as Date).toISOString()).toBe("2026-09-02T01:30:00.000Z");
  });

  it("still accepts an ISO instant from API callers, and it wins over the wall-clock field", async () => {
    const job = await exportedAt({ sourceExportedAt: "2026-09-02T09:30:00.000Z", sourceExportedAtLocal: "2026-09-02T09:30" });
    expect((job.sourceExportedAt as Date).toISOString()).toBe("2026-09-02T09:30:00.000Z");
  });

  it("refuses a wall-clock value that is not a real time, or is in the future", async () => {
    for (const bad of ["2026-02-30T09:00", "yesterday", "2026-09-02T25:00", "2099-01-01T09:00"]) {
      const res = await preview(CSV, { sourceExportedAtLocal: bad });
      expect(res.status).toBe(400);
      expect((await res.json()).error).toMatch(/real date that is not in the future/);
    }
    expect(db.jobs).toHaveLength(0);
  });

  it("records an estimate as provisional, refuses provisional with no time or an unknown provenance", async () => {
    const job = await exportedAt({ sourceExportedAtLocal: "2026-09-02T09:30", sourceExportedAtProvenance: "provisional" });
    expect(job.sourceExportedAtProvenance).toBe("provisional");
    expect((await preview(CSV, { sourceExportedAtProvenance: "provisional" })).status).toBe(400);
    expect((await preview(CSV, { sourceExportedAtLocal: "2026-09-02T09:30", sourceExportedAtProvenance: "guessed" })).status).toBe(400);
  });

  it("no export time at all stores none, with no provenance", async () => {
    const job = await exportedAt({});
    expect(job.sourceExportedAt ?? null).toBeNull();
    expect(job.sourceExportedAtProvenance ?? null).toBeNull();
  });

  it("the commit manifest carries the time and how it is known", async () => {
    const { jobId } = await (await preview(CSV, { sourceExportedAtLocal: "2026-09-02T09:30", sourceExportedAtProvenance: "provisional" })).json();
    expect((await commit(jobId)).status).toBe(200);
    const manifest = db.jobs.find((j) => j.id === jobId)!.manifest as Record<string, unknown>;
    expect(manifest.sourceExportedAt).toBe("2026-09-02T08:30:00.000Z");
    expect(manifest.sourceExportedAtProvenance).toBe("provisional");
  });
});

describe("preview → commit", () => {
  it("previews without writing attendance, and stores the totals", async () => {
    const res = await preview();
    expect(res.status).toBe(201);
    const { jobId, summary } = await res.json();
    expect(summary).toMatchObject({ inputRows: 8, toImport: 3, excluded: 1, quarantined: 4, reconciles: true });
    expect(summary.quarantinedByReason).toMatchObject({ unresolved_person: 2, future_session: 1, unknown_class: 1 });
    const job = db.jobs.find((j) => j.id === jobId)!;
    expect(job).toMatchObject({ status: "preview", source: "teamup-attendance", mappingVersion: "attendance@2026-09-30" });
    expect(attendanceCreateMany).not.toHaveBeenCalled();
    expect(db.attendance).toHaveLength(1);
  });

  it("commits with skipDuplicates and checkInMethod import; a live check-in wins; the manifest reconciles", async () => {
    const { jobId } = await (await preview()).json();
    const res = await commit(jobId);
    expect(res.status).toBe(200);
    const { manifest } = await res.json();

    for (const [args] of attendanceCreateMany.mock.calls) {
      expect(args.skipDuplicates).toBe(true);
      for (const row of args.data) {
        expect(row.checkInMethod).toBe("import");
        expect(row.importJobId).toBe(jobId);
        expect(row.sourceRowId).toMatch(/^a\d$/);
      }
    }
    // Bob's live kiosk check-in is untouched.
    expect(db.attendance.find((a) => a.id === "live1")).toMatchObject({ checkInMethod: "kiosk", importJobId: null });

    expect(manifest.created.total).toBe(2);
    expect(manifest.alreadyPresent).toBe(1);
    expect(manifest.quarantined.total).toBe(4);
    expect(manifest.excluded.total).toBe(1);
    expect(manifest.quarantined.byReason.future_session).toBe(1);
    expect(manifest.created.byMonth).toEqual({ "2026-09": 2 });
    expect(manifest.created.byClass).toEqual({ Fundamentals: 2 });
    expect(manifest.reconciles).toBe(true);
    expect(manifest.created.total + manifest.alreadyPresent + manifest.quarantined.total + manifest.excluded.total).toBe(manifest.input.rows);
    // Only the session this job had to make is recorded as its own; the cron's is not.
    expect(manifest.createdInstanceIds).toHaveLength(1);
    expect(manifest.createdInstanceIds).not.toContain("inst0");
    // No session for the future row, none for the unknown class.
    expect(db.instances).toHaveLength(2);

    const job = db.jobs.find((j) => j.id === jobId)!;
    expect(job.status).toBe("complete");
    expect(files.size).toBe(0);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "import.attendance.commit", entityId: jobId }));
    expect((await commit(jobId)).status).toBe(409);
  });

  it("re-runs a stale running job without doubling anything", async () => {
    const { jobId } = await (await preview()).json();
    const job = db.jobs.find((j) => j.id === jobId)!;
    Object.assign(job, { status: "running", startedAt: new Date(Date.now() - 60 * 60 * 1000) });
    const res = await commit(jobId);
    expect(res.status).toBe(200);
    expect((await res.json()).manifest.resumed).toBe(true);
    expect(db.attendance.filter((a) => a.importJobId === jobId)).toHaveLength(2);
  });

  // Connection register gap 17 (30 Sep 2026): a retry after a FAILED run
  // forgot the sessions that run created, so a later rollback left them.
  it("a retry after a failed run keeps the sessions the failed run created", async () => {
    const { jobId } = await (await preview()).json();
    const job = db.jobs.find((j) => j.id === jobId)!;
    Object.assign(job, { status: "failed", manifest: { createdInstanceIds: ["inst-from-failed-run"], createdInstanceCount: 1 } });
    const res = await commit(jobId);
    expect(res.status).toBe(200);
    const manifest = db.jobs.find((j) => j.id === jobId)!.manifest as { createdInstanceIds: string[] };
    expect(manifest.createdInstanceIds).toContain("inst-from-failed-run");
  });

  // Connection register gap 13 (30 Sep 2026): the status check and the switch
  // to running were two statements, so two commits of one job both started.
  // Here another tab claims the job right after this request read it.
  it("a commit that loses the claim to another writes nothing and answers 409", async () => {
    const { jobId } = await (await preview()).json();
    db.raceOnRead = jobId;
    const before = db.attendance.length;
    const res = await commit(jobId);
    expect(res.status).toBe(409);
    expect(db.attendance.length).toBe(before);
    expect(attendanceCreateMany).not.toHaveBeenCalled();
  });

  it("refuses a fresh running job", async () => {
    const { jobId } = await (await preview()).json();
    Object.assign(db.jobs.find((j) => j.id === jobId)!, { status: "running", startedAt: new Date() });
    expect((await commit(jobId)).status).toBe(409);
  });

  it("never imports lib/checkin", () => {
    const src = readFileSync(path.join(process.cwd(), "app/api/admin/import/attendance/route.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']@\/lib\/checkin["']/);
    expect(src).not.toMatch(/import\(["']@\/lib\/checkin["']\)/);
    expect(checkinTouched).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/import/attendance — rollback", () => {
  it("deletes by importJobId only, removes the sessions it created, keeps live data", async () => {
    const { jobId } = await (await preview()).json();
    await commit(jobId);
    const res = await rollback(jobId);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, recordsRemoved: 2, instancesRemoved: 1 });

    expect(attendanceDeleteMany).toHaveBeenCalledTimes(1);
    expect(attendanceDeleteMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", importJobId: jobId });

    expect(db.attendance.map((a) => a.id)).toEqual(["live1"]);
    expect(db.instances.map((i) => i.id)).toEqual(["inst0"]);
    expect(db.jobs.find((j) => j.id === jobId)!.rolledBackAt).toBeInstanceOf(Date);
    expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "import.attendance.rollback" }));
    expect((await rollback(jobId)).status).toBe(409);
  });

  it("keeps a created session that has since gained a live check-in", async () => {
    const { jobId } = await (await preview()).json();
    await commit(jobId);
    const created = db.jobs.find((j) => j.id === jobId)!.manifest as { createdInstanceIds: string[] };
    db.attendance.push({ id: "live2", tenantId: "t1", memberId: "m2", classInstanceId: created.createdInstanceIds[0], checkInTime: new Date(), checkInMethod: "admin", importJobId: null, sourceRowId: null });
    const body = await (await rollback(jobId)).json();
    expect(body).toMatchObject({ instancesRemoved: 0, instancesKept: 1 });
    expect(db.attendance.map((a) => a.id).sort()).toEqual(["live1", "live2"]);
  });

  it("refuses a job that is not complete", async () => {
    const { jobId } = await (await preview()).json();
    expect((await rollback(jobId)).status).toBe(409);
  });
});
