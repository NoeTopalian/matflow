/**
 * T8d (17 Oct 2026): status events written by a TeamUp import carry source
 * provenance — `sourceJobId` and `sourceAction` (import_create |
 * import_refresh | import_rollback). This file covers:
 *
 *   1. The create import: every event the commit writes (adults and the kids
 *      path) carries the job id and `import_create`, with `reason: "import"`.
 *   2. The back-fill of create events written before T8d: preview writes
 *      nothing; apply tags only import create events of members with an
 *      importJobId; a second run changes 0 rows; occurredAt never moves; the
 *      update names the two provenance columns only.
 *   3. The migration: expand-only, CHECK added NOT VALID then validated, the
 *      CHECK list equals the writer's list, no foreign key to ImportJob.
 *
 * The refresh and rollback call sites are covered in
 * tests/unit/import-teamup-refresh.test.ts; the writer's pass-through in
 * tests/unit/member-status-event.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { addLoginClaimSql } from "./login-claim-fake";

const h = vi.hoisted(() => ({ files: new Map<string, string>(), events: [] as Record<string, unknown>[] }));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwner: async () => ({ ok: true, tenantId: "t1", userId: "u1" }) }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: async () => ({ ok: true }) }));
// Capture what the commit hands the status writer.
vi.mock("@/lib/member-status", async (orig) => ({
  ...(await orig<typeof import("@/lib/member-status")>()),
  recordStatusEventsBulk: vi.fn(async (_tx: unknown, inputs: Record<string, unknown>[]) => {
    h.events.push(...inputs);
    return inputs.length;
  }),
}));
vi.mock("@/lib/api-error", () => ({ apiError: (message: string, status: number) => ({ status, json: async () => ({ error: message }) }) }));
vi.mock("@/lib/import-storage", () => ({ readImportFile: async (url: string) => h.files.get(url) ?? null, deleteImportFile: async () => {} }));
vi.mock("@/lib/prisma-tenant", () => ({ withTenantContext: async (_t: string, fn: (tx: unknown) => unknown) => fn(addLoginClaimSql(makeTx())) }));

import { MEMBER_STATUS_EVENT_SOURCE_ACTIONS } from "@/lib/member-status";
import { backfillCreateEventProvenance } from "@/lib/status-event-provenance";

type Row = Record<string, unknown> & { id: string };
let db: { jobs: Row[]; members: Row[] };

function matches(row: Record<string, unknown>, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (k === "OR") return (v as Record<string, unknown>[]).some((w) => matches(row, w));
    if (v === null) return (row[k] ?? null) === null;
    if (v && typeof v === "object" && !(v instanceof Date)) {
      const op = v as { not?: unknown; in?: unknown[]; notIn?: unknown[]; lt?: Date; gte?: Date; endsWith?: string; mode?: string };
      const val = row[k];
      const ci = op.mode === "insensitive";
      const norm = (x: unknown) => (ci && typeof x === "string" ? x.toLowerCase() : x);
      if ("not" in op) return (val ?? null) !== op.not;
      if ("in" in op) return op.in!.map(norm).includes(norm(val));
      if ("notIn" in op) return !op.notIn!.includes(val);
      if ("endsWith" in op) return typeof val === "string" && val.endsWith(op.endsWith!);
      if ("lt" in op) return val != null && (val as Date) < op.lt!;
      if ("gte" in op) return val != null && (val as Date) >= op.gte!;
      return true;
    }
    return (row[k] ?? null) === v;
  });
}

function makeTx() {
  return {
    importJob: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => db.jobs.find((x) => matches(x, where)) ?? null,
      findUnique: async ({ where }: { where: { id: string } }) => db.jobs.find((x) => x.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => Object.assign(db.jobs.find((x) => x.id === where.id)!, data),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = db.jobs.filter((x) => matches(x, where));
        for (const x of hit) Object.assign(x, data);
        return { count: hit.length };
      },
    },
    membershipTier: { findMany: async () => [] },
    member: {
      findMany: async ({ where }: { where: Record<string, unknown> }) =>
        db.members.filter((m) => matches(m, where)).map((m) => ({ ...m, children: db.members.filter((c) => c.parentMemberId === m.id) })),
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => {
        for (const d of data) db.members.push({ status: "active", ...d, id: `m${db.members.length + 1}` });
        return { count: data.length };
      },
      count: async ({ where }: { where: Record<string, unknown> }) => db.members.filter((m) => matches(m, where)).length,
    },
    user: { findUnique: async () => ({ name: "Owner", email: "owner@example.test", tenant: { name: "Club" } }) },
    tenant: { findUnique: async () => ({ timezone: "Europe/London" }) },
    importedMembership: {
      createMany: async ({ data }: { data: Record<string, unknown>[] }) => ({ count: data.length }),
      count: async () => 0,
    },
  };
}

// Invented people (the fixture shape of tests/unit/import-teamup.test.ts).
const HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
function row(o: Partial<Record<"name" | "email" | "plan" | "status" | "start" | "expiry" | "cancelled" | "dob" | "ecName" | "ecRel", string>>): string {
  return [o.name, o.email, "", o.plan, "recurring", o.status, "Stripe", o.start, o.start, o.expiry, o.cancelled, "Yes", "", "", "", "", "", "", "GB", "", "", "", o.dob, o.ecName, "", o.ecRel].map((s) => s ?? "").join(",");
}
const FIXTURE = [
  HEADER,
  row({ name: "Ada Lovelace", email: "ada@example.test", plan: "Adults Advanced 2026", status: "active", start: "2026-01-14", dob: "1990-04-15" }),
  row({ name: "Priya Sharma", email: "priya@example.test", plan: "Adults Advanced 2026", status: "active", start: "2024-12-01", dob: "1985-06-12" }),
  row({ name: "Neha Sharma", email: "priya@example.test", plan: "Kids Unlimited 2026", status: "active", start: "2026-02-02", dob: "2016-03-21", ecName: "Priya Sharma", ecRel: "Mother" }),
  row({ name: "Tom Roper", email: "tom@example.test", plan: "Adults Advanced 2026", status: "cancelled", start: "2025-02-03", expiry: "2025-12-08", cancelled: "2025-12-08", dob: "1999-06-28" }),
].join("\n");

beforeEach(() => {
  h.files.clear();
  h.events = [];
  h.files.set("local-import://t8d", FIXTURE);
  db = {
    members: [],
    jobs: [{ id: "job_create", tenantId: "t1", source: "teamup", mode: "create", status: "preview", fileBlobUrl: "local-import://t8d", fileName: "teamup.csv", fileHash: "hash-t8d", sourceExportedAt: new Date("2026-10-03T11:39:57Z"), sourceExportedAtProvenance: "owner_stated", startedAt: null, completedAt: null, rolledBackAt: null, manifest: null, mappingVersion: "teamup-2@2026-10-02" }],
  };
});

describe("T8d: a create import's events carry the job and import_create", () => {
  it("every event the commit writes, adults and children, names the job; reason stays import", async () => {
    const { POST } = await import("@/app/api/admin/import/[id]/commit/route");
    const res = (await POST(new Request("http://localhost/x", { method: "POST" }), { params: Promise.resolve({ id: "job_create" }) })) as unknown as { status: number };
    expect(res.status).toBe(200);

    const created = db.members.filter((m) => m.importJobId === "job_create");
    expect(created.length).toBeGreaterThanOrEqual(4); // Ada, Priya, Neha (kids path), Tom
    expect(created.some((m) => m.parentMemberId)).toBe(true);
    expect(h.events.length).toBe(created.length);
    for (const e of h.events) {
      expect(e).toMatchObject({ fromStatus: null, reason: "import", changedById: null, sourceJobId: "job_create", sourceAction: "import_create" });
    }
  });
});

// ── Back-fill ────────────────────────────────────────────────────────────────

type Ev = { id: string; tenantId: string; memberId: string; fromStatus: string | null; toStatus: string; reason: string; occurredAt: Date; sourceJobId: string | null; sourceAction: string | null };

function backfillHarness() {
  const events: Ev[] = [];
  const members: Array<{ id: string; tenantId: string; importJobId: string | null }> = [];
  const updates: Array<Record<string, unknown>> = [];
  const ev = (o: Partial<Ev> & Pick<Ev, "id" | "memberId">): Ev => ({
    tenantId: "t1", fromStatus: null, toStatus: "active", reason: "import", occurredAt: new Date("2026-10-03T11:39:57Z"), sourceJobId: null, sourceAction: null, ...o,
  });
  const tx = {
    memberStatusEvent: {
      findMany: async ({ where, select }: { where: Record<string, unknown>; select: Record<string, boolean> }) =>
        events.filter((e) => matches(e, where)).map((e) => Object.fromEntries(Object.keys(select).map((k) => [k, e[k as keyof Ev]]))),
      updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        updates.push(data);
        let count = 0;
        for (const e of events) if (matches(e, where)) { Object.assign(e, data); count += 1; }
        return { count };
      },
    },
    member: {
      findMany: async ({ where }: { where: Record<string, unknown> }) => members.filter((m) => matches(m, where)),
    },
  };
  return { events, members, updates, ev, tx: tx as never };
}

const checksum = (events: Ev[]) => events.map((e) => `${e.id}:${e.occurredAt.toISOString()}`).sort().join(",");

describe("T8d back-fill of create events written before T8d", () => {
  function seed() {
    const hb = backfillHarness();
    hb.members.push(
      { id: "ada", tenantId: "t1", importJobId: "job_a" },
      { id: "tom", tenantId: "t1", importJobId: "job_a" },
      { id: "kid", tenantId: "t1", importJobId: "job_b" },
      { id: "desk", tenantId: "t1", importJobId: null }, // added at the desk
      { id: "other", tenantId: "t2", importJobId: "job_x" }, // another club
    );
    hb.events.push(
      hb.ev({ id: "e1", memberId: "ada" }),
      hb.ev({ id: "e2", memberId: "tom", toStatus: "cancelled" }),
      hb.ev({ id: "e3", memberId: "kid" }),
      hb.ev({ id: "e4", memberId: "desk", reason: "staff_edit" }),
      hb.ev({ id: "e5", memberId: "desk" }), // an import-reason create event for a member with no job: left alone
      hb.ev({ id: "e6", memberId: "ada", fromStatus: "active", toStatus: "cancelled", occurredAt: new Date("2026-10-09T00:00:00Z") }), // a refresh move, not a create
      hb.ev({ id: "e7", memberId: "kid", fromStatus: "active", toStatus: "inactive", reason: "staff_edit" }),
      hb.ev({ id: "e8", tenantId: "t2", memberId: "other" }),
      hb.ev({ id: "e9", memberId: "tom", sourceJobId: "job_already", sourceAction: "import_create" }),
    );
    return hb;
  }

  it("preview reads and writes nothing, but names what apply would touch", async () => {
    const hb = seed();
    const r = await backfillCreateEventProvenance(hb.tx, "t1", { apply: false });
    expect(hb.updates).toEqual([]);
    expect(r).toMatchObject({ tenantId: "t1", candidates: 4, withoutJob: 1, updated: 0 });
    expect(r.byJob).toEqual([
      { sourceJobId: "job_a", eventIds: ["e1", "e2"] },
      { sourceJobId: "job_b", eventIds: ["e3"] },
    ]);
  });

  it("apply tags only this club's import create events of members with a job; occurredAt never moves; a second run changes 0 rows", async () => {
    const hb = seed();
    const before = checksum(hb.events);
    const r = await backfillCreateEventProvenance(hb.tx, "t1", { apply: true });
    expect(r.updated).toBe(3);
    const tagged = Object.fromEntries(hb.events.map((e) => [e.id, [e.sourceJobId, e.sourceAction]]));
    expect(tagged).toEqual({
      e1: ["job_a", "import_create"],
      e2: ["job_a", "import_create"],
      e3: ["job_b", "import_create"],
      e4: [null, null],
      e5: [null, null],
      e6: [null, null],
      e7: [null, null],
      e8: [null, null], // another club: untouched
      e9: ["job_already", "import_create"], // already tagged: untouched
    });
    // The update writes the two provenance columns and nothing else.
    for (const d of hb.updates) expect(Object.keys(d).sort()).toEqual(["sourceAction", "sourceJobId"]);
    expect(checksum(hb.events)).toBe(before);

    hb.updates.length = 0;
    const again = await backfillCreateEventProvenance(hb.tx, "t1", { apply: true });
    expect(again).toMatchObject({ candidates: 1, withoutJob: 1, updated: 0, byJob: [] });
    expect(hb.updates).toEqual([]);
    expect(checksum(hb.events)).toBe(before);
  });

  it("refuses to run without a club", async () => {
    const hb = seed();
    await expect(backfillCreateEventProvenance(hb.tx, "", { apply: true })).rejects.toThrow(/tenantId/);
  });
});

// ── Migration ────────────────────────────────────────────────────────────────

describe("T8d migration: expand-only provenance columns", () => {
  const DIR = join(process.cwd(), "prisma", "migrations");
  const dir = readdirSync(DIR).find((d) => d.endsWith("_status_event_source_provenance"));
  const sql = dir ? readFileSync(join(DIR, dir, "migration.sql"), "utf8") : "";
  const body = sql.split(/\r?\n/).map((l) => l.replace(/--.*$/, "")).join("\n");

  it("exists, adds two nullable TEXT columns and the (tenantId, sourceJobId) index", () => {
    expect(dir).toBeTruthy();
    expect(body).toMatch(/ADD COLUMN "sourceJobId" TEXT\s*,/);
    expect(body).toMatch(/ADD COLUMN "sourceAction" TEXT\s*;/);
    expect(body).not.toMatch(/NOT NULL/i);
    expect(body).toMatch(/CREATE INDEX "MemberStatusEvent_tenantId_sourceJobId_idx" ON "MemberStatusEvent"\("tenantId", "sourceJobId"\)/);
  });

  it("adds the CHECK NOT VALID, then validates it, and the list is the writer's whole list", () => {
    const add = body.indexOf('ADD CONSTRAINT "MemberStatusEvent_sourceAction_check"');
    const validate = body.indexOf('VALIDATE CONSTRAINT "MemberStatusEvent_sourceAction_check"');
    expect(add).toBeGreaterThan(-1);
    expect(validate).toBeGreaterThan(add);
    expect(body.slice(add, validate)).toMatch(/NOT VALID/);
    const list = /CHECK \("sourceAction" IN \(([^)]*)\)\)/.exec(body)?.[1] ?? "";
    // import_backfill (T8b) is folded into this one migration: neither was
    // ever applied, so no second migration drops and re-adds the CHECK.
    expect(list.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual([...MEMBER_STATUS_EVENT_SOURCE_ACTIONS]);
  });

  it("drops, renames and rewrites nothing, and has no foreign key to ImportJob", () => {
    expect(body).not.toMatch(/\bDROP\b/i);
    expect(body).not.toMatch(/\bRENAME\b/i);
    expect(body).not.toMatch(/\bUPDATE\b/i);
    expect(body).not.toMatch(/FOREIGN KEY|REFERENCES/i);
    expect(body).not.toMatch(/occurredAt/);
  });
});
