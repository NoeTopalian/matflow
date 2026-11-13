// Round 5 remediation (11 Nov 2026): after an erasure, rolling an import back or running it again must not bring the
// erased person's details back, in stored records, downloads or screens.
//
// Real routes end to end on the Neon TEST branch (both database roles): a TeamUp members file is stored in private
// Postgres upload storage (db-upload://), previewed and committed; the member it created is erased (DSAR); then
//   A. the import is rolled back;
//   B. the same job is committed again (a retry of the kept file), and a fresh job is previewed and committed from the
//      same kept file.
// After each, every stored record of the club is searched for her name and address (row_to_json over each table that
// holds import or member data, plus the kept file itself), and the job view, the exceptions download and the
// review list are read as the owner.
//
// Out of scope by design: re-uploading the ORIGINAL export from TeamUp re-adds her, because the source system still
// holds her (the owner must erase her there too). Synthetic clubs (r5x-), torn down here.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";

vi.mock("next/server", () => {
  class NR extends Response {
    static json(body: unknown, init?: { status?: number; headers?: Record<string, string> }) {
      return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
    }
  }
  return { NextRequest: class extends Request {}, NextResponse: NR };
});
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
const gate = vi.hoisted(() => ({ tenantId: "", userId: "" }));
const sessionOf = () => ({ user: { id: gate.userId, tenantId: gate.tenantId, role: "owner" } });
vi.mock("@/auth", () => ({ auth: vi.fn(async () => sessionOf()), signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock("@/lib/api-authz", async (importOriginal) => {
  const ok = async () => ({ ok: true, tenantId: gate.tenantId, userId: gate.userId, session: sessionOf() });
  return { ...(await importOriginal<typeof import("@/lib/api-authz")>()), requireApiOwner: vi.fn(ok), requireApiOwnerOrManager: vi.fn(ok), requireApiRole: vi.fn(ok) };
});

import { withRlsBypass } from "@/lib/prisma-tenant";
import { readImportFile } from "@/lib/import-storage";
import { POST as previewPOST } from "@/app/api/admin/import/[id]/preview/route";
import { POST as commitPOST } from "@/app/api/admin/import/[id]/commit/route";
import { POST as rollbackPOST } from "@/app/api/admin/import/[id]/rollback/route";
import { GET as jobGET } from "@/app/api/admin/import/[id]/route";
import { GET as exceptionsGET } from "@/app/api/admin/import/[id]/exceptions/route";
import { GET as conflictsGET } from "@/app/api/admin/import/[id]/conflicts/route";
import { POST as dsarErase } from "@/app/api/admin/dsar/erase/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r5x${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 300_000 });
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const ADA = { name: "Rfivex Ada Obi", email: `${STAMP}-ada@example.test` };
const BEN = { name: "Rfivex Ben Ray", email: `${STAMP}-ben@example.test` };
const PLAN = "Adult Unlimited";
const HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
const row = (p: { name: string; email: string }, status: string, phone: string) =>
  [p.name, p.email, "", PLAN, "recurring", status, "Stripe", "2026-01-05", "2026-01-05", "", "", "Yes", "", "", "", "", "", "", "GB", "", phone, "", "1990-01-01", "", "", ""].join(",");
// Ada is cancelled with no date: she also appears in the job's exception rows (name and address).
const CSV = [HEADER, row(ADA, "cancelled", "07700 900111"), row(BEN, "active", "07700 900222")].join("\n") + "\n";

/** Every table with a tenantId column (read from the catalogue, so a future table is searched too). */
const tenantTables = async () =>
  (await withRlsBypass((tx) => tx.$queryRaw<{ t: string }[]>`
    SELECT table_name AS t FROM information_schema.columns
     WHERE table_schema = current_schema() AND column_name = 'tenantId' ORDER BY table_name`)).map((r) => r.t);
// Her details as they could be stored: name, address, and the phone in the forms an import or a form writes.
const NEEDLES = [ADA.name, ADA.email, "07700 900111", "07700900111", "+447700900111"];

type Club = { tenantId: string; userId: string; fileUrl: string };
const clubs: Club[] = [];

async function mkClub(label: string): Promise<Club> {
  const csv = Buffer.from(CSV, "utf8");
  const club = await withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: "Europe/London", onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-${label}-owner@example.test`, name: "Owner", role: "owner", passwordHash: "x" } });
    await tx.membershipTier.create({ data: { tenantId: t.id, name: PLAN, pricePence: 8800, currency: "GBP", billingCycle: "monthly", isKids: false, isActive: true } });
    const up = await tx.importUpload.create({
      data: { tenantId: t.id, createdById: u.id, purpose: "members", fileName: "members.csv", expectedBytes: csv.length, expectedSha256: sha(csv), chunkSize: 1024 * 1024, chunkCount: 1, tokenHash: `${STAMP}-${label}-token`, status: "consumed", expiresAt: new Date(Date.now() + 86_400_000) },
    });
    await tx.importUploadChunk.create({ data: { uploadId: up.id, tenantId: t.id, index: 0, bytes: csv, sha256: sha(csv) } });
    return { tenantId: t.id, userId: u.id, fileUrl: `db-upload://${up.id}` };
  });
  clubs.push(club);
  return club;
}
const as = (club: Club) => { gate.tenantId = club.tenantId; gate.userId = club.userId; };
const post = (path: string) => new Request(`https://test.local/api/admin/import/${path}`, { method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: "{}" });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function newJob(club: Club, n: number) {
  return (await withRlsBypass((tx) => tx.importJob.create({
    data: { tenantId: club.tenantId, createdById: club.userId, source: "teamup", mode: "create", fileName: "members.csv", fileBlobUrl: club.fileUrl, status: "pending", fileHash: `${STAMP}-${club.tenantId}-${n}`, sourceExportedAt: new Date("2026-11-01T08:00:00Z"), sourceExportedAtProvenance: "owner_stated" },
    select: { id: true },
  }))).id;
}
async function previewAndCommit(club: Club, jobId: string) {
  as(club);
  const pv = await previewPOST(post(`${jobId}/preview`), ctx(jobId));
  expect(pv.status, await pv.clone().text()).toBe(200);
  const cm = await commitPOST(post(`${jobId}/commit`), ctx(jobId));
  return { status: cm.status, body: await cm.text() };
}
async function erase(club: Club, memberId: string) {
  as(club);
  const res = await dsarErase(new Request(`https://test.local/api/admin/dsar/erase?memberId=${memberId}`, { method: "POST", headers: { origin: "https://test.local", host: "test.local" } }));
  expect(res.status, await res.clone().text()).toBe(200);
}

/** Every place her details could survive: each table's rows (as JSON text), the kept file, and the three owner views. */
async function traces(club: Club, jobIds: string[]) {
  const found: string[] = [];
  const has = (text: string) => NEEDLES.some((n) => text.toLowerCase().includes(n.toLowerCase()));
  for (const table of await tenantTables()) {
    if (!/^[A-Za-z_]+$/.test(table)) continue;
    const rows = await withRlsBypass((tx) => tx.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM "${table}" t WHERE t."tenantId" = $1 AND row_to_json(t)::text ILIKE ANY ($2::text[])`,
      club.tenantId, NEEDLES.map((n) => `%${n}%`),
    ));
    if (rows[0].n > 0) found.push(`${table}: ${rows[0].n} row(s)`);
  }
  const file = (await readImportFile(club.fileUrl, club.tenantId)) ?? "";
  if (has(file)) found.push("kept import file");
  as(club);
  for (const id of jobIds) {
    for (const [label, res] of [
      ["job view", await jobGET(new Request(`https://test.local/api/admin/import/${id}`), ctx(id))],
      ["exceptions download", await exceptionsGET(new Request(`https://test.local/api/admin/import/${id}/exceptions`), ctx(id))],
      ["review list", await conflictsGET(new Request(`https://test.local/api/admin/import/${id}/conflicts`), ctx(id))],
    ] as const) {
      const text = await res.text();
      if (has(text)) found.push(`${label} (${id})`);
    }
  }
  return found;
}
const adaId = (club: Club) => withRlsBypass((tx) => tx.member.findFirst({ where: { tenantId: club.tenantId, email: ADA.email }, select: { id: true } })).then((m) => m?.id ?? null);
const benStillThere = (club: Club) => withRlsBypass((tx) => tx.member.count({ where: { tenantId: club.tenantId, email: BEN.email } }));

