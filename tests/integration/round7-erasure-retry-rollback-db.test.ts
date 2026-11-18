// Round 7 (13 Nov 2026), R7-10: an erasure, then the import job is retried or rolled back. No personal data of the
// erased person may come back.
//
// Import files are kept (6 Nov 2026), so a retry of an interrupted job re-reads the stored file. The erasure rewrites
// that file without the subject's rows (lib/importers/import-erasure.ts); this proves it on the paths that READ the
// file afterwards: a resumed commit, and a rollback. Real file storage (db-upload://, private Postgres chunks), real
// commit, erasure and rollback routes, real Postgres (Neon TEST branch), both roles. Synthetic club, torn down.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers(init?.headers) }) },
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
const fault = vi.hoisted(() => ({ failOnCall: 0, calls: 0 }));
vi.mock("@/lib/member-status", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/member-status")>();
  return {
    ...real,
    recordStatusEventsBulk: async (...args: Parameters<typeof real.recordStatusEventsBulk>) => {
      fault.calls += 1;
      if (fault.failOnCall && fault.calls === fault.failOnCall) throw new Error("injected: the run stops here");
      return real.recordStatusEventsBulk(...args);
    },
  };
});

import { withRlsBypass } from "@/lib/prisma-tenant";
import { readImportFile } from "@/lib/import-storage";
import { POST as commit } from "@/app/api/admin/import/[id]/commit/route";
import { POST as rollbackPOST } from "@/app/api/admin/import/[id]/rollback/route";
import { POST as dsarErase } from "@/app/api/admin/dsar/erase/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r7e${Date.now().toString(36)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
vi.setConfig({ testTimeout: 300_000 });

const T_HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
const PLAN = "Beginners 2026";
const tRow = (name: string, email: string, phone: string) =>
  [name, email, "", PLAN, "recurring", "active", "Stripe", "2026-01-05", "2026-01-05", "", "", "Yes", "", "", "", "", "", "", "GB", "", phone, "", "1990-01-01", "", "", ""].join(",");

