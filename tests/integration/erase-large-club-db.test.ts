// A member's erasure in a big club stays inside its budgets (7 Nov 2026), on the real database.
//
// The erasure reads the club's address history, its import jobs and uploads, and its Activity log, then redacts the
// member's own Activity rows inside the erase transaction (lib/audit-redact.ts). Sized here at about 1,000 members
// and over 20,000 Activity rows, with an import job whose diagnostics name hundreds of people and a kept chunked
// upload. Every tenant transaction is cut at its budget (lib/prisma-tenant.ts, default 15 s) and the route answers
// 500 if one is; so a 200 here means every transaction stayed inside its budget, and the elapsed time is checked
// against a ceiling well inside a serverless function's limit. Only this member's rows change.
//
// Synthetic club only (slug elc-…), created here and removed in afterAll. Runs through the guarded runner on the
// TEST branch, as the owner role and as matflow_app; skips without a database.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { appendFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers(init?.headers) }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
const gate = vi.hoisted(() => ({ current: null as null | { tenantId: string; userId: string } }));
const sessionOf = () => (gate.current ? { user: { id: gate.current.userId, tenantId: gate.current.tenantId, role: "owner" } } : null);
vi.mock("@/auth", () => ({ auth: vi.fn(async () => sessionOf()), signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock("@/lib/api-authz", async (importOriginal) => {
  const ok = async () => {
    if (!gate.current) throw new Error("no club in scope");
    return { ok: true, tenantId: gate.current.tenantId, userId: gate.current.userId, session: sessionOf() };
  };
  return { ...(await importOriginal<typeof import("@/lib/api-authz")>()), requireApiOwner: vi.fn(ok), requireApiOwnerOrManager: vi.fn(ok), requireApiRole: vi.fn(ok) };
});

import { withRlsBypass } from "@/lib/prisma-tenant";
import { readImportFile } from "@/lib/import-storage";
import { emailDigest } from "@/lib/login-email";
import { POST as dsarErase } from "@/app/api/admin/dsar/erase/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `elc${Date.now().toString(36)}`;
const MEMBERS = 1000;
const ACTIVITY_ROWS = 20_000;
/** Far inside a serverless function's limit, measured end to end on the slowest link the suite runs on. */
const CEILING_MS = 120_000;
const addr = (i: number) => `${STAMP}-m${i}@example.test`;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const SUBJECT = 7;
const SUBJECT_PHONE = "07700 900777";

describe.skipIf(!HAS_DB)("an erasure in a club of about 1,000 members and 20,000+ Activity rows", () => {
  let tenantId = "";
  let userId = "";
  let ids: string[] = [];
  let subjectId = "";
  let fileUrl = "";
  let ownRows = 0;
  let otherRowsWithPersonalValues = 0;

  beforeAll(async () => {
    const t = await withRlsBypass((tx) => tx.tenant.create({ data: { name: `${STAMP} club`, slug: STAMP, timezone: "Europe/London", onboardingCompleted: true } }));
    tenantId = t.id;
    userId = (await withRlsBypass((tx) => tx.user.create({ data: { tenantId, email: `${STAMP}-owner@example.test`, name: "Elc Owner", role: "owner", passwordHash: "x" } }))).id;
    ids = Array.from({ length: MEMBERS }, () => randomUUID().replace(/-/g, "").slice(0, 25));
    await withRlsBypass((tx) =>
      tx.member.createMany({ data: ids.map((id, i) => ({ id, tenantId, name: `Elc Member ${i}`, email: addr(i), phone: i === SUBJECT ? SUBJECT_PHONE : null, status: "active" })) }),
      { timeout: 60_000 },
    );
    subjectId = ids[SUBJECT];

    // Activity: check-ins naming members (no personal values), staff edits with a phone change for every 20th member
    // (personal values), each member's earlier address, and kiosk rows keyed by an address (as before 6 Nov 2026).
    const at = (i: number) => new Date(Date.now() - (i + 1) * 60_000);
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < ACTIVITY_ROWS; i++) {
      const m = i % MEMBERS;
      rows.push({ tenantId, action: "attendance.self_checkin", entityType: "AttendanceRecord", entityId: randomUUID(), metadata: { memberId: ids[m], method: "self" }, createdAt: at(i) });
    }
    for (let m = 0; m < MEMBERS; m += 20) {
      rows.push({ tenantId, userId, action: "member.update", entityType: "Member", entityId: ids[m], metadata: { fields: ["phone"], source: "staff", changes: { phone: { from: "07700 900000", to: m === SUBJECT ? SUBJECT_PHONE : "07700 900001" } } }, createdAt: at(m) });
    }
    for (let m = 0; m < MEMBERS; m += 5) {
      rows.push({ tenantId, userId, action: "member.update", entityType: "Member", entityId: ids[m], metadata: { fields: ["email"], oldEmailSha256: emailDigest(`${STAMP}-old${m}@example.test`), newEmailSha256: emailDigest(addr(m)) }, createdAt: at(m + 1) });
    }
    for (let m = 0; m < 200; m++) rows.push({ tenantId, userId: null, action: "member.waiver.signed_via_kiosk", entityType: "Member", entityId: addr(m), metadata: { signerName: `Elc Member ${m}`, method: "kiosk_waiver_link" }, createdAt: at(m + 2) });
    // The subject's own rows: a staff phone edit, and a kiosk row under their address.
    rows.push({ tenantId, userId, action: "member.update", entityType: "Member", entityId: subjectId, metadata: { fields: ["phone"], source: "staff", changes: { phone: { from: "07700 900666", to: SUBJECT_PHONE } } }, createdAt: at(3) });
    for (let i = 0; i < rows.length; i += 1000) {
      const batch = rows.slice(i, i + 1000);
      await withRlsBypass((tx) => tx.auditLog.createMany({ data: batch as never }), { timeout: 60_000 });
    }
    // Rows that carry the subject's personal values: their phone edits, their kiosk row (signerName).
    ownRows = rows.filter((r) => (r.entityId === subjectId && (r.metadata as { changes?: unknown }).changes) || r.entityId === addr(SUBJECT)).length;
    otherRowsWithPersonalValues = rows.filter((r) => ((r.metadata as { changes?: unknown }).changes || r.action === "member.waiver.signed_via_kiosk") && r.entityId !== subjectId && r.entityId !== addr(SUBJECT)).length;

    // A kept import: a chunked upload naming every member, and a job whose diagnostics name hundreds of them.
    const csv = Buffer.from(["Customer Name,Customer Email,Phone", ...ids.map((_, i) => `Elc Member ${i},${addr(i)},`)].join("\n") + "\n", "utf8");
    await withRlsBypass(async (tx) => {
      const up = await tx.importUpload.create({
        data: { tenantId, createdById: userId, purpose: "attendance", fileName: "members.csv", expectedBytes: csv.length, expectedSha256: sha(csv), chunkSize: 1024 * 1024, chunkCount: 1, tokenHash: `${STAMP}-token`, status: "consumed", expiresAt: new Date(Date.now() + 86_400_000) },
      });
      await tx.importUploadChunk.create({ data: { uploadId: up.id, tenantId, index: 0, bytes: csv, sha256: sha(csv) } });
      const job = await tx.importJob.create({
        data: {
          tenantId, createdById: userId, source: "teamup", fileName: "members.csv", fileBlobUrl: `db-upload://${up.id}`, status: "complete",
          errorLog: ids.slice(0, 500).map((_, i) => ({ row: i + 2, reason: `Duplicate email ${addr(i)}` })),
        },
      });
      fileUrl = job.fileBlobUrl;
    }, { timeout: 60_000 });
  }, 600_000);

  afterAll(async () => {
    // Synthetic fixture only: removed by this test, never by the product.
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.importJob.deleteMany({ where: { tenantId } });
      await tx.importUploadChunk.deleteMany({ where: { tenantId } });
      await tx.importUpload.deleteMany({ where: { tenantId } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    }, { timeout: 120_000 });
  }, 300_000);

  it("erases one member inside every transaction budget and the ceiling; only their Activity rows and import rows change", async () => {
    const total = await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId } }));
    expect(total).toBeGreaterThan(ACTIVITY_ROWS);
    expect(await withRlsBypass((tx) => tx.member.count({ where: { tenantId } }))).toBe(MEMBERS);

    gate.current = { tenantId, userId };
    const started = Date.now();
    const res = (await dsarErase(new Request(`https://test.local/api/admin/dsar/erase?memberId=${subjectId}`, { method: "POST", headers: { origin: "https://test.local", host: "test.local" } }))) as unknown as {
      status: number;
      json: () => Promise<{ erased?: Record<string, number> }>;
    };
    const elapsedMs = Date.now() - started;
    if (process.env.MF_PROFILE_OUT) appendFileSync(process.env.MF_PROFILE_OUT, `${JSON.stringify({ label: "large-club", role: process.env.RLS_ENFORCED ? "matflow_app" : "owner", members: MEMBERS, activityRows: total, elapsedMs })}\n`);
    // A transaction past its budget is cut and the route answers 500: a 200 means every one stayed inside it.
    expect(res.status).toBe(200);
    expect(elapsedMs).toBeLessThan(CEILING_MS);
    const body = await res.json();
    expect(body.erased).toMatchObject({ importFilesRewritten: 1, importFileRowsRemoved: 1, auditRowsRedacted: ownRows });

    // Only the subject's rows were redacted; nobody else's personal values changed.
    const redacted = await withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId, metadata: { path: ["redactedForErasure"], equals: true } }, select: { entityId: true } }));
    expect(redacted).toHaveLength(ownRows);
    expect(redacted.every((r) => r.entityId === subjectId)).toBe(true);
    const othersIntact = await withRlsBypass((tx) =>
      tx.auditLog.count({ where: { tenantId, OR: [{ action: "member.waiver.signed_via_kiosk" }, { metadata: { path: ["source"], equals: "staff" } }], NOT: { entityId: subjectId } } }),
    );
    expect(othersIntact).toBe(otherRowsWithPersonalValues);
    expect(JSON.stringify(await withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId, entityId: subjectId }, select: { metadata: true } })))).not.toContain(SUBJECT_PHONE);

    // The kept file lost exactly the subject's row; everyone else's is there.
    const file = (await readImportFile(fileUrl, tenantId)) ?? "";
    expect(file).not.toContain(addr(SUBJECT));
    expect(file.split("\n").filter((l) => l.includes("@")).length).toBe(MEMBERS - 1);
  }, 600_000);
});