describe.skipIf(!HAS_DB)("erasure, then rollback or retry: her details do not come back", () => {
  let A: Club;
  let B: Club;
  beforeAll(async () => {
    A = await mkClub("a");
    B = await mkClub("b");
  });
  afterAll(async () => {
    for (const club of clubs) {
      await withRlsBypass(async (tx) => {
        const tenantId = club.tenantId;
        await tx.auditLog.deleteMany({ where: { tenantId } });
        await tx.importedMembership.deleteMany({ where: { tenantId } });
        await tx.importedBooking.deleteMany({ where: { tenantId } });
        await tx.importSourceMapping.deleteMany({ where: { tenantId } });
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
    }
  });

  it("A. import, erase, roll back: nothing of hers is stored, downloaded or shown; the rollback still runs", async () => {
    const job = await newJob(A, 1);
    expect((await previewAndCommit(A, job)).status).toBe(200);
    const ada = await adaId(A);
    expect(ada).toBeTruthy();
    expect((await traces(A, [job])).length, "her details are in the import before the erasure").toBeGreaterThan(0);

    await erase(A, ada!);
    expect(await traces(A, [job]), "after the erasure").toEqual([]);

    as(A);
    const rb = await rollbackPOST(post(`${job}/rollback`), ctx(job));
    expect(rb.status, await rb.clone().text()).toBe(200);
    expect(await traces(A, [job]), "after the rollback").toEqual([]);
    expect(await adaId(A)).toBeNull();
    expect(await benStillThere(A), "the rollback removed the member only this import created").toBe(0);
  });

  it("B. import, erase, retry the same job, then a new job from the kept file: she is not re-created and nothing of hers returns", async () => {
    const job = await newJob(B, 1);
    expect((await previewAndCommit(B, job)).status).toBe(200);
    await erase(B, (await adaId(B))!);

    // A run that stopped part-way and is resumed after the erasure (the commit route's resume path for a failed job):
    // it re-reads the kept file, which no longer holds her.
    await withRlsBypass((tx) => tx.importJob.update({ where: { id: job }, data: { status: "failed", completedAt: null } }));
    as(B);
    const retry = await commitPOST(post(`${job}/commit`), ctx(job));
    expect(retry.status, await retry.clone().text()).toBe(200);
    expect(await adaId(B)).toBeNull();
    expect(await traces(B, [job]), "after resuming the job").toEqual([]);

    // A second job from the same kept file. Its fileHash is synthetic, so the "this exact file was already imported"
    // guard does not stop it: the adversarial case, the import actually runs again.
    const again = await newJob(B, 2);
    const second = await previewAndCommit(B, again);
    expect(second.status, second.body).toBe(200);
    expect(await adaId(B)).toBeNull();
    expect(await benStillThere(B)).toBe(1); // Ben is matched, not duplicated
    expect(await traces(B, [job, again]), "after a new job from the kept file").toEqual([]);
  });
});
