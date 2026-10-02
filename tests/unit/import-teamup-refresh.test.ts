/**
 * TeamUp status refresh (readiness spec v3 §7; contract
 * docs/readiness/TEAMUP-OPERATIONS-CONTRACT.md §3 and §5).
 *
 * A fresh TeamUp export updates ONLY the TeamUp-owned standing of people the
 * first import created, matched by the key that import stored as externalRef.
 * Pinned here, against the real routes over a small in-memory database:
 *   - the preview lists every change (before → after) and all the exception
 *     kinds, and writes no member;
 *   - the commit writes only the owned fields (a contact field edited in
 *     MatFlow survives), records before and after, and sends nothing;
 *   - the rollback restores only members still carrying what the refresh wrote;
 *   - the "same file twice" refusal compares jobs of the same mode only.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { parseTeamUp } from "@/lib/importers/teamup";
import { planRefresh, REFRESH_OWNED_FIELDS } from "@/lib/importers/teamup-refresh";

// ── Mocks ────────────────────────────────────────────────────────────────────

const { gateMock, auditMock, emailMock, files } = vi.hoisted(() => ({
  gateMock: vi.fn(),
  auditMock: vi.fn(),
  emailMock: vi.fn(),
  files: new Map<string, string>(),
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: () => gateMock() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: (...a: unknown[]) => auditMock(...a) }));
vi.mock("@/lib/email", () => ({ sendEmail: (...a: unknown[]) => emailMock(...a) }));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number, e?: unknown) => {
    if (e) console.error(e);
    return { status, json: async () => ({ error: message }) };
  },
}));
vi.mock("@/lib/import-storage", () => ({
  importStorageAvailable: () => true,
  sha256: (b: Uint8Array) => `hash-${Buffer.from(b).toString("base64").slice(-24)}-${b.length}`,
  putImportFile: async (_t: string, b: Uint8Array) => {
    const url = `local-import://f${files.size}`;
    files.set(url, new TextDecoder().decode(b));
    return url;
  },
  readImportFile: async (url: string) => files.get(url) ?? null,
  deleteImportFile: async (url: string) => { files.delete(url); },
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) => fn(makeTx()),
}));

// ── The file ─────────────────────────────────────────────────────────────────

const HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";

function row(o: { name: string; email: string; plan: string; status: string; start: string; expiry?: string; cancelled?: string; dob?: string }): string {
  return [o.name, o.email, "", o.plan, "recurring", o.status, "Stripe", o.start, o.start, o.expiry ?? "", o.cancelled ?? "", "Yes", "", "", "", "", "", "", "GB", "", "", "", o.dob ?? "", "", "", ""].join(",");
}

const FILE = [
  HEADER,
  // Ada: on hold at TeamUp now (MatFlow had her paid).
  row({ name: "Ada Lovelace", email: "ada@example.test", plan: "Adults Advanced 2026", status: "hold", start: "2026-01-14", dob: "1990-04-15" }),
  // Tom: cancelled at TeamUp (MatFlow had him active).
  row({ name: "Tom Roper", email: "tom@example.test", plan: "Adults Advanced 2026", status: "cancelled", start: "2025-02-03", expiry: "2026-09-20", cancelled: "2026-09-20", dob: "1999-06-28" }),
  // Uma: no change.
  row({ name: "Uma Same", email: "uma@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-02-01", dob: "1991-01-01" }),
  // Dan: MatFlow bills him now.
  row({ name: "Dan Coles", email: "dan@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-06-17", dob: "1992-11-13" }),
  // Nell: new at TeamUp (or renamed there) — no member carries her key.
  row({ name: "Nell New", email: "nell@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-09-01", dob: "1995-05-05" }),
  // A child with no email and no parent: the parser refuses the row.
  row({ name: "Lil Nobody", email: "", plan: "Kids Unlimited 2026", status: "active", start: "2026-03-01", dob: "2019-01-01" }),
].join("\n");

const parsed = parseTeamUp(FILE);
function keyOf(name: string): string {
  const d = parsed.drafts.find((x) => x.name === name);
  if (!d?.sourceKey) throw new Error(`no key for ${name}`);
  return d.sourceKey;
}

// ── A small in-memory database ───────────────────────────────────────────────

type Member = Record<string, unknown> & { id: string };
type Job = Record<string, unknown> & { id: string };

let db: { members: Member[]; jobs: Job[]; events: unknown[]; memberWrites: { where: unknown; data: Record<string, unknown> }[] };

const CREATE_JOB = "job_create";
const EXPORT_1 = new Date("2026-09-01T08:00:00Z");
const EXPORT_2 = new Date("2026-09-29T08:00:00Z");

function member(over: Partial<Member> & { id: string; name: string }): Member {
  return {
    tenantId: "t1",
    email: `${over.id}@example.test`,
    phone: null,
    externalRef: null,
    billedBy: "teamup",
    status: "active",
    paymentStatus: "paid",
    cancelledAt: null,
    membershipType: "Adults Advanced 2026",
    membershipTierId: null,
    billingStatusAsOf: EXPORT_1,
    billingStatusSource: CREATE_JOB,
    holdUntil: null,
    nextDueAt: null,
    notes: null,
    ...over,
  };
}

function seed() {
  db = {
    members: [
      member({ id: "m_ada", name: "Ada Lovelace", externalRef: keyOf("Ada Lovelace"), phone: "07999 edited in MatFlow", notes: "Knee — go easy" }),
      member({ id: "m_tom", name: "Tom Roper", externalRef: keyOf("Tom Roper") }),
      member({ id: "m_uma", name: "Uma Same", externalRef: keyOf("Uma Same") }),
      member({ id: "m_dan", name: "Dan Coles", externalRef: keyOf("Dan Coles"), billedBy: "matflow", billingStatusAsOf: null, billingStatusSource: null }),
      member({ id: "m_gone", name: "Gina Gone", externalRef: "teamup:gina@example.test|gina gone" }),
      // A member MatFlow created by hand: never part of a refresh.
      member({ id: "m_local", name: "Lou Local", billedBy: "matflow", externalRef: null, billingStatusAsOf: null, billingStatusSource: null }),
    ],
    jobs: [],
    events: [],
    memberWrites: [],
  };
}

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

function pick(row: Record<string, unknown>, select?: Record<string, unknown>) {
  if (!select) return { ...row };
  return Object.fromEntries(Object.keys(select).map((k) => [k, row[k] ?? null]));
}

function makeTx() {
  return {
    member: {
      findMany: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) =>
        db.members.filter((m) => matches(m, where)).map((m) => pick(m, select)),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        db.memberWrites.push({ where, data });
        let count = 0;
        for (const m of db.members) if (matches(m, where)) { Object.assign(m, data); count += 1; }
        return { count };
      },
      update: async () => { throw new Error("a refresh must not use member.update"); },
      createMany: async () => { throw new Error("a refresh must not create members"); },
    },
    membershipTier: { findMany: async () => [] },
    memberStatusEvent: { createMany: async ({ data }: { data: unknown[] }) => { db.events.push(...data); return { count: data.length }; } },
    importJob: {
      findFirst: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, unknown> }) => {
        const j = db.jobs.find((x) => matches(x, where));
        return j ? pick(j, select) : null;
      },
      findUnique: async ({ where, select }: { where: { id: string }; select?: Record<string, unknown> }) => {
        const j = db.jobs.find((x) => x.id === where.id);
        return j ? pick(j, select) : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const j = { id: `job_${db.jobs.length + 1}`, createdAt: new Date(), totalRows: 0, processedRows: 0, importedRows: 0, skippedRows: 0, errorRows: 0, startedAt: null, completedAt: null, errorLog: null, manifest: null, rolledBackAt: null, mode: "create", ...data };
        db.jobs.push(j);
        return j;
      },
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = db.jobs.filter((x) => matches(x, where));
        for (const x of hit) Object.assign(x, data);
        return { count: hit.length };
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const j = db.jobs.find((x) => x.id === where.id)!;
        Object.assign(j, JSON.parse(JSON.stringify(data, (_k, v) => v)), dateFields(data));
        return j;
      },
    },
    user: { findUnique: async () => ({ name: "Owner", email: "owner@example.test", tenant: { name: "Club" } }) },
    // teamup-2: the as-of date is read in the club timezone; the row ledger is
    // written on a create import (none in a refresh, but the delegate must exist).
    tenant: { findUnique: async () => ({ timezone: "Europe/London" }) },
    importedMembership: { createMany: async ({ data }: { data: unknown[] }) => ({ count: data.length }), count: async () => 0, deleteMany: async () => ({ count: 0 }) },
  };
}

// JSON round-trip for the manifest (as Postgres would), real Dates kept for date columns.
function dateFields(data: Record<string, unknown>) {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v instanceof Date));
}

function refreshJob(over: Partial<Job> = {}): Job {
  const url = `local-import://refresh-${db.jobs.length}`;
  files.set(url, FILE);
  const j: Job = {
    id: "job_refresh", tenantId: "t1", source: "teamup", mode: "refresh", fileName: "teamup-29-sep.csv",
    fileBlobUrl: url, status: "pending", fileHash: "hash-refresh", sourceExportedAt: EXPORT_2, mappingVersion: "teamup@x",
    manifest: null, rolledBackAt: null, completedAt: null, startedAt: null,
    ...over,
  };
  db.jobs.push(j);
  return j;
}

const req = () => new Request("http://localhost/x", { method: "POST" });
const params = (id: string) => ({ params: Promise.resolve({ id }) });

import { POST as previewPOST } from "@/app/api/admin/import/[id]/preview/route";
import { POST as commitPOST } from "@/app/api/admin/import/[id]/commit/route";
import { POST as rollbackPOST } from "@/app/api/admin/import/[id]/rollback/route";
import { POST as uploadPOST } from "@/app/api/admin/import/upload/route";

type Res = { status: number; json: () => Promise<Record<string, unknown>> };

beforeEach(() => {
  vi.clearAllMocks();
  gateMock.mockResolvedValue({ ok: true, tenantId: "t1", userId: "u1" });
  seed();
});

// ── Preview ──────────────────────────────────────────────────────────────────

describe("status refresh preview", () => {
  // Functional review F9 (30 Sep 2026): kept holds appeared only after commit.
  it("lists the holds the refresh will keep, before anything is written", async () => {
    refreshJob();
    Object.assign(db.members.find((m) => m.name === "Uma Same")!, { paymentStatus: "paused" });
    const res = (await previewPOST(req(), params("job_refresh"))) as unknown as Res;
    expect(res.status).toBe(200);
    const s = (await res.json()) as { exceptions: { holdKept?: { name: string; teamUpSays: string }[] } };
    expect(s.exceptions.holdKept).toEqual([expect.objectContaining({ name: "Uma Same", teamUpSays: "paid" })]);
    expect(db.memberWrites).toHaveLength(0);
  });

  it("lists every change before → after and all the exception kinds, and writes no member", async () => {
    refreshJob();
    const res = (await previewPOST(req(), params("job_refresh"))) as unknown as Res;
    expect(res.status).toBe(200);
    const s = (await res.json()) as {
      mode: string; matched: number; willChange: number; unchanged: number;
      changes: { name: string; fields: { field: string; before: unknown; after: unknown }[] }[];
      exceptions: { notInMatFlow: { name: string }[]; notInFile: { name: string }[]; billedByMatFlow: { name: string }[]; refused: unknown[] };
    };
    expect(s.mode).toBe("refresh");
    expect(s.matched).toBe(3);
    expect(s.willChange).toBe(2);
    expect(s.unchanged).toBe(1);

    const ada = s.changes.find((c) => c.name === "Ada Lovelace")!;
    expect(ada.fields).toContainEqual({ field: "paymentStatus", before: "paid", after: "paused" });
    const tom = s.changes.find((c) => c.name === "Tom Roper")!;
    expect(tom.fields).toContainEqual({ field: "status", before: "active", after: "cancelled" });
    expect(tom.fields.find((f) => f.field === "cancelledAt")?.after).toMatch(/^2026-09-20/);
    expect(s.changes.some((c) => c.name === "Uma Same")).toBe(false);

    // (a) in the file, no member with that key
    expect(s.exceptions.notInMatFlow.map((e) => e.name)).toEqual(["Nell New"]);
    // (b) billed by TeamUp here, not in the file
    expect(s.exceptions.notInFile.map((e) => e.name)).toEqual(["Gina Gone"]);
    // (c) rows the parser refused
    expect(s.exceptions.refused.length).toBeGreaterThanOrEqual(1);
    // and a member MatFlow bills now is never changed by TeamUp
    expect(s.exceptions.billedByMatFlow.map((e) => e.name)).toEqual(["Dan Coles"]);

    expect(db.memberWrites).toHaveLength(0);
    expect(db.jobs[0].status).toBe("preview");
  });

  it("planRefresh reconciles: every person in the file is matched or an exception", () => {
    const members = db.members.map((m) => m as unknown as Parameters<typeof planRefresh>[0]["members"][number]);
    const plan = planRefresh({ drafts: parsed.drafts, errors: parsed.errors, members, tiers: [], job: { id: "j", sourceExportedAt: EXPORT_2 } });
    expect(plan.reconciles).toBe(true);
    // Lou (created by hand in MatFlow, no key) is in no list.
    const named = [...plan.matched.map((c) => c.name), ...plan.exceptions.notInFile.map((e) => e.name)];
    expect(named).not.toContain("Lou Local");
  });
});

describe("a refresh never lifts a hold placed in MatFlow (functional review F1, 30 Sep 2026)", () => {
  it("keeps the hold and lists it; a TeamUp cancellation still applies", () => {
    const members = db.members.map((m) => ({
      ...m,
      // Uma is on hold in MatFlow; TeamUp says she is active. Tom is on hold and TeamUp cancelled him.
      ...(m.name === "Uma Same" || m.name === "Tom Roper" ? { paymentStatus: "paused" } : {}),
    })) as unknown as Parameters<typeof planRefresh>[0]["members"];
    const plan = planRefresh({ drafts: parsed.drafts, errors: parsed.errors, members, tiers: [], job: { id: "j", sourceExportedAt: EXPORT_2 } });
    const uma = plan.matched.find((c) => c.name === "Uma Same")!;
    expect(uma.after.paymentStatus).toBe("paused");
    expect(uma.fields).not.toContain("paymentStatus");
    expect(plan.exceptions.holdKept).toEqual([expect.objectContaining({ name: "Uma Same", teamUpSays: "paid" })]);
    const tom = plan.matched.find((c) => c.name === "Tom Roper")!;
    expect(tom.after.paymentStatus).toBe("cancelled");
  });
});

// ── Ordering (teamup-2, 2 Oct 2026) ──────────────────────────────────────────
// The 24 Sep export must never be applied over the 2 Oct import: a file
// exported BEFORE the standing already recorded is shown at preview and
// refused at commit, with nothing written and the job marked failed.

const EXPORT_OLD = new Date("2026-08-15T08:00:00Z"); // older than EXPORT_1 on every seeded member

describe("a refresh never moves standing backwards in time", () => {
  it("planRefresh names the older file and how many members already carry newer standing", () => {
    const members = db.members.map((m) => m as unknown as Parameters<typeof planRefresh>[0]["members"][number]);
    const plan = planRefresh({ drafts: parsed.drafts, errors: parsed.errors, members, tiers: [], job: { id: "j_old", sourceExportedAt: EXPORT_OLD } });
    // Ada, Tom, Uma carry EXPORT_1 (newer); Dan is MatFlow-billed; Gina is not in the file.
    expect(plan.olderThanRecorded).toEqual({ fileExportedAt: EXPORT_OLD.toISOString(), newestRecordedAt: EXPORT_1.toISOString(), members: 3 });
    // A newer file (or the same job resuming) is not flagged.
    expect(planRefresh({ drafts: parsed.drafts, errors: parsed.errors, members, tiers: [], job: { id: "j", sourceExportedAt: EXPORT_2 } }).olderThanRecorded).toBeUndefined();
    const resumed = db.members.map((m) => ({ ...m, billingStatusSource: "j_old" })) as unknown as Parameters<typeof planRefresh>[0]["members"];
    expect(planRefresh({ drafts: parsed.drafts, errors: parsed.errors, members: resumed, tiers: [], job: { id: "j_old", sourceExportedAt: EXPORT_OLD } }).olderThanRecorded).toBeUndefined();
  });

  it("the preview shows it; the commit refuses with 409, writes no member, and marks the job failed", async () => {
    refreshJob({ sourceExportedAt: EXPORT_OLD });
    const pre = (await previewPOST(req(), params("job_refresh"))) as unknown as Res;
    expect(pre.status).toBe(200);
    const preview = await pre.json();
    expect(preview.olderThanRecorded).toMatchObject({ members: 3 });

    db.jobs[0].status = "preview";
    const res = (await commitPOST(req(), params("job_refresh"))) as unknown as Res;
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(String(body.error)).toMatch(/exported 2026-08-15/);
    expect(String(body.error)).toMatch(/nothing was changed/i);
    expect(db.memberWrites).toEqual([]);
    expect(db.members.find((m) => m.id === "m_ada")!.paymentStatus).toBe("paid");
    expect(db.jobs[0].status).toBe("failed");
    expect(emailMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalledWith(expect.objectContaining({ action: "import.refresh" }));
  });
});

// ── Commit ───────────────────────────────────────────────────────────────────

describe("status refresh commit", () => {
  it("writes only TeamUp-owned fields, keeps a contact field edited in MatFlow, and records before and after", async () => {
    refreshJob({ status: "preview" });
    const res = (await commitPOST(req(), params("job_refresh"))) as unknown as Res;
    expect(res.status).toBe(200);

    const allowed = new Set<string>([...REFRESH_OWNED_FIELDS, "billingStatusAsOf", "billingStatusSource"]);
    expect(db.memberWrites.length).toBe(3);
    for (const w of db.memberWrites) {
      for (const k of Object.keys(w.data)) expect(allowed.has(k), `refresh wrote ${k}`).toBe(true);
      expect(w.where).toMatchObject({ tenantId: "t1", billedBy: "teamup" });
    }

    const ada = db.members.find((m) => m.id === "m_ada")!;
    expect(ada.paymentStatus).toBe("paused");
    expect(ada.phone).toBe("07999 edited in MatFlow");
    expect(ada.notes).toBe("Knee — go easy");
    expect(ada.holdUntil).toBeNull();
    expect((ada.billingStatusAsOf as Date).toISOString()).toBe(EXPORT_2.toISOString());
    expect(ada.billingStatusSource).toBe("job_refresh");

    const tom = db.members.find((m) => m.id === "m_tom")!;
    expect(tom.status).toBe("cancelled");
    // Dan (billed by MatFlow) and Gina (not in the file) are untouched.
    expect(db.members.find((m) => m.id === "m_dan")!.billingStatusSource).toBeNull();
    expect(db.members.find((m) => m.id === "m_gone")!.billingStatusSource).toBe(CREATE_JOB);

    const job = db.jobs[0];
    expect(job.status).toBe("complete");
    const changes = (job.manifest as { refresh: { changes: { memberId: string; before: Record<string, unknown>; after: Record<string, unknown> }[] } }).refresh.changes;
    const adaChange = changes.find((c) => c.memberId === "m_ada")!;
    expect(adaChange.before).toMatchObject({ paymentStatus: "paid", billingStatusSource: CREATE_JOB, billingStatusAsOf: EXPORT_1.toISOString() });
    expect(adaChange.after).toMatchObject({ paymentStatus: "paused", billingStatusSource: "job_refresh", billingStatusAsOf: EXPORT_2.toISOString() });

    // A status change is recorded as an import event; nothing is emailed.
    expect(db.events).toContainEqual(expect.objectContaining({ memberId: "m_tom", fromStatus: "active", toStatus: "cancelled", reason: "import" }));
    expect(emailMock).not.toHaveBeenCalled();
  });
});

// ── Rollback ─────────────────────────────────────────────────────────────────

describe("status refresh rollback", () => {
  it("restores only members still carrying what the refresh wrote, and says why the others were kept", async () => {
    refreshJob({ status: "preview" });
    await commitPOST(req(), params("job_refresh"));

    // Staff change Tom's payment standing after the refresh.
    db.members.find((m) => m.id === "m_tom")!.paymentStatus = "overdue";
    db.memberWrites = [];

    const res = (await rollbackPOST(req(), params("job_refresh"))) as unknown as Res;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { restored: number; kept: { memberId: string; reasons: string[] }[] };
    expect(body.restored).toBe(2); // Ada and Uma (Uma's status date only)
    expect(body.kept).toEqual([{ memberId: "m_tom", name: "Tom Roper", reasons: ["payment status changed since this refresh"] }]);

    const ada = db.members.find((m) => m.id === "m_ada")!;
    expect(ada.paymentStatus).toBe("paid");
    expect(ada.billingStatusSource).toBe(CREATE_JOB);
    expect((ada.billingStatusAsOf as Date).toISOString()).toBe(EXPORT_1.toISOString());
    expect(ada.phone).toBe("07999 edited in MatFlow");

    const tom = db.members.find((m) => m.id === "m_tom")!;
    expect(tom.paymentStatus).toBe("overdue");
    expect(tom.status).toBe("cancelled");
    expect(db.memberWrites.every((w) => (w.where as { id: string }).id !== "m_tom")).toBe(true);

    // Nothing left that can be undone once Tom is dealt with? Not yet: a second run finds Tom still kept.
    const again = (await rollbackPOST(req(), params("job_refresh"))) as unknown as Res;
    expect(again.status).toBe(200);
    expect(((await again.json()) as { restored: number }).restored).toBe(0);
  });
});

// ── Upload: same file twice, per mode ───────────────────────────────────────

describe("upload: the same-file refusal compares jobs of the same mode only", () => {
  function upload(mode: "create" | "refresh") {
    const fd = new FormData();
    fd.append("file", new File([FILE], "teamup.csv", { type: "text/csv" }));
    fd.append("source", "teamup");
    fd.append("mode", mode);
    fd.append("sourceExportedAt", EXPORT_2.toISOString());
    return uploadPOST(new Request("http://localhost/api/admin/import/upload", { method: "POST", body: fd })) as unknown as Promise<Res>;
  }

  it("a file already used to add people may be used for a refresh, but not for a second refresh", async () => {
    const first = await upload("create");
    expect(first.status).toBe(201);
    Object.assign(db.jobs[0], { status: "complete", completedAt: new Date() });

    const refresh = await upload("refresh");
    expect(refresh.status).toBe(201);
    expect(db.jobs[1].mode).toBe("refresh");

    expect((await upload("create")).status).toBe(409);

    Object.assign(db.jobs[1], { status: "complete", completedAt: new Date() });
    const second = await upload("refresh");
    expect(second.status).toBe(409);
    expect(String((await second.json()).error)).toMatch(/already used for a status refresh/);
  });

  it("refuses a refresh for a source other than TeamUp, and one with no export time", async () => {
    const fd = new FormData();
    fd.append("file", new File([FILE], "x.csv", { type: "text/csv" }));
    fd.append("source", "generic");
    fd.append("mode", "refresh");
    const res = (await uploadPOST(new Request("http://localhost/x", { method: "POST", body: fd }))) as unknown as Res;
    expect(res.status).toBe(400);

    const fd2 = new FormData();
    fd2.append("file", new File([FILE], "x.csv", { type: "text/csv" }));
    fd2.append("source", "teamup");
    fd2.append("mode", "refresh");
    const res2 = (await uploadPOST(new Request("http://localhost/x", { method: "POST", body: fd2 }))) as unknown as Res;
    expect(res2.status).toBe(400);
    expect(db.jobs).toHaveLength(0);
  });
});