describe.skipIf(!HAS_DB)("erasure, then the import is retried or rolled back: nothing of the erased person comes back", () => {
  let tenantId = "";
  let userId = "";
  let seq = 0;

  /** A members import job whose file lives in private Postgres chunks (as a real upload does). */
  async function storedJob(csvText: string) {
    const csv = Buffer.from(csvText, "utf8");
    const n = ++seq;
    return withRlsBypass(async (tx) => {
      const up = await tx.importUpload.create({
        data: { tenantId, createdById: userId, purpose: "members", fileName: `m${n}.csv`, expectedBytes: csv.length, expectedSha256: sha(csv), chunkSize: 1024 * 1024, chunkCount: 1, tokenHash: `${STAMP}-token-${n}`, status: "consumed", expiresAt: new Date(Date.now() + 86_400_000) },
      });
      await tx.importUploadChunk.create({ data: { uploadId: up.id, tenantId, index: 0, bytes: csv, sha256: sha(csv) } });
      return tx.importJob.create({
        data: { tenantId, createdById: userId, source: "teamup", mode: "create", fileName: `m${n}.csv`, fileBlobUrl: `db-upload://${up.id}`, status: "preview", fileHash: `${STAMP}-${n}`, sourceExportedAt: new Date(Date.UTC(2026, 10, 1 + n, 8)), sourceExportedAtProvenance: "owner_stated" },
      });
    });
  }
  const post = (jobId: string, path: "commit" | "rollback") => {
    const req = new Request(`https://test.local/api/admin/import/${jobId}/${path}`, { method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: "{}" });
    return (path === "commit" ? commit : rollbackPOST)(req, { params: Promise.resolve({ id: jobId }) }) as unknown as Promise<{ status: number; json: () => Promise<Record<string, unknown>> }>;
  };
  const erase = async (memberId: string) =>
    (await dsarErase(new Request(`https://test.local/api/admin/dsar/erase?memberId=${memberId}`, { method: "POST", headers: { origin: "https://test.local", host: "test.local" } }))) as unknown as { status: number };
  /** Anything in the club still carrying the subject's name, address or phone. */
  async function traces(name: string, email: string, phone: string) {
    return withRlsBypass(async (tx) => {
      const members = await tx.member.count({ where: { tenantId, OR: [{ email }, { name }, { phone }] } });
      const ledger = await tx.importedMembership.findMany({ where: { tenantId }, select: { planLabel: true, status: true } });
      const jobs = await tx.importJob.findMany({ where: { tenantId }, select: { errorLog: true, dryRunSummary: true, manifest: true } });
      const blob = JSON.stringify({ ledger, jobs });
      return { members, inDiagnostics: [name, email, phone].some((v) => blob.includes(v)) };
    });
  }

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`, timezone: "Europe/London", onboardingCompleted: true } })).id;
      userId = (await tx.user.create({ data: { tenantId, email: E("owner"), name: "Owner", role: "owner", passwordHash: "x" } })).id;
      await tx.membershipTier.create({ data: { tenantId, name: PLAN, pricePence: 8800, currency: "GBP", billingCycle: "monthly", isKids: false, isActive: true } });
    });
    gate.current = { tenantId, userId };
  }, 120_000);

  afterAll(async () => {
    gate.current = null;
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.importedMembership.deleteMany({ where: { tenantId } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId, parentMemberId: { not: null } } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.importJob.deleteMany({ where: { tenantId } });
      await tx.importUploadChunk.deleteMany({ where: { tenantId } });
      await tx.importUpload.deleteMany({ where: { tenantId } });
      await tx.membershipTier.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  }, 120_000);

  it("an interrupted import, the first person erased, then the import run again: the erased person is not created again", async () => {
    const zed = { name: "Zed Erased Ward", email: E("zed"), phone: "07700900777" };
    const rows = [tRow(zed.name, zed.email, zed.phone), ...Array.from({ length: 29 }, (_, i) => tRow(`Keep ${i + 1}`, E(`keep${i + 1}`), ""))];
    const j = await storedJob([T_HEADER, ...rows].join("\n"));
    fault.calls = 0;
    fault.failOnCall = 2; // the second slice fails: the first 25 (Zed among them) are written, the run stops
    expect((await post(j.id, "commit")).status).not.toBe(200);
    fault.failOnCall = 0;
    const zedRow = await withRlsBypass((tx) => tx.member.findFirstOrThrow({ where: { tenantId, email: zed.email }, select: { id: true } }));

    expect((await erase(zedRow.id)).status).toBe(200);
    const file = (await readImportFile(j.fileBlobUrl, tenantId)) ?? "";
    expect(file).not.toContain(zed.email);

    const again = await post(j.id, "commit");
    expect(again.status).toBe(200);
    expect(await traces(zed.name, zed.email, zed.phone)).toEqual({ members: 0, inDiagnostics: false });
    // Everyone else is there once.
    expect(await withRlsBypass((tx) => tx.member.count({ where: { tenantId, email: { startsWith: `${STAMP}-keep` } } }))).toBe(29);
    // Review P2: the job adds up over the file as it now is (the erased person counted apart), and everyone it
    // created has their history linked (review P1), even after the erasure renumbered the stored file's rows.
    const after = await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: j.id }, select: { manifest: true, importedRows: true } }));
    expect(after.manifest).toMatchObject({ reconciles: true, erasedSinceImport: 1, created: { total: 29 } });
    expect(after.importedRows).toBe(29);
    expect(await withRlsBypass((tx) => tx.importedMembership.count({ where: { tenantId, importJobId: j.id, memberId: null } }))).toBe(0);
  });

  it("an import, one person erased, then the import rolled back: nothing of the erased person comes back, the others are removed", async () => {
    const yan = { name: "Yan Erased Cole", email: E("yan"), phone: "07700900666" };
    const j = await storedJob([T_HEADER, tRow(yan.name, yan.email, yan.phone), tRow("Other One", E("other1"), ""), tRow("Other Two", E("other2"), "")].join("\n"));
    expect((await post(j.id, "commit")).status).toBe(200);
    const yanRow = await withRlsBypass((tx) => tx.member.findFirstOrThrow({ where: { tenantId, email: yan.email }, select: { id: true } }));
    // A later upload names Yan with a different phone: that job lists Yan for review, so job diagnostics now really
    // hold Yan's name (review P4: the erasure must have something to scrub).
    const later = await storedJob([T_HEADER, tRow(yan.name, yan.email, "07700900665")].join("\n"));
    expect((await post(later.id, "commit")).status).toBe(200);
    const listed = await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: later.id }, select: { manifest: true } }));
    expect(JSON.stringify(listed.manifest)).toContain(yan.name);
    expect((await erase(yanRow.id)).status).toBe(200);

    const rb = await post(j.id, "rollback");
    expect(rb.status).toBe(200);
    expect(await traces(yan.name, yan.email, yan.phone)).toEqual({ members: 0, inDiagnostics: false });
    expect(await withRlsBypass((tx) => tx.member.count({ where: { tenantId, email: { in: [E("other1"), E("other2")] } } }))).toBe(0);
  });
});
