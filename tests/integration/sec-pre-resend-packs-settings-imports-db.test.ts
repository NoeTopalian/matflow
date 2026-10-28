// Pre-Resend adversarial pass (W6, owner instruction of 28 Oct 2026): class
// packs, the memberAppCheckin setting with support sessions, Reports with a
// foreign class id, and the import routes as they stand on this branch,
// attacked through their real handlers against the Neon TEST branch, as both
// database roles (db-tests.mjs). Synthetic clubs only, torn down here.
// Stubbed: the session, CSRF, audit, mail, the import file store and the
// support-refusal audit writer. Stripe is never constructed (no pack create;
// the routes exercised here make no provider call).

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => {
  class NR extends Response {
    static json(body: unknown, init?: { status?: number; headers?: HeadersInit }) {
      return new Response(JSON.stringify(body), { status: init?.status ?? 200, headers: { "content-type": "application/json", ...(init?.headers as Record<string, string> | undefined) } });
    }
  }
  return { NextRequest: class extends Request {}, NextResponse: NR };
});
const authState = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn(async (entry: Record<string, unknown>) => { audit.calls.push(entry); }),
}));
vi.mock("@/lib/support-refusal-audit", () => ({
  recordSupportRefusal: vi.fn(async () => {}),
  refusedFieldsOf: vi.fn(async (r: { json: () => Promise<{ refusedFields?: string[] }> }) => (await r.json()).refusedFields ?? []),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("stripe", () => ({ default: vi.fn(() => { throw new Error("W6: Stripe must not be constructed here"); }) }));
const FILES = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/import-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/import-storage")>()),
  readImportFile: vi.fn(async (url: string) => FILES.get(url) ?? null),
  deleteImportFile: vi.fn(async () => {}),
}));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { getReportsData } from "@/lib/reports";
import { PATCH as packPatch, DELETE as packDelete } from "@/app/api/class-packs/[id]/route";
import { GET as packList } from "@/app/api/class-packs/route";
import { GET as memberPacks } from "@/app/api/member/class-packs/route";
import { PATCH as settingsPatch } from "@/app/api/settings/route";
import { GET as jobsList } from "@/app/api/admin/import/route";
import { GET as jobGET } from "@/app/api/admin/import/[id]/route";
import { POST as previewPOST } from "@/app/api/admin/import/[id]/preview/route";
import { GET as conflictsGET } from "@/app/api/admin/import/[id]/conflicts/route";
import { GET as exceptionsGET } from "@/app/api/admin/import/[id]/exceptions/route";
import { POST as commitPOST } from "@/app/api/admin/import/[id]/commit/route";
import { POST as rollbackPOST } from "@/app/api/admin/import/[id]/rollback/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `w6p${Date.now().toString(36)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
vi.setConfig({ testTimeout: 240_000 });

type Res = { status: number; body: Record<string, unknown> };
async function read(res: unknown): Promise<Res> {
  const r = res as { status: number; json?: () => Promise<Record<string, unknown>>; text?: () => Promise<string> };
  let body: Record<string, unknown> = {};
  try { body = r.json ? await r.json() : {}; } catch { body = {}; }
  return { status: r.status, body };
}

const T_HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
const tRow = (name: string, email: string, plan: string) =>
  [name, email, "", plan, "recurring", "active", "Stripe", "2026-01-05", "2026-01-05", "", "", "Yes", "", "", "", "", "", "", "GB", "", "", "", "1990-01-01", "", "", ""].join(",");

