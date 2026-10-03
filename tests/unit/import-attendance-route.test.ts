/**
 * The attendance-history import API (app/api/admin/import/attendance and its
 * /export sibling), driven through its route handlers.
 *
 * Real: the auth gate (lib/api-authz.ts — only `auth()` from @/auth is mocked,
 * so every 401/403 below comes from requireApiOwner itself), the same-origin
 * check (lib/csrf.ts), the upload store (lib/import-upload.ts), the file
 * reader (lib/import-storage.ts db-upload://), the sniffer, the parser and
 * planner (lib/importers/attendance.ts) and the engine (lib/attendance-import.ts;
 * runStep / claimLease are wrapped in spies, not replaced).
 * Mocked: withTenantContext (hands over the in-memory fake in
 * import-attendance-route-fake.ts, which is NOT tenant-aware, so every tenant
 * boundary asserted here is the application-layer filter), audit log, rate
 * limit, apiError (no Sentry) and ensureTodayInstances (timetable sessions;
 * out of scope here).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { makeAttendanceFakeDb, type AttendanceFakeDb } from "./import-attendance-route-fake";

const h = vi.hoisted(() => ({
  session: null as unknown,
  db: null as unknown as AttendanceFakeDb,
  audit: [] as Record<string, unknown>[],
}));

vi.mock("@/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: never) => Promise<T>) => fn(h.db.tx),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: async (a: Record<string, unknown>) => { h.audit.push(a); } }));
vi.mock("@/lib/today-sessions", () => ({ ensureTodayInstances: async () => 0 }));
vi.mock("@/lib/api-error", async () => {
  const { NextResponse } = await import("next/server");
  return {
    apiError: (message: string, status: number, e?: unknown) => {
      if (e) console.error(e);
      return NextResponse.json({ ok: false, error: message }, { status });
    },
  };
});
vi.mock("@/lib/attendance-import", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/attendance-import")>();
  return { ...real, runStep: vi.fn(real.runStep), claimLease: vi.fn(real.claimLease) };
});

import { POST, GET, DELETE } from "@/app/api/admin/import/attendance/route";
import { GET as EXPORT } from "@/app/api/admin/import/attendance/export/route";
import { runStep, JOB_SOURCE, LEDGER_SOURCE } from "@/lib/attendance-import";
import { CHUNK_SIZE, hashToken } from "@/lib/import-upload";

// ── Fixtures ─────────────────────────────────────────────────────────────────

const ORIGIN = "http://localhost:3000";
const BASE = `${ORIGIN}/api/admin/import/attendance`;
const UPLOAD_TOKEN = "upload-token-SECRET-4f1c9e";
const OWNER = { id: "u-owner", tenantId: "t1", role: "owner" };
const OWNER_T2 = { id: "u-owner-t2", tenantId: "t2", role: "owner" };
const EXPORTED_LOCAL = "2026-10-01T10:00";

const ATT_HEADER =
  "Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Instructors,Booking Method,Customer Membership ID,Membership ID,Membership Name,Booking Source,Status,Checkin Timestamp";
const MEMBERSHIPS_HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date";

type AttRow = { name: string; email: string; start: string; offering: string; venue?: string; status: string };
const line = (r: AttRow) => [r.name, r.email, r.start, r.offering, r.venue ?? "Main Hall", "Coach A", "Online", "CM1", "M1", "Unlimited", "App", r.status, ""].join(",");
const csv = (rows: AttRow[]) => [ATT_HEADER, ...rows.map(line)].join("\r\n") + "\r\n";

/** Five rows: four bookings and one exact duplicate. Ada is a member of t1; Grace is not. */
const SMALL_ROWS: AttRow[] = [
  { name: "Ada Lovelace", email: "ada@example.com", start: "2025-10-04T09:00:00+01:00", offering: "Fundamentals", status: "Attended" },
  { name: "Ada Lovelace", email: "ada@example.com", start: "2025-10-11T09:00:00+01:00", offering: "Fundamentals", status: "Registered" },
  { name: "Grace Hopper", email: "grace@example.com", start: "2025-10-04T09:00:00+01:00", offering: "Fundamentals", status: "Attended" },
  { name: "Grace Hopper", email: "grace@example.com", start: "2025-10-05T10:00:00+01:00", offering: "Open Mat", status: "No Show" },
  { name: "Ada Lovelace", email: "ada@example.com", start: "2025-10-04T09:00:00+01:00", offering: "Fundamentals", status: "Attended" },
];
const SMALL_CSV = csv(SMALL_ROWS);

const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
let uploadSeq = 0;

function seedUpload(text: string, over: Record<string, unknown> = {}) {
  const bytes = Buffer.from(text, "utf8");
  const id = (over.id as string) ?? `up-${++uploadSeq}`;
  const tenantId = (over.tenantId as string) ?? "t1";
  h.db.seed("importUpload", {
    id, tenantId, createdById: OWNER.id, purpose: "attendance", fileName: "attendance.csv",
    expectedBytes: bytes.length, expectedSha256: sha(bytes), chunkSize: CHUNK_SIZE, chunkCount: 1,
    tokenHash: hashToken(UPLOAD_TOKEN), status: "complete", expiresAt: new Date(Date.now() + 3_600_000),
    completedAt: new Date(), createdAt: new Date(), ...over,
  });
  h.db.seed("importUploadChunk", { uploadId: id, tenantId, index: 0, bytes, sha256: sha(bytes) });
  return id;
}

function seedJob(over: Record<string, unknown> = {}) {
  return h.db.seed("importJob", {
    tenantId: "t1", createdById: OWNER.id, source: JOB_SOURCE, fileName: "attendance.csv", fileBlobUrl: "db-upload://gone",
    status: "preview", fileHash: "f".repeat(64), mappingVersion: "attendance@2026-10-03", createdAt: new Date("2026-10-01T00:00:00Z"),
    ...over,
  });
}

const upload = (id: string) => h.db.tables.importUpload.find((u) => u.id === id)!;
const job = (id: string) => h.db.tables.importJob.find((j) => j.id === id)!;

// ── Requests and responses ───────────────────────────────────────────────────

/** Every response body any test in this file received (checked at the end of the file). */
const seen: string[] = [];

/** Response JSON, read loosely: the assertions themselves are the type check. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Loose = Record<string, any>;
type Read = { status: number; text: string; bytes: Buffer; json: Loose };
async function read(res: Response): Promise<Read> {
  const bytes = Buffer.from(await res.arrayBuffer());
  const text = new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes);
  seen.push(text);
  let json: Loose = {};
  try { json = JSON.parse(text); } catch { /* CSV */ }
  return { status: res.status, text, bytes, json };
}

