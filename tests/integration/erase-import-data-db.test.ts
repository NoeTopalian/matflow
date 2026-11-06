// A member's erasure reaches the import data MatFlow keeps (6 Nov 2026), on the real database.
//
// Import files and their diagnostics are no longer deleted after 30 days, so the erasure
// (app/api/admin/dsar/erase) must take the subject out of them: the stored file is rewritten
// without their rows, and every entry naming them leaves ImportJob.errorLog and dryRunSummary,
// name-only entries included. Another member's rows and entries stay.
//
// Since Activity is kept permanently, the erasure also redacts the personal values in the subject's own
// audit rows (M1): a staff edit's before/after phone and name are gone, the field names and actor columns stay.
// A member whose address changed after the import is still found in the file through the digest the edit
// recorded (L2), with no source key to help; a member's OWN edit (member.self_update) counts the same.
// The kiosk waiver row names the member by id (6 Nov 2026); rows written before that hold the address as their
// entity id, and the erasure repoints and redacts the ones keyed by the subject's current or earlier address.
//
// The file is a real chunked upload (db-upload://, private Postgres storage). Synthetic club only
// (slug erim-…), created here and removed in afterAll. Runs through the guarded runner on the TEST
// branch, as the owner role and as matflow_app; skips without a database.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";

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
import { POST as dsarErase } from "@/app/api/admin/dsar/erase/route";
import { PATCH as patchMember } from "@/app/api/members/[id]/route";
import { POST as kioskSign } from "@/app/api/waiver/open/route";
import { hashToken } from "@/lib/token-hash";
import { emailDigest } from "@/lib/login-email";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `erim${Date.now().toString(36)}`;
const ADA = { name: "Erim Ada Obi", email: `${STAMP}-ada@example.test` };
const BEN = { name: "Erim Ben Ray", email: `${STAMP}-ben@example.test` };
const CARA = { name: "Erim Cara Lee", email: `${STAMP}-cara@example.test`, phone: "07700 900333", newName: "Erim Cara Lee-Hart", newEmail: `${STAMP}-cara.new@example.test`, newPhone: "07700 900444" };
const DEE = { name: "Erim Dee Moss", email: `${STAMP}-dee@example.test`, newName: "Erim Dee Moss-Kay", newEmail: `${STAMP}-dee.new@example.test` };
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const KIOSK = "member.waiver.signed_via_kiosk";