describe.skipIf(!HAS_DB)("W6 pre-Resend: packs, settings, reports and imports under attack (real database)", () => {
  const club = { A: "", B: "" };
  const owner = { A: "", B: "" };
  const staff = { managerA: "", coachA: "" };
  const product = { A: "", B: "" };
  const member = { A: "", B: "" };
  const sold = { A: "", B: "" };
  const classOf = { A: "", B: "" };
  const jobB = { id: "" };
  let fileSeq = 0;

  const session = (k: "A" | "B", role: string, id: string, extra: Record<string, unknown> = {}) => ({
    user: { id, tenantId: club[k], role, email: E(`${k}-${role}`), ...extra },
  });

  async function newJob(k: "A" | "B", csv: string, status = "preview") {
    const url = `https://blob.test.local/${STAMP}/${++fileSeq}.csv`;
    FILES.set(url, csv);
    return withRlsBypass((tx) => tx.importJob.create({
      data: {
        tenantId: club[k], createdById: owner[k], source: "teamup", mode: "create", fileName: `w6-${fileSeq}.csv`, fileBlobUrl: url,
        status, fileHash: `${STAMP}-${fileSeq}`, sourceExportedAt: new Date("2026-10-20T08:00:00Z"), sourceExportedAtProvenance: "owner_stated",
      },
    }));
  }
  const post = (path: string, body: unknown = {}) => new Request(`https://test.local${path}`, {
    method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: JSON.stringify(body),
  });

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      for (const k of ["A", "B"] as const) {
        const t = await tx.tenant.create({ data: { name: `${STAMP} ${k}`, slug: `${STAMP}-${k.toLowerCase()}`, timezone: "Europe/London", onboardingCompleted: true } });
        club[k] = t.id;
        owner[k] = (await tx.user.create({ data: { tenantId: t.id, email: E(`${k}-owner`), name: `Owner ${k}`, role: "owner", passwordHash: "x" } })).id;
        await tx.membershipTier.create({ data: { tenantId: t.id, name: "Adults 2026", pricePence: 8800, currency: "GBP", billingCycle: "monthly", isKids: false, isActive: true } });
        product[k] = (await tx.classPack.create({ data: { tenantId: t.id, name: `Ten ${k}`, totalCredits: 10, validityDays: 90, pricePence: 9000 } })).id;
        member[k] = (await tx.member.create({ data: { tenantId: t.id, name: `Member ${k}`, email: E(`${k}-member`) } })).id;
        sold[k] = (await tx.memberClassPack.create({
          data: { tenantId: t.id, memberId: member[k], packId: product[k], creditsRemaining: 7, status: "active", expiresAt: new Date("2027-01-01T00:00:00Z") },
        })).id;
        classOf[k] = (await tx.class.create({ data: { tenantId: t.id, name: `${STAMP} Secret Class ${k}`, duration: 60 } })).id;
      }
      staff.managerA = (await tx.user.create({ data: { tenantId: club.A, email: E("A-manager"), name: "Manager A", role: "manager", passwordHash: "x" } })).id;
      staff.coachA = (await tx.user.create({ data: { tenantId: club.A, email: E("A-coach"), name: "Coach A", role: "coach", passwordHash: "x" } })).id;
    });
    jobB.id = (await newJob("B", [T_HEADER, tRow("Bea Bee", E("bea"), "Adults 2026")].join("\n"))).id;
  }, 120_000);

  afterAll(async () => {
    const ids = [club.A, club.B].filter(Boolean);
    if (!ids.length) return;
    await withRlsBypass(async (tx) => {
      await tx.importedMembership.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.classPackRedemption.deleteMany({ where: { memberPack: { tenantId: { in: ids } } } });
      await tx.memberClassPack.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.classPack.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.class.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.member.updateMany({ where: { tenantId: { in: ids } }, data: { parentMemberId: null } });
      await tx.member.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.importJob.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.membershipTier.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.user.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.tenant.deleteMany({ where: { id: { in: ids } } });
    });
  }, 120_000);

  // ── Class packs ────────────────────────────────────────────────────────────

  describe("class packs", () => {
    it("PATCH with forged credits, price, validity, tenant and sold-pack fields changes only the name; nothing sold moves", async () => {
      authState.session = session("A", "owner", owner.A);
      const r = await read(await packPatch(
        new Request(`https://test.local/api/class-packs/${product.A}`, {
          method: "PATCH",
          body: JSON.stringify({ name: "Ten A (renamed)", totalCredits: 999, pricePence: 1, validityDays: null, currency: "USD", tenantId: club.B, creditsRemaining: 999, stripePriceId: "price_forged" }),
        }),
        { params: Promise.resolve({ id: product.A }) },
      ));
      expect(r.status).toBe(200);
      const p = await withRlsBypass((tx) => tx.classPack.findUniqueOrThrow({ where: { id: product.A } }));
      expect(p).toMatchObject({ name: "Ten A (renamed)", totalCredits: 10, pricePence: 9000, validityDays: 90, tenantId: club.A });
      expect(p.stripePriceId).not.toBe("price_forged");
      const s = await withRlsBypass((tx) => tx.memberClassPack.findUniqueOrThrow({ where: { id: sold.A } }));
      expect(s.creditsRemaining).toBe(7);
      expect(s.expiresAt?.toISOString()).toBe("2027-01-01T00:00:00.000Z");
    });

    it("club A's owner editing or deactivating club B's product is 404 and B's product is untouched", async () => {
      authState.session = session("A", "owner", owner.A);
      const ctx = { params: Promise.resolve({ id: product.B }) };
      expect((await read(await packPatch(new Request("https://test.local/x", { method: "PATCH", body: JSON.stringify({ name: "pwned", isActive: false }) }), ctx))).status).toBe(404);
      expect((await read(await packDelete(new Request("https://test.local/x", { method: "DELETE" }), ctx))).status).toBe(404);
      const p = await withRlsBypass((tx) => tx.classPack.findUniqueOrThrow({ where: { id: product.B } }));
      expect(p).toMatchObject({ name: "Ten B", isActive: true });
    });

    it("coach and member are 403 on the product routes; the staff list shows only the club's own products", async () => {
      for (const s of [session("A", "coach", staff.coachA), session("A", "member", "member-user", { memberId: member.A })]) {
        authState.session = s;
        expect((await read(await packPatch(new Request("https://test.local/x", { method: "PATCH", body: JSON.stringify({ name: "x" }) }), { params: Promise.resolve({ id: product.A }) }))).status).toBe(403);
        expect((await read(await packList())).status).toBe(403);
      }
      authState.session = session("A", "manager", staff.managerA);
      const list = (await (await packList() as unknown as { json: () => Promise<Array<{ id: string; tenantId: string }>> }).json());
      expect(list.map((p) => p.tenantId)).toEqual(list.map(() => club.A));
      expect(list.map((p) => p.id)).not.toContain(product.B);
    });

    it("the member pack list shows only the member's own packs and their own club's products (a cross-club pack row is not listed)", async () => {
      // A pack row in club B naming A's member must not surface in A's app.
      const stray = await withRlsBypass(async (tx) => (await tx.memberClassPack.create({
        data: { tenantId: club.B, memberId: member.A, packId: product.B, creditsRemaining: 4, status: "active", expiresAt: null },
      })).id);
      authState.session = session("A", "member", "member-user", { memberId: member.A });
      const r = await read(await memberPacks());
      expect(r.status).toBe(200);
      const owned = r.body.owned as Array<{ id: string }>;
      const available = r.body.available as Array<{ id: string }>;
      expect(owned.map((o) => o.id)).toEqual([sold.A]);
      expect(available.map((a) => a.id)).not.toContain(product.B);
      expect(owned.map((o) => o.id)).not.toContain(stray);
    });
  });

  // ── Settings: memberAppCheckin ─────────────────────────────────────────────

  describe("settings: memberAppCheckin", () => {
    const patch = async (s: unknown, body: unknown) => {
      authState.session = s;
      return read(await settingsPatch(new Request("https://test.local/api/settings", { method: "PATCH", body: JSON.stringify(body) })));
    };
    const current = () => withRlsBypass(async (tx) => (await tx.tenant.findUniqueOrThrow({ where: { id: club.A } })).memberAppCheckin);

    it("manager, coach and member are refused; the value does not move", async () => {
      for (const s of [session("A", "manager", staff.managerA), session("A", "coach", staff.coachA), session("A", "member", "m", { memberId: member.A })]) {
        expect((await patch(s, { memberAppCheckin: false })).status).toBe(403);
      }
      expect(await current()).toBe(true);
    });

    it("a VIEW support session is refused; an EDIT support session is refused for this field (owner-only), alone or mixed with a routine field", async () => {
      const view = session("A", "owner", owner.A, { impersonatedBy: "operator-w6", supportScope: "view" });
      const edit = session("A", "owner", owner.A, { impersonatedBy: "operator-w6", supportScope: "edit" });
      const forgedScope = session("A", "owner", owner.A, { impersonatedBy: "operator-w6", supportScope: "EDIT" });
      expect((await patch(view, { memberAppCheckin: false })).status).toBe(403);
      expect((await patch(edit, { memberAppCheckin: false })).status).toBe(403);
      expect((await patch(edit, { primaryColor: "#112233", memberAppCheckin: false })).status).toBe(403);
      expect((await patch(forgedScope, { primaryColor: "#112233" })).status).toBe(403);
      expect(await current()).toBe(true);
    });

    it("an unknown or wrongly typed key is refused outright (strict schema), and the owner's own change is audited", async () => {
      const own = session("A", "owner", owner.A);
      expect((await patch(own, { memberAppCheckin: "false" })).status).toBe(400);
      expect((await patch(own, { memberAppCheckin: false, tenantId: club.B })).status).toBe(400);
      expect(await current()).toBe(true);
      audit.calls.length = 0;
      expect((await patch(own, { memberAppCheckin: false })).status).toBe(200);
      expect(await current()).toBe(false);
      expect(audit.calls.find((c) => c.action === "tenant.settings.update")).toMatchObject({ tenantId: club.A, userId: owner.A });
      expect((await withRlsBypass((tx) => tx.tenant.findUniqueOrThrow({ where: { id: club.B } }))).memberAppCheckin).toBe(true);
      await patch(own, { memberAppCheckin: true });
    });
  });

  // ── Reports: a foreign classId ─────────────────────────────────────────────

  describe("reports", () => {
    it("club B's class id is dropped (no filter), never applied, never named", async () => {
      const plain = await getReportsData(club.A, { period: { period: "this-month" } });
      const forged = await getReportsData(club.A, { period: { period: "this-month" }, classId: classOf.B });
      expect(forged.filters.classId).toBeNull();
      expect(forged.filters.className).toBeNull();
      expect(forged.summary).toEqual(plain.summary);
      expect(JSON.stringify(forged)).not.toContain(`Secret Class B`);
      expect(JSON.stringify(forged)).not.toContain(classOf.B);
    });
  });

  // ── Imports: cross-club job ids, PII, repeated and parallel commits ────────

  describe("imports", () => {
    it("club A's owner gets 404 for club B's job on every job route, sees no B data, and B's job does not move", async () => {
      authState.session = session("A", "owner", owner.A);
      const ctx = () => ({ params: Promise.resolve({ id: jobB.id }) });
      const results = [
        await read(await jobGET(new Request("https://test.local/x"), ctx())),
        await read(await previewPOST(post(`/api/admin/import/${jobB.id}/preview`), ctx())),
        await read(await conflictsGET(new Request("https://test.local/x"), ctx())),
        await read(await exceptionsGET(new Request("https://test.local/x"), ctx())),
        await read(await commitPOST(post(`/api/admin/import/${jobB.id}/commit`), ctx())),
        await read(await rollbackPOST(post(`/api/admin/import/${jobB.id}/rollback`), ctx())),
      ];
      for (const r of results) {
        expect(r.status).toBe(404);
        expect(JSON.stringify(r.body)).not.toMatch(/Bea Bee|bea@|w6-1\.csv/);
      }
      const list = await read(await jobsList());
      expect(JSON.stringify(list.body)).not.toContain(jobB.id);
      const j = await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: jobB.id } }));
      expect(j.status).toBe("preview");
      expect(await withRlsBypass((tx) => tx.member.count({ where: { tenantId: club.B, email: E("bea") } }))).toBe(0);
    });

    it("manager and coach are 403 on the import routes", async () => {
      const job = await newJob("A", [T_HEADER, tRow("Cal Cee", E("cal"), "Adults 2026")].join("\n"));
      for (const s of [session("A", "manager", staff.managerA), session("A", "coach", staff.coachA)]) {
        authState.session = s;
        expect((await read(await jobGET(new Request("https://test.local/x"), { params: Promise.resolve({ id: job.id }) }))).status).toBe(403);
        expect((await read(await commitPOST(post(`/api/admin/import/${job.id}/commit`), { params: Promise.resolve({ id: job.id }) }))).status).toBe(403);
      }
    });

    it("the same job committed twice at once imports its people once; a second job for the same file is refused", async () => {
      const csv = [T_HEADER, tRow("Dee Dot", E("dee"), "Adults 2026"), tRow("Eve Eck", E("eve"), "Adults 2026")].join("\n");
      const job = await newJob("A", csv);
      authState.session = session("A", "owner", owner.A);
      const [r1, r2] = await Promise.all([
        commitPOST(post(`/api/admin/import/${job.id}/commit`), { params: Promise.resolve({ id: job.id }) }).then(read),
        commitPOST(post(`/api/admin/import/${job.id}/commit`), { params: Promise.resolve({ id: job.id }) }).then(read),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 409]);
      for (const e of [E("dee"), E("eve")]) {
        expect(await withRlsBypass((tx) => tx.member.count({ where: { tenantId: club.A, email: e } }))).toBe(1);
      }
      // The same file again as a new job (same fileHash): refused while the first stands.
      const again = await withRlsBypass((tx) => tx.importJob.create({
        data: { tenantId: club.A, createdById: owner.A, source: "teamup", mode: "create", fileName: "again.csv", fileBlobUrl: (job.fileBlobUrl), status: "preview", fileHash: job.fileHash, sourceExportedAt: new Date("2026-10-21T08:00:00Z"), sourceExportedAtProvenance: "owner_stated" },
      }));
      const r3 = await read(await commitPOST(post(`/api/admin/import/${again.id}/commit`), { params: Promise.resolve({ id: again.id }) }));
      expect(r3.status).toBe(409);
      for (const e of [E("dee"), E("eve")]) {
        expect(await withRlsBypass((tx) => tx.member.count({ where: { tenantId: club.A, email: e } }))).toBe(1);
      }
    });

    it("a malformed or hostile file is refused or imported as inert text: no 500, no formula, no foreign club touched", async () => {
      const hostile = [
        T_HEADER,
        tRow("\"=HYPERLINK(\"\"https://evil.test\"\";\"\"x\"\")\"", E("formula"), "Adults 2026"),
        tRow("<script>alert(1)</script>", E("script"), "Adults 2026"),
      ].join("\n");
      const job = await newJob("A", hostile);
      const garbage = await newJob("A", "\u0000\u0001PK\u0003\u0004 not a csv at all");
      authState.session = session("A", "owner", owner.A);
      const g = await read(await commitPOST(post(`/api/admin/import/${garbage.id}/commit`), { params: Promise.resolve({ id: garbage.id }) }));
      expect(g.status).toBeLessThan(500);
      const h = await read(await commitPOST(post(`/api/admin/import/${job.id}/commit`), { params: Promise.resolve({ id: job.id }) }));
      expect(h.status).toBeLessThan(500);
      // Whatever was stored is text in club A only.
      const stored = await withRlsBypass((tx) => tx.member.findMany({ where: { email: { in: [E("formula"), E("script")] } }, select: { tenantId: true } }));
      for (const s of stored) expect(s.tenantId).toBe(club.A);
      // The exceptions export (if this job has one) guards formula cells.
      const ex = (await exceptionsGET(new Request("https://test.local/x"), { params: Promise.resolve({ id: job.id }) })) as unknown as { status: number; text?: () => Promise<string>; json?: () => Promise<unknown> };
      if (ex.status === 200 && ex.text) {
        const csv = await ex.text();
        expect(csv).not.toMatch(/(^|,)"?=HYPERLINK/m);
      }
    });
  });
});
