// Round 7 (13 Nov 2026): MatFlow changes between the preview and the commit.
//
// The commit re-classifies every person at write time with the preview's own rules (lib/importers/import-match), so
// it never acts on an outdated preview. What it did not do is SAY that its outcome differs from the preview the owner
// approved: "will import 2" became "imported 1" with no reason. The commit now compares its counts with the stored
// preview (ImportJob.dryRunSummary) and records each count that changed (`manifest.sincePreview`).
//
// Real preview and commit routes, real Postgres (Neon TEST branch), both roles. Synthetic clubs, torn down. Only the
// file store, CSRF, audit, mail and the session are stubbed.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }) },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
const FILES = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/import-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/import-storage")>()),
  readImportFile: vi.fn(async (url: string) => FILES.get(url) ?? null),
  deleteImportFile: vi.fn(async () => {}),
}));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as commit } from "@/app/api/admin/import/[id]/commit/route";
import { POST as previewPOST } from "@/app/api/admin/import/[id]/preview/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r7d${Date.now().toString(36)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
vi.setConfig({ testTimeout: 180_000 });

const T_HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
const PLAN = "Beginners 2026";
const tRow = (name: string, email: string, dob: string) =>
  [name, email, "", PLAN, "recurring", "active", "Stripe", "2026-01-05", "2026-01-05", "", "", "Yes", "", "", "", "", "", "", "GB", "", "", "", dob, "", "", ""].join(",");

describe.skipIf(!HAS_DB)("import: changes between preview and commit are revalidated and explained", () => {
  let tenantId = "";
  let userId = "";

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: `${STAMP} club`, slug: `${STAMP}-club`, timezone: "Europe/London", onboardingCompleted: true } })).id;
      userId = (await tx.user.create({ data: { tenantId, email: E("owner"), name: "Owner", role: "owner", passwordHash: "x" } })).id;
      await tx.membershipTier.create({ data: { tenantId, name: PLAN, pricePence: 8800, currency: "GBP", billingCycle: "monthly", isKids: false, isActive: true } });
    });
    vi.mocked(auth).mockResolvedValue({ user: { id: userId, tenantId, role: "owner" } } as never);
  }, 120_000);

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.importedMembership.deleteMany({ where: { tenantId } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId, parentMemberId: { not: null } } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.importJob.deleteMany({ where: { tenantId } });
      await tx.membershipTier.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  }, 120_000);

  it("staff add one of the file's people by hand after the preview: the commit lists them, creates only the other, and says what changed since the preview", async () => {
    const csv = [T_HEADER, tRow("Ada Moss", E("ada"), "1990-01-01"), tRow("Bo Reed", E("bo"), "1991-02-02")].join("\n");
    const url = `https://blob.test.local/${STAMP}/1.csv`;
    FILES.set(url, csv);
    const job = await withRlsBypass((tx) =>
      tx.importJob.create({ data: { tenantId, createdById: userId, source: "teamup", mode: "create", fileName: "f1.csv", fileBlobUrl: url, status: "pending", fileHash: `${STAMP}-1`, sourceExportedAt: new Date("2026-11-01T08:00:00Z"), sourceExportedAtProvenance: "owner_stated" } }),
    );
    const req = (path: string) => new Request(`https://test.local/api/admin/import/${job.id}/${path}`, { method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: "{}" });

    const pv = await previewPOST(req("preview"), { params: Promise.resolve({ id: job.id }) });
    const preview = (await pv.json()) as { willImport: number; toReviewDiffers: number; toReviewUncertain: number };
    expect(pv.status).toBe(200);
    expect(preview.willImport).toBe(2);

    // Between preview and commit, staff add Bo by hand (a different phone: not an exact duplicate).
    await withRlsBypass((tx) => tx.member.create({ data: { tenantId, name: "Bo Reed", email: E("bo"), phone: "07700900001", paymentStatus: "paid" } }));

    const cm = await commit(req("commit"), { params: Promise.resolve({ id: job.id }) });
    const done = (await cm.json()) as { imported: number; manifest: { existing: { conflicts: number; ambiguous: number; duplicates: number }; sincePreview?: { changed: boolean; counts: Array<{ what: string; preview: number; now: number }> } } };
    expect(cm.status).toBe(200);

    // Revalidated: Bo is not created twice and not overwritten; Ada is created.
    expect(done.imported).toBe(1);
    const bo = await withRlsBypass((tx) => tx.member.findMany({ where: { tenantId, email: E("bo") }, select: { phone: true, importJobId: true } }));
    expect(bo).toEqual([{ phone: "07700900001", importJobId: null }]);
    expect(done.manifest.existing.conflicts + done.manifest.existing.ambiguous + done.manifest.existing.duplicates).toBe(1);

    // Explained: the commit says which of the preview's counts no longer hold.
    expect(done.manifest.sincePreview?.changed).toBe(true);
    expect(done.manifest.sincePreview?.counts).toEqual(expect.arrayContaining([{ what: "new people", preview: 2, now: 1 }]));
  });

  it("nothing changed between preview and commit: the commit says the preview held", async () => {
    const csv = [T_HEADER, tRow("Cy Lund", E("cy"), "1992-03-03")].join("\n");
    const url = `https://blob.test.local/${STAMP}/2.csv`;
    FILES.set(url, csv);
    const job = await withRlsBypass((tx) =>
      tx.importJob.create({ data: { tenantId, createdById: userId, source: "teamup", mode: "create", fileName: "f2.csv", fileBlobUrl: url, status: "pending", fileHash: `${STAMP}-2`, sourceExportedAt: new Date("2026-11-02T08:00:00Z"), sourceExportedAtProvenance: "owner_stated" } }),
    );
    const req = (path: string) => new Request(`https://test.local/api/admin/import/${job.id}/${path}`, { method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: "{}" });
    expect((await previewPOST(req("preview"), { params: Promise.resolve({ id: job.id }) })).status).toBe(200);
    const cm = await commit(req("commit"), { params: Promise.resolve({ id: job.id }) });
    const done = (await cm.json()) as { manifest: { sincePreview?: { changed: boolean; counts: unknown[] } } };
    expect(cm.status).toBe(200);
    expect(done.manifest.sincePreview).toEqual({ changed: false, counts: [] });
  });
});