function postReq(body: unknown, headers: Record<string, string | null> = {}) {
  const hs: Record<string, string> = {};
  for (const [k, v] of Object.entries({ origin: ORIGIN, "content-type": "application/json", ...headers })) if (v !== null) hs[k] = v;
  return new Request(BASE, { method: "POST", headers: hs, body: JSON.stringify(body) });
}
const post = async (body: unknown, headers?: Record<string, string | null>) => read(await POST(postReq(body, headers)));
const get = async (query: string) => read(await GET(new Request(`${BASE}${query}`)));
const del = async (query: string, origin: string | null = ORIGIN) =>
  read(await DELETE(new Request(`${BASE}${query}`, { method: "DELETE", headers: origin ? { origin } : {} })));
const exportCsv = async (query: string) => read(await EXPORT(new Request(`${BASE}/export${query}`)));

const previewBody = (uploadId: string, extra: Record<string, unknown> = {}) => ({ action: "preview", uploadId, sourceExportedAtLocal: EXPORTED_LOCAL, ...extra });

const DECIDE_ALL = [
  { kind: "offering", sourceKey: "Fundamentals", action: "new_class" },
  { kind: "offering", sourceKey: "Open Mat", action: "new_class" },
  { kind: "venue", sourceKey: "Main Hall", action: "club" },
];

/** Preview the small file through the route; returns the 201 body. */
async function previewSmall() {
  const r = await post(previewBody(seedUpload(SMALL_CSV)));
  expect(r.status).toBe(201);
  return r.json as { jobId: string; planHash: string; summary: Loose };
}

/** Preview, then decide every offering and venue; returns the job and the committable planHash. */
async function previewAndDecideAll() {
  const p = await previewSmall();
  const d = await post({ action: "decide", jobId: p.jobId, decisions: DECIDE_ALL });
  expect(d.status).toBe(200);
  return { jobId: p.jobId, planHash: d.json.planHash as string };
}

beforeEach(() => {
  h.db = makeAttendanceFakeDb();
  h.session = { user: { ...OWNER } };
  h.audit = [];
  vi.mocked(runStep).mockClear();
  const db = h.db;
  db.seed("tenant", { id: "t1", timezone: "Europe/London" });
  db.seed("tenant", { id: "t2", timezone: "Europe/London" });
  db.seed("member", { id: "m1", tenantId: "t1", name: "Ada Lovelace", email: "ada@example.com" });
  // Grace exists only in the OTHER club: she must stay pending in t1.
  db.seed("member", { id: "m-t2", tenantId: "t2", name: "Grace Hopper", email: "grace@example.com" });
  db.seed("class", { id: "c-t2", tenantId: "t2", name: "Fundamentals" });
  db.seed("location", { id: "l1", tenantId: "t1", name: "Main Hall" });
  db.seed("location", { id: "l-t2", tenantId: "t2", name: "Main Hall" });
});

// ── 1. Auth matrix ───────────────────────────────────────────────────────────

const ENDPOINTS: [string, () => Promise<Response>][] = [
  ["POST preview", () => POST(postReq(previewBody("up-x")))],
  ["POST repreview", () => POST(postReq({ action: "repreview", jobId: "j" }))],
  ["POST decide", () => POST(postReq({ action: "decide", decisions: DECIDE_ALL }))],
  ["POST commit", () => POST(postReq({ action: "commit", jobId: "j", planHash: "x" }))],
  ["POST step", () => POST(postReq({ action: "step", jobId: "j" }))],
  ["POST discard", () => POST(postReq({ action: "discard", jobId: "j" }))],
  ["GET job status", () => GET(new Request(`${BASE}?jobId=j`))],
  ["GET latest=1", () => GET(new Request(`${BASE}?latest=1`))],
  ["GET list=people", () => GET(new Request(`${BASE}?jobId=j&list=people`))],
  ["DELETE rollback", () => DELETE(new Request(`${BASE}?jobId=j`, { method: "DELETE", headers: { origin: ORIGIN } }))],
  ["GET export", () => EXPORT(new Request(`${BASE}/export?jobId=j`))],
];

const SESSIONS: [string, unknown, number, string][] = [
  ["no session", null, 401, "Your session has expired"],
  ["a member", { user: { ...OWNER, role: "member" } }, 403, "You do not have permission"],
  ["a coach", { user: { ...OWNER, role: "coach" } }, 403, "You do not have permission"],
  ["a manager", { user: { ...OWNER, role: "manager" } }, 403, "You do not have permission"],
  ["an owner still owing the authenticator code", { user: { ...OWNER, totpPending: true } }, 403, "Enter your authenticator code"],
  ["an owner on a temporary password", { user: { ...OWNER, mustChangePassword: true } }, 403, "Choose your own password"],
];

describe("auth: every endpoint is owner-only, through the real requireApiOwner", () => {
  describe.each(ENDPOINTS)("%s", (_name, call) => {
    it.each(SESSIONS)("refuses %s", async (_who, session, status, message) => {
      h.session = session;
      const r = await read(await call());
      expect(r.status).toBe(status);
      expect(r.json.error).toContain(message);
      expect(h.db.writes).toEqual([]);
      expect(h.audit).toEqual([]);
    });
  });
});

// ── 2. Same origin ───────────────────────────────────────────────────────────