describe.skipIf(!HAS_DB)("erasure reaches kept import files and diagnostics", () => {
  let tenantId = "";
  let userId = "";
  let adaId = "";
  let caraId = "";
  let benId = "";
  let deeId = "";
  let jobId = "";
  let fileUrl = "";

  beforeAll(async () => {
    const csv = Buffer.from(`Customer Name,Customer Email,Phone\n${ADA.name},${ADA.email},07700 900111\n${BEN.name},${BEN.email},07700 900222\n${CARA.name},${CARA.email},${CARA.phone}\n${DEE.name},${DEE.email},07700 900555\n`, "utf8");
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: STAMP, timezone: "Europe/London", onboardingCompleted: true } });
      const u = await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-owner@example.test`, name: "Erim Owner", role: "owner", passwordHash: "x" } });
      const ada = await tx.member.create({ data: { tenantId: t.id, name: ADA.name, email: ADA.email, externalRef: `teamup:${ADA.email}|${ADA.name.toLowerCase()}` } });
      benId = (await tx.member.create({ data: { tenantId: t.id, name: BEN.name, email: BEN.email } })).id;
      deeId = (await tx.member.create({ data: { tenantId: t.id, name: DEE.name, email: DEE.email } })).id;
      // No source key: only the digest of the old address can tie her to her import row once it changes.
      const cara = await tx.member.create({ data: { tenantId: t.id, name: CARA.name, email: CARA.email, phone: CARA.phone } });
      caraId = cara.id;
      const up = await tx.importUpload.create({
        data: { tenantId: t.id, createdById: u.id, purpose: "attendance", fileName: "members.csv", expectedBytes: csv.length, expectedSha256: sha(csv), chunkSize: 1024 * 1024, chunkCount: 1, tokenHash: `${STAMP}-token`, status: "consumed", expiresAt: new Date(Date.now() + 86_400_000) },
      });
      await tx.importUploadChunk.create({ data: { uploadId: up.id, tenantId: t.id, index: 0, bytes: csv, sha256: sha(csv) } });
      const job = await tx.importJob.create({
        data: {
          tenantId: t.id, createdById: u.id, source: "teamup", fileName: "members.csv", fileBlobUrl: `db-upload://${up.id}`, status: "complete",
          errorLog: [{ row: 2, reason: `Duplicate email ${ADA.email}` }, { row: 3, reason: "Missing plan" }],
          dryRunSummary: { drafts: [{ name: ADA.name, phone: "07700 900111" }, { name: BEN.name, phone: "07700 900222" }] },
        },
      });
      tenantId = t.id;
      userId = u.id;
      adaId = ada.id;
      jobId = job.id;
      fileUrl = job.fileBlobUrl;
    });
  });

  afterAll(async () => {
    // Synthetic fixture only: removed by this test, never by the product.
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.importJob.deleteMany({ where: { tenantId } });
      await tx.importUploadChunk.deleteMany({ where: { tenantId } });
      await tx.importUpload.deleteMany({ where: { tenantId } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
      await tx.signedWaiver.deleteMany({ where: { tenantId } });
      await tx.magicLinkToken.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  it("import, then erase: neither the file nor the diagnostics hold the subject's email or name; the other member's stay", async () => {
    expect(await readImportFile(fileUrl, tenantId)).toContain(ADA.email);

    gate.current = { tenantId, userId };
    const res = (await dsarErase(new Request(`https://test.local/api/admin/dsar/erase?memberId=${adaId}`, { method: "POST", headers: { origin: "https://test.local", host: "test.local" } }))) as unknown as { status: number; json: () => Promise<{ erased?: Record<string, number> }> };
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.erased).toMatchObject({ importFilesRewritten: 1, importFileRowsRemoved: 1 });
    expect(body.erased?.importDiagnosticsEntriesRemoved).toBeGreaterThanOrEqual(2);

    const file = (await readImportFile(fileUrl, tenantId)) ?? "";
    expect(file).not.toContain(ADA.email);
    expect(file).not.toContain(ADA.name);
    expect(file).toContain(BEN.email);
    expect(file.startsWith("Customer Name,Customer Email,Phone\n")).toBe(true);

    const job = await withRlsBypass((tx) => tx.importJob.findUnique({ where: { id: jobId }, select: { errorLog: true, dryRunSummary: true } }));
    const diagnostics = JSON.stringify(job);
    expect(diagnostics).not.toContain(ADA.email);
    expect(diagnostics).not.toContain(ADA.name);
    expect(diagnostics).toContain(BEN.name);

    const evidence = await withRlsBypass((tx) => tx.auditLog.findFirst({ where: { tenantId, action: "member.dsar_erase", entityId: adaId }, select: { metadata: true } }));
    expect((evidence?.metadata as { erasedCounts?: Record<string, number> })?.erasedCounts).toMatchObject({ importFilesRewritten: 1, importFileRowsRemoved: 1 });
  }, 120_000);

  it("a staff edit, then erase: no Activity row about the member holds the old or new phone, name or address; field names and actors stay; the import row is found by the old address", async () => {
    gate.current = { tenantId, userId };
    const headers = { origin: "https://test.local", host: "test.local", "content-type": "application/json" };
    // Kiosk waiver rows as written before 6 Nov 2026, keyed by the address: hers under the address she had then
    // (earlier, after the edit below) and under the one she has now, and Ben's, which must be left alone.
    const legacyKiosk = (entityId: string, signerName: string) =>
      withRlsBypass((tx) => tx.auditLog.create({ data: { tenantId, userId: null, action: KIOSK, entityType: "Member", entityId, metadata: { signerName, method: "kiosk_waiver_link" } } }));
    await legacyKiosk(CARA.email, CARA.name);
    const bens = await legacyKiosk(BEN.email, BEN.name);
    const edit = (await patchMember(
      new Request(`https://test.local/api/members/${caraId}`, { method: "PATCH", headers, body: JSON.stringify({ name: CARA.newName, phone: CARA.newPhone, email: CARA.newEmail }) }),
      { params: Promise.resolve({ id: caraId }) },
    )) as unknown as { status: number };
    expect(edit.status).toBe(200);
    const aboutCara = { tenantId, OR: [{ entityId: caraId }, { metadata: { path: ["memberId"], equals: caraId } }] };
    const before = await withRlsBypass((tx) => tx.auditLog.findMany({ where: aboutCara }));
    expect(JSON.stringify(before)).toContain("07700"); // the edit recorded the phone, so the redaction has something to remove
    // What the erasure will rely on: the edit took, it recorded the old address's digest and the old name, and her
    // import row is still in the file under the old name and address.
    const edited = await withRlsBypass((tx) => tx.member.findUnique({ where: { id: caraId }, select: { name: true, email: true } }));
    expect(edited).toEqual({ name: CARA.newName, email: CARA.newEmail });
    const editMeta = before.find((r) => r.action === "member.update")?.metadata as { oldEmailSha256?: string; changes?: { name?: { from?: string } } } | undefined;
    expect(typeof editMeta?.oldEmailSha256).toBe("string");
    expect(editMeta?.changes?.name?.from).toBe(CARA.name);
    expect(await readImportFile(fileUrl, tenantId)).toContain(`${CARA.name},${CARA.email},`);
    await legacyKiosk(CARA.newEmail, CARA.newName);

    const res = (await dsarErase(new Request(`https://test.local/api/admin/dsar/erase?memberId=${caraId}`, { method: "POST", headers }))) as unknown as { status: number; json: () => Promise<{ erased?: Record<string, number> }> };
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.erased?.auditRowsRedacted).toBeGreaterThanOrEqual(1);
    expect(body.erased).toMatchObject({ importFilesRewritten: 1, importFileRowsRemoved: 1, importNameOnlyRowsLeft: 0 });

    const rows = await withRlsBypass((tx) => tx.auditLog.findMany({ where: aboutCara }));
    const all = JSON.stringify(rows);
    for (const personal of [CARA.phone, CARA.newPhone, CARA.name, CARA.newName, CARA.email, CARA.newEmail]) expect(all, personal).not.toContain(personal);

    const update = rows.find((r) => r.action === "member.update");
    expect(update?.userId).toBe(userId); // actor column untouched
    expect(update?.entityId).toBe(caraId);
    const changes = (update?.metadata as { changes?: Record<string, { from: unknown; to: unknown }> }).changes ?? {};
    expect(changes.phone).toEqual({ from: null, to: null });
    expect(changes.name).toEqual({ from: null, to: null });
    expect((update?.metadata as { redactedForErasure?: boolean }).redactedForErasure).toBe(true);

    // Both address-keyed kiosk rows of hers now name her by id, with the signer's name gone; nothing in the club is
    // keyed by either of her addresses; Ben's row is exactly as it was.
    const kiosk = rows.filter((r) => r.action === KIOSK);
    expect(kiosk).toHaveLength(2);
    for (const k of kiosk) expect(k.metadata).toMatchObject({ signerName: null, method: "kiosk_waiver_link", redactedForErasure: true });
    expect(await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId, entityId: { in: [CARA.email, CARA.newEmail] } } }))).toBe(0);
    const bensAfter = await withRlsBypass((tx) => tx.auditLog.findUnique({ where: { id: bens.id } }));
    expect(bensAfter).toMatchObject({ entityId: BEN.email, metadata: { signerName: BEN.name, method: "kiosk_waiver_link" } });

    const file = (await readImportFile(fileUrl, tenantId)) ?? "";
    expect(file).not.toContain(CARA.email);
    expect(file).not.toContain(CARA.name);
    expect(file).toContain(BEN.email);
  }, 120_000);

  it("a kiosk waiver signing is logged against the member's id, never their address", async () => {
    const raw = `${STAMP}-kiosk-waiver-token-0123456789`;
    await withRlsBypass((tx) =>
      tx.magicLinkToken.create({ data: { tenantId, email: BEN.email, tokenHash: hashToken(raw), purpose: "waiver_open", expiresAt: new Date(Date.now() + 3_600_000) } }),
    );
    const res = (await kioskSign(
      new Request("https://test.local/api/waiver/open", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: raw, signerName: BEN.name }) }),
    )) as unknown as { status: number };
    expect(res.status).toBe(200);
    const signed = await withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId, action: KIOSK, entityId: benId } }));
    expect(signed).toHaveLength(1);
    expect(signed[0].entityType).toBe("Member");
    expect(JSON.stringify(signed)).not.toContain(BEN.email);
  }, 120_000);

  it("a member's own edit (member.self_update) of name and address: the import row under the old ones is still removed", async () => {
    // The row the member's own profile edit writes (app/api/member/me), then the edit itself.
    await withRlsBypass(async (tx) => {
      await tx.auditLog.create({
        data: {
          tenantId, userId: null, action: "member.self_update", entityType: "Member", entityId: deeId,
          metadata: { fields: ["name", "email"], changes: { name: { from: DEE.name, to: DEE.newName } }, oldEmailSha256: emailDigest(DEE.email), newEmailSha256: emailDigest(DEE.newEmail) },
        },
      });
      await tx.member.update({ where: { id: deeId }, data: { name: DEE.newName, email: DEE.newEmail } });
    });
    expect(await readImportFile(fileUrl, tenantId)).toContain(`${DEE.name},${DEE.email},`);

    gate.current = { tenantId, userId };
    const res = (await dsarErase(new Request(`https://test.local/api/admin/dsar/erase?memberId=${deeId}`, { method: "POST", headers: { origin: "https://test.local", host: "test.local" } }))) as unknown as { status: number; json: () => Promise<{ erased?: Record<string, number> }> };
    expect(res.status).toBe(200);
    expect((await res.json()).erased).toMatchObject({ importFilesRewritten: 1, importFileRowsRemoved: 1, importNameOnlyRowsLeft: 0 });
    const file = (await readImportFile(fileUrl, tenantId)) ?? "";
    expect(file).not.toContain(DEE.email);
    expect(file).not.toContain(DEE.name);
    expect(file).toContain(BEN.email);
  }, 120_000);
});
