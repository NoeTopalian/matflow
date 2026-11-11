// Round 5 (11 Nov 2026): an erasure takes the member out of the import
// MANIFEST too. A TeamUp import keeps its exception list in
// `manifest.teamup2.exceptionRows` (name, email, detail; no member id, no
// source key), served by GET /api/admin/import/[id]/exceptions and
// GET /api/admin/import/[id]. The erasure scrubbed `manifest` by member id and
// source key only, and by name and address only in `errorLog` and
// `dryRunSummary`, so the erased member's name and address were still served.
// Real handlers, Neon TEST branch, both database roles. Synthetic club (r5e-),
// torn down here.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

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
vi.mock("@/lib/audit-log", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/audit-log")>()), logAudit: vi.fn(async () => {}) }));
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
import { POST as dsarErase } from "@/app/api/admin/dsar/erase/route";
import { GET as exceptionsCsv } from "@/app/api/admin/import/[id]/exceptions/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r5e${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 120_000 });
const ADA = { name: "Rfive Ada Obi", email: `${STAMP}-ada@example.test` };
const BEN = { name: "Rfive Ben Ray", email: `${STAMP}-ben@example.test` };
const KID = "Rfive Zed Ray";

describe.skipIf(!HAS_DB)("erasure reaches the import manifest's exception rows", () => {
  let tenantId = "";
  let userId = "";
  let adaId = "";
  let jobId = "";

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: `${STAMP} club`, slug: STAMP, timezone: "Europe/London", onboardingCompleted: true } })).id;
      userId = (await tx.user.create({ data: { tenantId, email: `${STAMP}-owner@example.test`, name: "Owner", role: "owner", passwordHash: "x" } })).id;
      // No source key: the exception rows carry only a name and an address, as buildExceptionRows writes them.
      adaId = (await tx.member.create({ data: { tenantId, name: ADA.name, email: ADA.email } })).id;
      await tx.member.create({ data: { tenantId, name: BEN.name, email: BEN.email } });
      const exceptionRows = [
        { kind: "cancelled_without_date", name: ADA.name, email: ADA.email, action: "Add the date", detail: "Adult Unlimited", sourceRows: [2] },
        { kind: "shared_email_adult", name: BEN.name, email: BEN.email, action: "Check", detail: `Shares ${BEN.email}`, sourceRows: [3] },
        // Ben's child, suggested to Ada as guardian: the child's row stays, Ada's name leaves its detail.
        { kind: "guardian_suggested", name: KID, email: null, action: "Confirm the guardian", detail: `${ADA.name} (shared email)`, sourceRows: [4] },
        { kind: "refused_row", name: "Row 5", email: null, action: "Fix the row", detail: `Duplicate email ${ADA.email}`, sourceRows: [5] },
        { kind: "plan_without_tier", name: "Kids Once A Week (OLD)", email: null, action: "Create the plan", detail: "3 source rows", sourceRows: [6, 7, 8] },
      ];
      jobId = (await tx.importJob.create({
        data: {
          tenantId, createdById: userId, source: "teamup", fileName: "members.csv", fileBlobUrl: "", status: "complete",
          manifest: { teamup2: { asOf: "2026-11-01", exceptions: { refusedRows: 1 }, exceptionRows } },
        },
      })).id;
    });
  });

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.importJob.deleteMany({ where: { tenantId } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  const csv = async () => {
    const r = await exceptionsCsv(new Request(`https://test.local/api/admin/import/${jobId}/exceptions`), { params: Promise.resolve({ id: jobId }) });
    return { status: r.status, text: await r.text() };
  };

  it("before: the owner's exceptions download names her; after erasure it holds neither her name nor her address, and everyone else's rows stay", async () => {
    gate.current = { tenantId, userId };
    const before = await csv();
    expect(before.status).toBe(200);
    expect(before.text).toContain(ADA.email);

    const res = await dsarErase(new Request(`https://test.local/api/admin/dsar/erase?memberId=${adaId}`, { method: "POST", headers: { origin: "https://test.local", host: "test.local" } }));
    expect(res.status).toBe(200);

    const after = await csv();
    expect(after.status).toBe(200);
    expect(after.text).not.toContain(ADA.email);
    expect(after.text).not.toContain(ADA.name);
    expect(after.text).toContain(BEN.name);
    expect(after.text).toContain(KID); // the child's row stays; only Ada's name leaves it
    expect(after.text).toContain("Kids Once A Week (OLD)");

    // GET /api/admin/import/[id] serves the stored manifest: it holds neither.
    const stored = JSON.stringify(await withRlsBypass((tx) => tx.importJob.findUnique({ where: { id: jobId }, select: { manifest: true } })));
    expect(stored).not.toContain(ADA.email);
    expect(stored).not.toContain(ADA.name);
    expect(stored).toContain("2026-11-01"); // the manifest's own fields are untouched
  });
});