describe("same-origin guard", () => {
  it("the route calls assertSameOrigin(req) in both POST and DELETE", () => {
    const src = readFileSync(path.join(process.cwd(), "app/api/admin/import/attendance/route.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(src).toContain('from "@/lib/csrf"');
    expect(src.match(/assertSameOrigin\(\s*req\s*\)/g)?.length).toBe(2);
  });

  it.each(["preview", "repreview", "decide", "commit", "step", "discard"])("refuses a cross-origin POST %s without touching data", async (action) => {
    const id = seedUpload(SMALL_CSV);
    const r = await post({ ...previewBody(id), action, jobId: "j", planHash: "x", decisions: DECIDE_ALL }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(upload(id).status).toBe("complete");
    expect(h.db.tables.importJob).toHaveLength(0);
    expect(h.db.tables.importSourceMapping).toHaveLength(0);
  });

  it("refuses a POST carrying neither Origin nor Referer", async () => {
    const id = seedUpload(SMALL_CSV);
    const r = await post(previewBody(id), { origin: null });
    expect(r.status).toBe(403);
    expect(upload(id).status).toBe("complete");
  });

  it("refuses a POST whose Referer is another site", async () => {
    const id = seedUpload(SMALL_CSV);
    const r = await post(previewBody(id), { origin: null, referer: "https://evil.example/page" });
    expect(r.status).toBe(403);
    expect(upload(id).status).toBe("complete");
  });

  it("refuses a cross-origin discard and leaves the preview and its file in place", async () => {
    const id = seedUpload(SMALL_CSV);
    const j = seedJob({ status: "preview", fileBlobUrl: `db-upload://${id}` });
    const r = await post({ action: "discard", jobId: j.id }, { origin: "https://evil.example" });
    expect(r.status).toBe(403);
    expect(job(j.id).status).toBe("preview");
    expect(h.db.tables.importUpload.some((u) => u.id === id)).toBe(true);
    expect(h.db.writes).toEqual([]);
  });

  it("refuses a cross-origin DELETE and leaves the import in place", async () => {
    const j = seedJob({ status: "complete", completedAt: new Date() });
    const r = await del(`?jobId=${j.id}`, "https://evil.example");
    expect(r.status).toBe(403);
    expect(job(j.id).rolledBackAt).toBeNull();
    expect(h.db.writes).toEqual([]);
  });
});

// ── 3. Multipart ─────────────────────────────────────────────────────────────

describe("multipart POST", () => {
  it("answers 415 with the uploaded-in-parts instruction and creates no job", async () => {
    const form = new FormData();
    form.append("file", new Blob([SMALL_CSV], { type: "text/csv" }), "attendance.csv");
    form.append("action", "preview");
    const r = await read(await POST(new Request(BASE, { method: "POST", headers: { origin: ORIGIN }, body: form })));
    expect(r.status).toBe(415);
    expect(r.json.error).toContain("uploaded in parts");
    expect(h.db.tables.importJob).toHaveLength(0);
  });
});

// ── 4. Preview ───────────────────────────────────────────────────────────────

describe("preview: refusals", () => {
  it("400 when uploadId is missing", async () => {
    const r = await post({ action: "preview", sourceExportedAtLocal: EXPORTED_LOCAL });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe("Upload the file first.");
  });

  it("400 when the export time is missing, and the upload is not consumed", async () => {
    const id = seedUpload(SMALL_CSV);
    const r = await post({ action: "preview", uploadId: id });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("Enter when the TeamUp file was exported");
    expect(upload(id).status).toBe("complete");
  });

  it("400 when the export time is in the future", async () => {
    const id = seedUpload(SMALL_CSV);
    const r = await post({ action: "preview", uploadId: id, sourceExportedAt: new Date(Date.now() + 3_600_000).toISOString() });
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("not in the future");
    expect(upload(id).status).toBe("complete");
  });

  it("400 when the club wall-clock export time is not a date", async () => {
    const id = seedUpload(SMALL_CSV);
    const r = await post({ action: "preview", uploadId: id, sourceExportedAtLocal: "yesterday-ish" });
    expect(r.status).toBe(400);
    expect(upload(id).status).toBe("complete");
  });

  it("404 for another owner's upload in the same club, which stays unconsumed", async () => {
    const id = seedUpload(SMALL_CSV, { createdById: "u-someone-else" });
    const r = await post(previewBody(id));
    expect(r.status).toBe(404);
    expect(upload(id).status).toBe("complete");
    expect(h.db.tables.importJob).toHaveLength(0);
  });

  it("404 for an upload in another club, which stays unconsumed", async () => {
    const id = seedUpload(SMALL_CSV, { tenantId: "t2", createdById: OWNER_T2.id });
    const r = await post(previewBody(id));
    expect(r.status).toBe(404);
    expect(upload(id).status).toBe("complete");
    expect(h.db.tables.importJob).toHaveLength(0);
  });

  it("400 for an upload made for another purpose", async () => {
    const id = seedUpload(SMALL_CSV, { purpose: "members" });
    const r = await post(previewBody(id));
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("not made for the attendance import");
    expect(upload(id).status).toBe("complete");
  });

  it("409 for an upload that has not finished", async () => {
    const id = seedUpload(SMALL_CSV, { status: "open", completedAt: null });
    const r = await post(previewBody(id));
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("has not finished");
    expect(upload(id).status).toBe("open");
  });

  it("409 for an upload already consumed by another job", async () => {
    const id = seedUpload(SMALL_CSV, { status: "consumed" });
    const r = await post(previewBody(id));
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("already been used");
    expect(h.db.tables.importJob).toHaveLength(0);
  });

  it("410 for an expired upload, which stays unconsumed", async () => {
    const id = seedUpload(SMALL_CSV, { expiresAt: new Date(Date.now() - 1000) });
    const r = await post(previewBody(id));
    expect(r.status).toBe(410);
    expect(upload(id).status).toBe("complete");
  });

  it("409 when the stored bytes do not hash to the declared sha256, and nothing is consumed", async () => {
    const id = seedUpload(SMALL_CSV, { expectedSha256: "0".repeat(64) });
    const r = await post(previewBody(id));
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("did not arrive intact");
    expect(upload(id).status).toBe("complete");
    expect(h.db.tables.importJob).toHaveLength(0);
  });

  it("400 naming a TeamUp memberships export, and the upload is NOT consumed", async () => {
    const id = seedUpload(`${MEMBERSHIPS_HEADER}\r\nAda Lovelace,ada@example.com,No,Unlimited,Recurring,Active,Stripe,2025-01-01,2025-01-01,\r\n`);
    const r = await post(previewBody(id));
    expect(r.status).toBe(400);
    expect(r.json.error).toMatch(/^This is a TeamUp memberships export, not an attendance export/);
    expect(upload(id).status).toBe("complete");
    expect(h.db.tables.importJob).toHaveLength(0);
  });

  it("400 (bounded preview) for a file with more than 300 distinct offerings, and the upload is NOT consumed", async () => {
    const rows: AttRow[] = Array.from({ length: 301 }, (_, i) => ({
      name: "Ada Lovelace", email: "ada@example.com", start: "2025-10-04T09:00:00+01:00", offering: `Offering ${i}`, status: "Attended",
    }));
    const id = seedUpload(csv(rows));
    const r = await post(previewBody(id));
    expect(r.status).toBe(400);
    expect(r.json.error).toContain("301 different class names");
    expect(upload(id).status).toBe("complete");
    expect(h.db.tables.importJob).toHaveLength(0);
  });

  it("accepts a file with exactly 300 distinct offerings (the bound is inclusive)", async () => {
    const rows: AttRow[] = Array.from({ length: 300 }, (_, i) => ({
      name: "Ada Lovelace", email: "ada@example.com", start: "2025-10-04T09:00:00+01:00", offering: `Offering ${i}`, status: "Attended",
    }));
    const r = await post(previewBody(seedUpload(csv(rows))));
    expect(r.status).toBe(201);
  });
});

describe("preview: a valid attendance file", () => {
  it("answers 201 with a jobId and a 64-hex planHash", async () => {
    const r = await post(previewBody(seedUpload(SMALL_CSV)));
    expect(r.status).toBe(201);
    expect(typeof r.json.jobId).toBe("string");
    expect(r.json.planHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.json.status).toBe("preview");
  });

  it("returns a summary whose controls and byIntent reconcile with the file's rows", async () => {
    const { summary } = await previewSmall();
    const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);
    expect(summary.rows).toBe(5);
    expect(summary.controls.rows).toBe(5);
    expect(sum(summary.controls.byStatus)).toBe(5);
    expect(summary.bookings).toBe(4);
    expect(summary.duplicates).toBe(1);
    expect(summary.rejected).toBe(0);
    expect(sum(summary.byIntent)).toBe(summary.bookings);
    expect(summary.bookings + summary.duplicates + summary.rejected).toBe(summary.rows);
    expect(summary.reconciles).toBe(true);
  });

  it("matches people only against its own club's members", async () => {
    const { summary } = await previewSmall();
    // Ada matches m1 by name and email; Grace exists only in t2 and stays pending.
    expect(summary.people).toMatchObject({ total: 2, matched: 1, pending: 1 });
    expect(summary.people.pendingList.map((p: { name: string }) => p.name)).toEqual(["Grace Hopper"]);
    expect(JSON.stringify(summary)).not.toContain("m-t2");
  });

  it("offers only its own club's classes and locations as targets", async () => {
    const { summary } = await previewSmall();
    expect(summary.targets.classes).toEqual([]);
    expect(summary.targets.locations).toEqual([{ id: "l1", name: "Main Hall" }]);
  });

  it("consumes the upload", async () => {
    const id = seedUpload(SMALL_CSV);
    await post(previewBody(id));
    expect(upload(id).status).toBe("consumed");
  });

  it("stores the job against the upload as db-upload://<uploadId>", async () => {
    const id = seedUpload(SMALL_CSV);
    const r = await post(previewBody(id));
    expect(job(r.json.jobId).fileBlobUrl).toBe(`db-upload://${id}`);
    expect(job(r.json.jobId).tenantId).toBe("t1");
  });

  it("marks this club's earlier attendance previews superseded, and nothing else", async () => {
    const older = seedJob({ status: "preview" });
    const otherClub = seedJob({ tenantId: "t2", status: "preview" });
    const membersImport = seedJob({ source: "teamup", status: "preview" });
    const done = seedJob({ status: "complete" });
    const r = await post(previewBody(seedUpload(SMALL_CSV)));
    expect(job(older.id).status).toBe("superseded");
    expect(job(otherClub.id).status).toBe("preview");
    expect(job(membersImport.id).status).toBe("preview");
    expect(job(done.id).status).toBe("complete");
    expect(job(r.json.jobId).status).toBe("preview");
  });

  it("deletes the superseded preview's stored upload and its chunks", async () => {
    const oldUpload = seedUpload(SMALL_CSV);
    const older = seedJob({ status: "preview", fileBlobUrl: `db-upload://${oldUpload}` });
    const r = await post(previewBody(seedUpload(SMALL_CSV)));
    expect(r.status).toBe(201);
    expect(job(older.id).status).toBe("superseded");
    expect(h.db.tables.importUpload.some((u) => u.id === oldUpload)).toBe(false);
    expect(h.db.tables.importUploadChunk.some((c) => c.uploadId === oldUpload)).toBe(false);
  });

  it("keeps the new preview's own upload and chunks when it supersedes an earlier one", async () => {
    seedJob({ status: "preview", fileBlobUrl: `db-upload://${seedUpload(SMALL_CSV)}` });
    const id = seedUpload(SMALL_CSV);
    const r = await post(previewBody(id));
    expect(r.status).toBe(201);
    expect(upload(id).status).toBe("consumed");
    expect(h.db.tables.importUploadChunk.some((c) => c.uploadId === id)).toBe(true);
  });

  it("leaves another club's preview upload and chunks untouched when superseding", async () => {
    const t2Upload = seedUpload(SMALL_CSV, { tenantId: "t2", createdById: OWNER_T2.id });
    const t2Job = seedJob({ tenantId: "t2", createdById: OWNER_T2.id, status: "preview", fileBlobUrl: `db-upload://${t2Upload}` });
    expect((await post(previewBody(seedUpload(SMALL_CSV)))).status).toBe(201);
    expect(job(t2Job.id).status).toBe("preview");
    expect(upload(t2Upload).status).toBe("complete");
    expect(h.db.tables.importUploadChunk.filter((c) => c.uploadId === t2Upload)).toHaveLength(1);
  });

  it("does not delete another club's upload even when this club's stale preview points at its id", async () => {
    const t2Upload = seedUpload(SMALL_CSV, { tenantId: "t2", createdById: OWNER_T2.id });
    seedJob({ status: "preview", fileBlobUrl: `db-upload://${t2Upload}` });
    expect((await post(previewBody(seedUpload(SMALL_CSV)))).status).toBe(201);
    expect(h.db.tables.importUpload.some((u) => u.id === t2Upload)).toBe(true);
    expect(h.db.tables.importUploadChunk.filter((c) => c.uploadId === t2Upload)).toHaveLength(1);
  });

  it("does not delete the stored file of a completed import when a new preview arrives", async () => {
    const doneUpload = seedUpload(SMALL_CSV, { status: "consumed" });
    seedJob({ status: "complete", completedAt: new Date(), fileBlobUrl: `db-upload://${doneUpload}` });
    expect((await post(previewBody(seedUpload(SMALL_CSV)))).status).toBe(201);
    expect(h.db.tables.importUpload.some((u) => u.id === doneUpload)).toBe(true);
  });

  it("refuses a second preview of the same upload with 409", async () => {
    const id = seedUpload(SMALL_CSV);
    expect((await post(previewBody(id))).status).toBe(201);
    const again = await post(previewBody(id));
    expect(again.status).toBe(409);
    expect(h.db.tables.importJob).toHaveLength(1);
  });
});

// ── 5. Preview size ──────────────────────────────────────────────────────────

describe("preview: response size", () => {
  it("stays under 256 KB for a 15,000-row file", async () => {
    const offerings = ["Fundamentals", "Advanced", "No-Gi", "Open Mat", "Kids", "Competition"];
    const statuses = ["Attended", "Registered", "No Show", "Late Cancel"];
    const day0 = Date.UTC(2025, 0, 1);
    const rows: AttRow[] = [];
    for (let i = 0; i < 15_000; i++) {
      const p = i % 1500;
      const day = new Date(day0 + (i % 365) * 86_400_000).toISOString().slice(0, 10);
      const o = i % offerings.length;
      rows.push({
        name: `Person ${p}`, email: `person${p}@example.com`, start: `${day}T${String(9 + o).padStart(2, "0")}:00:00Z`,
        offering: offerings[o], venue: i % 2 ? "Main Hall" : "Annex", status: statuses[i % statuses.length],
      });
    }
    const r = await post(previewBody(seedUpload(csv(rows))));
    expect(r.status).toBe(201);
    expect(r.json.summary.rows).toBe(15_000);
    expect(r.json.summary.people.pendingListTruncated).toBe(true);
    expect(r.bytes.length).toBeLessThan(256 * 1024);
  });
});

// ── 6. Commit ────────────────────────────────────────────────────────────────

describe("commit", () => {
  it("409 stale for a wrong planHash", async () => {
    const { jobId } = await previewAndDecideAll();
    const r = await post({ action: "commit", jobId, planHash: "0".repeat(64) });
    expect(r.status).toBe(409);
    expect(r.json.stale).toBe(true);
    expect(job(jobId).status).toBe("preview");
  });

  it("409 stale for a missing planHash", async () => {
    const { jobId } = await previewAndDecideAll();
    const r = await post({ action: "commit", jobId });
    expect(r.status).toBe(409);
    expect(r.json.stale).toBe(true);
  });

  it("409 stale for the planHash of before the decisions", async () => {
    const p = await previewSmall();
    await post({ action: "decide", jobId: p.jobId, decisions: DECIDE_ALL });
    const r = await post({ action: "commit", jobId: p.jobId, planHash: p.planHash });
    expect(r.status).toBe(409);
    expect(r.json.stale).toBe(true);
  });

  it("409 naming every undecided offering and venue", async () => {
    const p = await previewSmall();
    const r = await post({ action: "commit", jobId: p.jobId, planHash: p.planHash });
    expect(r.status).toBe(409);
    expect(r.json.undecided).toEqual(['class for "Fundamentals"', 'class for "Open Mat"', 'venue "Main Hall"']);
    expect(r.json.error).toContain('venue "Main Hall"');
  });

  it("409 naming the venue when only the offerings are decided", async () => {
    const p = await previewSmall();
    const d = await post({ action: "decide", jobId: p.jobId, decisions: DECIDE_ALL.slice(0, 2) });
    const r = await post({ action: "commit", jobId: p.jobId, planHash: d.json.planHash });
    expect(r.status).toBe(409);
    expect(r.json.undecided).toEqual(['venue "Main Hall"']);
    expect(h.db.tables.class.filter((c) => c.tenantId === "t1")).toHaveLength(0);
  });

  it("409 for a job that is already complete", async () => {
    const j = seedJob({ status: "complete", completedAt: new Date() });
    const r = await post({ action: "commit", jobId: j.id, planHash: "x" });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("already complete");
  });

  it("409 for a job that was rolled back", async () => {
    const j = seedJob({ status: "complete", rolledBackAt: new Date() });
    const r = await post({ action: "commit", jobId: j.id, planHash: "x" });
    expect(r.status).toBe(409);
  });

  it("409 for a preview superseded by a newer file, even with its own planHash", async () => {
    const { jobId, planHash } = await previewAndDecideAll();
    expect((await post(previewBody(seedUpload(SMALL_CSV.replace("Registered", "Attended"))))).status).toBe(201);
    expect(job(jobId).status).toBe("superseded");
    const r = await post({ action: "commit", jobId, planHash });
    expect(r.status).toBe(409);
    expect(job(jobId).status).toBe("superseded");
    expect(h.db.tables.class.filter((c) => c.tenantId === "t1")).toHaveLength(0);
  });

  it("404 for another club's job", async () => {
    const j = seedJob({ tenantId: "t2", createdById: OWNER_T2.id });
    const r = await post({ action: "commit", jobId: j.id, planHash: "x" });
    expect(r.status).toBe(404);
    expect(job(j.id).status).toBe("preview");
  });

  it("409 busy while another tab holds the lease, creating nothing", async () => {
    const { jobId, planHash } = await previewAndDecideAll();
    Object.assign(job(jobId), { leaseUntil: new Date(Date.now() + 60_000), leaseToken: "other-tab" });
    const r = await post({ action: "commit", jobId, planHash });
    expect(r.status).toBe(409);
    expect(r.json.busy).toBe(true);
    expect(job(jobId).status).toBe("preview");
    expect(job(jobId).leaseToken).toBe("other-tab");
    expect(h.db.tables.class.filter((c) => c.tenantId === "t1")).toHaveLength(0);
  });

  it("of two simultaneous commits exactly one starts; the other is told busy", async () => {
    const { jobId, planHash } = await previewAndDecideAll();
    const [a, b] = await Promise.all([post({ action: "commit", jobId, planHash }), post({ action: "commit", jobId, planHash })]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect((a.status === 409 ? a : b).json.busy).toBe(true);
    // One historical class for the one offering with a resolved booking (Fundamentals), not one per commit.
    expect(h.db.tables.class.filter((c) => c.tenantId === "t1" && c.sourceImportJobId === jobId).map((c) => c.name)).toEqual(["Fundamentals"]);
  });

  it("202 and running for a decided, current preview", async () => {
    const { jobId, planHash } = await previewAndDecideAll();
    const r = await post({ action: "commit", jobId, planHash });
    expect(r.status).toBe(202);
    expect(r.json.job).toMatchObject({ id: jobId, status: "running", phase: "importing" });
  });
});

// ── 7. Step ──────────────────────────────────────────────────────────────────

describe("step", () => {
  it("404 for an unknown job", async () => {
    const r = await post({ action: "step", jobId: "nope" });
    expect(r.status).toBe(404);
    expect(runStep).not.toHaveBeenCalled();
  });

  it("404 for another club's job, without running a step", async () => {
    const j = seedJob({ tenantId: "t2", createdById: OWNER_T2.id, status: "running" });
    const r = await post({ action: "step", jobId: j.id });
    expect(r.status).toBe(404);
    expect(runStep).not.toHaveBeenCalled();
    expect(job(j.id).leaseToken).toBeNull();
  });

  it("done:true for a complete job without doing any work", async () => {
    const j = seedJob({ status: "complete", completedAt: new Date() });
    const r = await post({ action: "step", jobId: j.id });
    expect(r.status).toBe(200);
    expect(r.json.done).toBe(true);
    expect(runStep).not.toHaveBeenCalled();
    expect(h.db.writes).toEqual([]);
  });

  it("202 busy while another step holds the lease", async () => {
    const j = seedJob({ status: "running", leaseUntil: new Date(Date.now() + 60_000), leaseToken: "other-step", processedRows: 0 });
    const r = await post({ action: "step", jobId: j.id });
    expect(r.status).toBe(202);
    expect(r.json.busy).toBe(true);
    expect(job(j.id).leaseToken).toBe("other-step");
    expect(job(j.id).processedRows).toBe(0);
  });

  it("completes a started import, writing attendance only for the resolved member", async () => {
    const { jobId, planHash } = await previewAndDecideAll();
    expect((await post({ action: "commit", jobId, planHash })).status).toBe(202);
    const r = await post({ action: "step", jobId });
    expect(r.status).toBe(200);
    expect(r.json.done).toBe(true);
    expect(job(jobId).status).toBe("complete");
    expect(h.db.tables.attendanceRecord.map((a) => [a.memberId, a.checkInMethod, a.tenantId])).toEqual([["m1", "import", "t1"]]);
    expect(h.db.tables.importedBooking).toHaveLength(4);
    expect(h.db.tables.importedBooking.every((b) => b.tenantId === "t1" && b.source === LEDGER_SOURCE)).toBe(true);
  });
});

// ── 8. Decide ────────────────────────────────────────────────────────────────

describe("decide: targets must belong to this club", () => {
  it.each([
    ["member", { kind: "person", sourceKey: "teamup:grace@example.com|grace hopper", action: "member", targetId: "m-t2" }, "That member is not in this club."],
    ["class", { kind: "offering", sourceKey: "Fundamentals", action: "class", targetId: "c-t2" }, "That class is not in this club."],
    ["location", { kind: "venue", sourceKey: "Main Hall", action: "location", targetId: "l-t2" }, "That location is not in this club."],
  ])("refuses another club's %s with 400 and stores nothing", async (_k, decision, message) => {
    const r = await post({ action: "decide", decisions: [decision] });
    expect(r.status).toBe(400);
    expect(r.json.error).toBe(message);
    expect(h.db.tables.importSourceMapping).toHaveLength(0);
  });

  it("stores none of a batch when one decision in it targets another club", async () => {
    const r = await post({ action: "decide", decisions: [{ kind: "venue", sourceKey: "Main Hall", action: "location", targetId: "l1" }, { kind: "offering", sourceKey: "Fundamentals", action: "class", targetId: "c-t2" }] });
    expect(r.status).toBe(400);
    expect(h.db.tables.importSourceMapping).toHaveLength(0);
  });

  it("stores a decision whose target is in this club, under this club", async () => {
    const r = await post({ action: "decide", decisions: [{ kind: "venue", sourceKey: "Main Hall", action: "location", targetId: "l1" }] });
    expect(r.status).toBe(200);
    expect(h.db.tables.importSourceMapping).toMatchObject([{ tenantId: "t1", kind: "venue", sourceKey: "Main Hall", action: "location", targetId: "l1" }]);
  });
});

describe("decide: a jobId must name a current preview of this club", () => {
  it.each([
    ["superseded", { status: "superseded" }],
    ["complete", { status: "complete", completedAt: new Date() }],
    ["running", { status: "running" }],
    ["rolled back", { status: "complete", completedAt: new Date(), rolledBackAt: new Date() }],
    ["a preview that was rolled back", { status: "preview", rolledBackAt: new Date() }],
  ])("409 for a %s job, and no decision is stored", async (_label, over) => {
    const j = seedJob(over);
    const r = await post({ action: "decide", jobId: j.id, decisions: DECIDE_ALL });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("no longer current");
    expect(h.db.tables.importSourceMapping).toHaveLength(0);
    expect(h.audit).toEqual([]);
  });

  it("404 for another club's job, and no decision is stored", async () => {
    const j = seedJob({ tenantId: "t2", createdById: OWNER_T2.id, status: "preview" });
    const r = await post({ action: "decide", jobId: j.id, decisions: DECIDE_ALL });
    expect(r.status).toBe(404);
    expect(h.db.tables.importSourceMapping).toHaveLength(0);
    expect(h.audit).toEqual([]);
  });

  it("404 for an unknown jobId, and no decision is stored", async () => {
    const r = await post({ action: "decide", jobId: "nope", decisions: DECIDE_ALL });
    expect(r.status).toBe(404);
    expect(h.db.tables.importSourceMapping).toHaveLength(0);
  });
});

// ── Discard ──────────────────────────────────────────────────────────────────

describe("POST discard", () => {
  it("sets a preview aside as superseded and answers ok", async () => {
    const { jobId } = await previewSmall();
    const r = await post({ action: "discard", jobId });
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(job(jobId).status).toBe("superseded");
  });

  it("deletes the discarded preview's db-upload file and its chunks", async () => {
    const id = seedUpload(SMALL_CSV);
    const p = await post(previewBody(id));
    expect(p.status).toBe(201);
    await post({ action: "discard", jobId: p.json.jobId });
    expect(h.db.tables.importUpload.some((u) => u.id === id)).toBe(false);
    expect(h.db.tables.importUploadChunk.some((c) => c.uploadId === id)).toBe(false);
  });

  it("a discarded preview can no longer be committed", async () => {
    const { jobId, planHash } = await previewAndDecideAll();
    expect((await post({ action: "discard", jobId })).status).toBe(200);
    const r = await post({ action: "commit", jobId, planHash });
    expect(r.status).toBe(409);
    expect(h.db.tables.class.filter((c) => c.tenantId === "t1")).toHaveLength(0);
  });

  it.each([
    ["running", { status: "running" }],
    ["complete", { status: "complete", completedAt: new Date() }],
    ["superseded", { status: "superseded" }],
  ])("409 for a %s job, which keeps its status and its file", async (status, over) => {
    const id = seedUpload(SMALL_CSV, { status: "consumed" });
    const j = seedJob({ ...over, fileBlobUrl: `db-upload://${id}` });
    const r = await post({ action: "discard", jobId: j.id });
    expect(r.status).toBe(409);
    expect(r.json.error).toContain("Only a preview");
    expect(job(j.id).status).toBe(status);
    expect(h.db.tables.importUpload.some((u) => u.id === id)).toBe(true);
    expect(h.db.writes).toEqual([]);
  });

  it("404 for another club's preview, which stays a preview with its file", async () => {
    const id = seedUpload(SMALL_CSV, { tenantId: "t2", createdById: OWNER_T2.id });
    const j = seedJob({ tenantId: "t2", createdById: OWNER_T2.id, status: "preview", fileBlobUrl: `db-upload://${id}` });
    const r = await post({ action: "discard", jobId: j.id });
    expect(r.status).toBe(404);
    expect(job(j.id).status).toBe("preview");
    expect(upload(id).status).toBe("complete");
    expect(h.db.writes).toEqual([]);
  });

  it("404 for a members-import preview: discard only sets aside attendance jobs", async () => {
    const j = seedJob({ source: "teamup", status: "preview" });
    const r = await post({ action: "discard", jobId: j.id });
    expect(r.status).toBe(404);
    expect(job(j.id).status).toBe("preview");
  });

  it("404 without a jobId", async () => {
    const r = await post({ action: "discard" });
    expect(r.status).toBe(404);
    expect(h.db.writes).toEqual([]);
  });
});

// ── 9. People paging ─────────────────────────────────────────────────────────

describe("GET list=people paging", () => {
  async function previewPeople(n: number) {
    const rows: AttRow[] = Array.from({ length: n }, (_, i) => ({
      name: `Person ${String(i).padStart(3, "0")}`, email: `p${i}@example.com`, start: "2025-10-04T09:00:00+01:00", offering: "Fundamentals", status: "Attended",
    }));
    const r = await post(previewBody(seedUpload(csv(rows))));
    expect(r.status).toBe(201);
    return r.json.jobId as string;
  }

  it("caps limit at 200", async () => {
    const jobId = await previewPeople(250);
    const r = await get(`?jobId=${jobId}&list=people&limit=500`);
    expect(r.status).toBe(200);
    expect(r.json.total).toBe(250);
    expect(r.json.limit).toBe(200);
    expect(r.json.people).toHaveLength(200);
  });

  it("honours offset", async () => {
    const jobId = await previewPeople(250);
    const all = [
      ...(await get(`?jobId=${jobId}&list=people&limit=200`)).json.people,
      ...(await get(`?jobId=${jobId}&list=people&offset=200&limit=200`)).json.people,
    ].map((p: { personKey: string }) => p.personKey);
    const r = await get(`?jobId=${jobId}&list=people&offset=240&limit=50`);
    expect(r.json.offset).toBe(240);
    expect(r.json.people.map((p: { personKey: string }) => p.personKey)).toEqual(all.slice(240, 250));
  });

  it("404 for another club's job", async () => {
    const j = seedJob({ tenantId: "t2", createdById: OWNER_T2.id, fileBlobUrl: `db-upload://${seedUpload(SMALL_CSV, { tenantId: "t2", createdById: OWNER_T2.id })}` });
    const r = await get(`?jobId=${j.id}&list=people`);
    expect(r.status).toBe(404);
  });
});

// ── Reads and repreview across the tenant / source boundary ──────────────────

describe("job reads stay inside this club and this import", () => {
  it("GET status: 404 for another club's job", async () => {
    const j = seedJob({ tenantId: "t2", createdById: OWNER_T2.id });
    expect((await get(`?jobId=${j.id}`)).status).toBe(404);
  });

  it("GET latest=1 never returns another club's open import", async () => {
    seedJob({ tenantId: "t2", createdById: OWNER_T2.id, status: "running" });
    const r = await get("?latest=1");
    expect(r.status).toBe(200);
    expect(r.json.job).toBeNull();
  });

  it("repreview: 404 for another club's job", async () => {
    const j = seedJob({ tenantId: "t2", createdById: OWNER_T2.id, fileBlobUrl: `db-upload://${seedUpload(SMALL_CSV, { tenantId: "t2", createdById: OWNER_T2.id })}` });
    const r = await post({ action: "repreview", jobId: j.id });
    expect(r.status).toBe(404);
    expect(job(j.id).dryRunSummary).toBeNull();
  });

  it("a members-import job is not an attendance job: status, rollback and export all 404", async () => {
    const j = seedJob({ source: "teamup", status: "complete", completedAt: new Date() });
    expect((await get(`?jobId=${j.id}`)).status).toBe(404);
    expect((await del(`?jobId=${j.id}`)).status).toBe(404);
    expect((await exportCsv(`?jobId=${j.id}`)).status).toBe(404);
    expect(job(j.id).rolledBackAt).toBeNull();
  });

  it("preview: 400 for an unknown export-time provenance, and the upload is not consumed", async () => {
    const id = seedUpload(SMALL_CSV);
    const r = await post(previewBody(id, { sourceExportedAtProvenance: "guessed" }));
    expect(r.status).toBe(400);
    expect(upload(id).status).toBe("complete");
  });
});

// ── 10. Rollback ─────────────────────────────────────────────────────────────

describe("DELETE rollback", () => {
  it("409 for a job still in preview", async () => {
    const j = seedJob({ status: "preview" });
    const r = await del(`?jobId=${j.id}`);
    expect(r.status).toBe(409);
    expect(job(j.id).rolledBackAt).toBeNull();
  });

  it("409 for a job already rolled back", async () => {
    const at = new Date("2026-10-02T00:00:00Z");
    const j = seedJob({ status: "complete", rolledBackAt: at });
    const r = await del(`?jobId=${j.id}`);
    expect(r.status).toBe(409);
    expect(job(j.id).rolledBackAt).toEqual(at);
  });

  it("404 for another club's job, which is left alone", async () => {
    const j = seedJob({ tenantId: "t2", createdById: OWNER_T2.id, status: "complete", completedAt: new Date() });
    const r = await del(`?jobId=${j.id}`);
    expect(r.status).toBe(404);
    expect(job(j.id).rolledBackAt).toBeNull();
    expect(h.db.writes).toEqual([]);
  });

  it("409 busy while another attendance import of this club is running, and nothing changes", async () => {
    const j = seedJob({ status: "complete", completedAt: new Date() });
    const other = seedJob({ status: "running", processedRows: 3 });
    const r = await del(`?jobId=${j.id}`);
    expect(r.status).toBe(409);
    expect(r.json.busy).toBe(true);
    expect(r.json.error).toContain("Another attendance import is running");
    expect(job(j.id).rolledBackAt).toBeNull();
    expect(job(j.id).leaseToken).toBeNull();
    expect(job(other.id).status).toBe("running");
    expect(h.db.writes).toEqual([]);
    expect(h.audit).toEqual([]);
  });

  it("is not blocked by a running import in another club", async () => {
    const j = seedJob({ status: "complete", completedAt: new Date() });
    seedJob({ tenantId: "t2", createdById: OWNER_T2.id, status: "running" });
    const r = await del(`?jobId=${j.id}`);
    expect(r.status).toBe(200);
    expect(job(j.id).rolledBackAt).toBeInstanceOf(Date);
  });

  it("is not blocked by a running members import of this club", async () => {
    const j = seedJob({ status: "complete", completedAt: new Date() });
    seedJob({ source: "teamup", status: "running" });
    const r = await del(`?jobId=${j.id}`);
    expect(r.status).toBe(200);
    expect(job(j.id).rolledBackAt).toBeInstanceOf(Date);
  });
});

// ── 11. Export ───────────────────────────────────────────────────────────────

describe("export CSV", () => {
  const NAMES: [string, string][] = [
    ["=SUM(A1:A2)", "'=SUM(A1:A2)"],
    ["+44 7700 900123", "'+44 7700 900123"],
    ["@admin", "'@admin"],
    ["-Dash", "'-Dash"],
    ["Ada Lovelace", "Ada Lovelace"],
    ["O'Brien", "O'Brien"],
    ["Zoë Ångström", "Zoë Ångström"],
  ];

  function seedLedger() {
    const j = seedJob({ status: "complete", completedAt: new Date() });
    NAMES.forEach(([name], i) => {
      h.db.seed("importedBooking", {
        tenantId: "t1", source: LEDGER_SOURCE, bookingKey: `k${i}`.padEnd(64, "0"), startsAt: new Date(Date.UTC(2025, 9, 4 + i, 8)),
        startsAtRaw: "2025-10-04T09:00:00+01:00", offeringLabel: "Fundamentals", venueLabel: "Main Hall", rawStatus: "Attended",
        sourceName: name, sourceEmail: `row${i}@example.com`, bookingMethod: "Online", bookingSource: "App", customerMembershipRef: "CM1",
        membershipRef: "M1", membershipName: "Unlimited", checkinAtRaw: null, matchMethod: null, disposition: "pending_person",
        createdByJobId: j.id, lastJobId: j.id, memberId: null,
      });
    });
    return j;
  }

  it("starts with the UTF-8 byte-order mark", async () => {
    const r = await exportCsv(`?jobId=${seedLedger().id}`);
    expect(r.status).toBe(200);
    expect([...r.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  });

  it("uses CRLF line endings throughout", async () => {
    const r = await exportCsv(`?jobId=${seedLedger().id}`);
    expect(r.text).toContain("\r\n");
    expect(r.text.replace(/\r\n/g, "")).not.toMatch(/[\r\n]/);
  });

  it("has the header row first", async () => {
    const r = await exportCsv(`?jobId=${seedLedger().id}`);
    const header = r.text.replace(/^﻿/, "").split("\r\n")[0].split(",");
    expect(header.slice(0, 9)).toEqual([
      "Booking key", "Event Starts At (as exported)", "Club date", "Club time", "Offering", "Venue", "Status", "Customer Name", "Customer Email",
    ]);
    expect(header).toHaveLength(20);
  });

  it.each(NAMES)("writes the source name %j as %j", async (name, expected) => {
    const r = await exportCsv(`?jobId=${seedLedger().id}`);
    const rows = r.text.replace(/^﻿/, "").split("\r\n").slice(1).map((l) => l.split(","));
    const i = NAMES.findIndex(([n]) => n === name);
    const row = rows.find((cells) => cells[8] === `row${i}@example.com`)!;
    expect(row[7]).toBe(expected);
  });

  it("404 for another club's job", async () => {
    const j = seedJob({ tenantId: "t2", createdById: OWNER_T2.id, status: "complete" });
    const r = await exportCsv(`?jobId=${j.id}`);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain("Booking key");
  });
});

describe("export CSV in parts", () => {
  /** n ledger rows for one completed job; booking keys are distinct in their first 16 characters. */
  function seedLedgerRows(n: number) {
    const j = seedJob({ status: "complete", completedAt: new Date() });
    for (let i = 0; i < n; i++) {
      h.db.seed("importedBooking", {
        tenantId: "t1", source: LEDGER_SOURCE, bookingKey: `k${String(i).padStart(15, "0")}`.padEnd(64, "0"),
        startsAt: new Date(Date.UTC(2025, 0, 1, 8) + i * 60_000), startsAtRaw: "2025-01-01T08:00:00Z", offeringLabel: "Fundamentals",
        venueLabel: "Main Hall", rawStatus: "Attended", sourceName: `Person ${i}`, sourceEmail: `p${i}@example.com`, bookingMethod: "Online",
        bookingSource: "App", customerMembershipRef: "CM1", membershipRef: "M1", membershipName: "Unlimited", checkinAtRaw: null,
        matchMethod: null, disposition: "pending_person", createdByJobId: j.id, lastJobId: j.id, memberId: null,
      });
    }
    return j;
  }
  const dataLines = (r: Read) => r.text.replace(/^﻿/, "").split("\r\n").filter((l) => l !== "").slice(1);

  it("info=1 answers total, partSize 5000 and the number of parts", async () => {
    const j = seedLedgerRows(7);
    const r = await exportCsv(`?jobId=${j.id}&info=1`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ total: 7, partSize: 5000, parts: 1 });
  });

  it("info=1 for an import with no ledger rows still says one part", async () => {
    const j = seedJob({ status: "complete", completedAt: new Date() });
    const r = await exportCsv(`?jobId=${j.id}&info=1`);
    expect(r.json).toEqual({ total: 0, partSize: 5000, parts: 1 });
  });

  it("info=1 for another club's job is 404", async () => {
    const j = seedJob({ tenantId: "t2", createdById: OWNER_T2.id, status: "complete" });
    const r = await exportCsv(`?jobId=${j.id}&info=1`);
    expect(r.status).toBe(404);
    expect(r.json.total).toBeUndefined();
  });

  it.each(["0", "abc", "-1", "1.5"])("part=%s is refused with 400", async (part) => {
    const j = seedLedgerRows(3);
    const r = await exportCsv(`?jobId=${j.id}&part=${part}`);
    expect(r.status).toBe(400);
    expect(r.text).not.toContain("Booking key");
  });

  it("a part beyond the last is 404", async () => {
    const j = seedLedgerRows(3);
    const r = await exportCsv(`?jobId=${j.id}&part=2`);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain("Booking key");
  });

  describe("with 12,001 ledger rows", () => {
    let jobId = "";
    beforeEach(() => { jobId = seedLedgerRows(12_001).id; });

    it("info=1 says 3 parts of 5000", async () => {
      const r = await exportCsv(`?jobId=${jobId}&info=1`);
      expect(r.json).toEqual({ total: 12_001, partSize: 5000, parts: 3 });
    });

    it("part=1 holds at most 5000 data rows", async () => {
      const r = await exportCsv(`?jobId=${jobId}&part=1`);
      expect(r.status).toBe(200);
      expect(dataLines(r).length).toBeLessThanOrEqual(5000);
    });

    it("the three parts hold 5000 / 5000 / 2001 rows, each with the BOM and the header first", async () => {
      const counts: number[] = [];
      for (const part of [1, 2, 3]) {
        const r = await exportCsv(`?jobId=${jobId}&part=${part}`);
        expect(r.status).toBe(200);
        expect([...r.bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        expect(r.text.replace(/^﻿/, "").split("\r\n")[0]).toMatch(/^Booking key,Event Starts At \(as exported\),/);
        counts.push(dataLines(r).length);
      }
      expect(counts).toEqual([5000, 5000, 2001]);
    });

    it("the parts together hold every booking exactly once, in start order", async () => {
      const keys: string[] = [];
      for (const part of [1, 2, 3]) keys.push(...dataLines(await exportCsv(`?jobId=${jobId}&part=${part}`)).map((l) => l.split(",")[0]));
      expect(keys).toHaveLength(12_001);
      expect(new Set(keys).size).toBe(12_001);
      expect(keys).toEqual([...keys].sort());
    });

    it("names each part in the download file name", async () => {
      const res = await EXPORT(new Request(`${BASE}/export?jobId=${jobId}&part=2`));
      expect(res.headers.get("content-disposition")).toContain("-part-2-of-3.csv");
      await read(res);
    });

    it("part=4 is 404", async () => {
      expect((await exportCsv(`?jobId=${jobId}&part=4`)).status).toBe(404);
    });
  });
});

// ── 12. What a browser may see ───────────────────────────────────────────────

describe("no response carries the stored file's address or the upload token", () => {
  it("across a whole preview → decide → commit → step → read → export → rollback journey", async () => {
    const start = seen.length;
    const { jobId, planHash } = await previewAndDecideAll();
    await get(`?jobId=${jobId}`);
    await get("?latest=1");
    await get(`?jobId=${jobId}&list=people&state=all`);
    await post({ action: "repreview", jobId });
    expect((await post({ action: "commit", jobId, planHash })).status).toBe(202);
    await get("?latest=1");
    expect((await post({ action: "step", jobId })).json.done).toBe(true);
    await get(`?jobId=${jobId}`);
    expect((await exportCsv(`?jobId=${jobId}`)).status).toBe(200);
    const rb = await del(`?jobId=${jobId}`);
    expect(rb.status).toBe(200);
    await get(`?jobId=${jobId}`);
    const bodies = seen.slice(start).join("\n");
    expect(bodies).not.toContain("db-upload://");
    expect(bodies).not.toContain(UPLOAD_TOKEN);
    expect(bodies).not.toContain(hashToken(UPLOAD_TOKEN));
  });

  it("in any response this file received", () => {
    expect(seen.length).toBeGreaterThan(100);
    const all = seen.join("\n");
    expect(all).not.toContain("db-upload://");
    expect(all).not.toContain(UPLOAD_TOKEN);
    expect(all).not.toContain(hashToken(UPLOAD_TOKEN));
  });
});
