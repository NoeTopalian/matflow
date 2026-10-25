// Later uploads never silently overwrite MatFlow (owner decision, 25 Oct 2026)
// against a REAL database — the Neon test branch only (tests/setup-test-db.ts
// refuses production). Synthetic clubs, `example.test` addresses, torn down.
//
// Through the REAL members-import commit route and the REAL conflicts route:
//   - the same file imported twice creates nobody the second time (exact duplicates);
//   - a plan and a status staff changed in MatFlow, and a MatFlow cancellation,
//     survive a later upload, which lists them instead;
//   - a member created in MatFlow (no import history) is preserved and flagged;
//   - a file person whose email points at one member and whose record key
//     points at another is flagged, and nobody is created or changed;
//   - the conflicts list shows MatFlow's CURRENT value, is owner-only, and a
//     job of another club is not found (no data leaks across clubs).
// Only the file store, CSRF, audit, mail and the session are stubbed.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
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
import { teamupPersonKey } from "@/lib/importers/teamup";
import { POST as commit } from "@/app/api/admin/import/[id]/commit/route";
import { GET as conflictsGET } from "@/app/api/admin/import/[id]/conflicts/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `icf${Date.now().toString(36)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;

const T_HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
type P = { name: string; email: string; plan: string; dob: string };
const tRow = (p: P, status: string) =>
  [p.name, p.email, "", p.plan, "recurring", status, "Stripe", "2026-01-05", "2026-01-05", "", "", "Yes", "", "", "", "", "", "", "GB", "", "", "", p.dob, "", "", ""].join(",");
const BEG = "Beginners 2026";
const ADV = "Advanced 2026";
const PEOPLE = {
  ann: { name: "Ann Lee", email: E("ann"), plan: BEG, dob: "1990-01-01" },
  ben: { name: "Ben Ito", email: E("ben"), plan: BEG, dob: "1991-02-02" },
  cat: { name: "Cat Ode", email: E("cat"), plan: BEG, dob: "1992-03-03" },
} satisfies Record<string, P>;
const fileOf = (people: P[], status: Partial<Record<string, string>> = {}) => [T_HEADER, ...people.map((p) => tRow(p, status[p.name] ?? "active"))].join("\n");

type Club = { tenantId: string; userId: string; managerId: string };
const clubs: Club[] = [];
async function mkClub(label: string): Promise<Club> {
  const c = await withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: "Europe/London", onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: E(`${label}-owner`), name: "Owner", role: "owner", passwordHash: "x" } });
    const mgr = await tx.user.create({ data: { tenantId: t.id, email: E(`${label}-manager`), name: "Manager", role: "manager", passwordHash: "x" } });
    for (const name of [BEG, ADV]) {
      await tx.membershipTier.create({ data: { tenantId: t.id, name, pricePence: 8800, currency: "GBP", billingCycle: "monthly", isKids: false, isActive: true } });
    }
    return { tenantId: t.id, userId: u.id, managerId: mgr.id };
  });
  clubs.push(c);
  return c;
}
const as = (club: Club, role: "owner" | "manager" = "owner") =>
  mockAuth.mockResolvedValue({ user: { id: role === "owner" ? club.userId : club.managerId, tenantId: club.tenantId, role } } as never);

let seq = 0;
async function importFile(club: Club, csv: string, mode: "create" | "refresh" = "create") {
  const url = `https://blob.test.local/${STAMP}/${++seq}.csv`;
  FILES.set(url, csv);
  const job = await withRlsBypass((tx) =>
    tx.importJob.create({
      data: { tenantId: club.tenantId, createdById: club.userId, source: "teamup", mode, fileName: `f${seq}.csv`, fileBlobUrl: url, status: "preview", fileHash: `${STAMP}-${seq}`, sourceExportedAt: new Date(`2026-10-${String(10 + seq).padStart(2, "0")}T08:00:00Z`), sourceExportedAtProvenance: "owner_stated" },
    }),
  );
  as(club);
  const res = await commit(
    new Request(`https://test.local/api/admin/import/${job.id}/commit`, { method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: "{}" }),
    { params: Promise.resolve({ id: job.id }) },
  );
  const body = (await res.json()) as Record<string, unknown>;
  expect(res.status, JSON.stringify(body)).toBe(200);
  return { jobId: job.id, body: body as { imported?: number; toReview?: number; manifest: Record<string, unknown> } };
}
async function review(club: Club, jobId: string, role: "owner" | "manager" = "owner") {
  as(club, role);
  const res = await conflictsGET(new Request(`https://test.local/api/admin/import/${jobId}/conflicts`), { params: Promise.resolve({ id: jobId }) });
  return { status: res.status, body: (await res.json()) as { conflicts?: Array<Record<string, unknown>>; error?: string } };
}
const memberBy = (tenantId: string, email: string) => withRlsBypass((tx) => tx.member.findFirstOrThrow({ where: { tenantId, email } }));
const count = (tenantId: string) => withRlsBypass((tx) => tx.member.count({ where: { tenantId } }));

describe.skipIf(!HAS_DB)("later uploads never silently overwrite MatFlow (owner decision 25 Oct 2026)", () => {
  let A: Club;
  let B: Club;
  let firstJob = "";

  beforeAll(async () => {
    A = await mkClub("a");
    B = await mkClub("b");
    ({ jobId: firstJob } = await importFile(A, fileOf(Object.values(PEOPLE))));
  }, 120_000);

  afterAll(async () => {
    const ids = clubs.map((c) => c.tenantId);
    await withRlsBypass(async (tx) => {
      await tx.importedMembership.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.member.updateMany({ where: { tenantId: { in: ids } }, data: { parentMemberId: null } });
      await tx.member.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.importJob.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.membershipTier.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.user.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.tenant.deleteMany({ where: { id: { in: ids } } });
    });
    expect(await withRlsBypass((tx) => tx.tenant.count({ where: { slug: { startsWith: STAMP } } }))).toBe(0);
  }, 120_000);

  it("the same file imported again creates nobody: every person is an exact duplicate", async () => {
    expect(await count(A.tenantId)).toBe(3);
    const { body } = await importFile(A, fileOf(Object.values(PEOPLE)));
    expect(body.imported).toBe(0);
    expect(body.toReview).toBe(0);
    expect(await count(A.tenantId)).toBe(3);
    expect(body.manifest.existing).toEqual({ duplicates: 3, conflicts: 0, ambiguous: 0 });
  }, 60_000);

  it("a later upload never attaches its membership history to people already in the club (review 25 Oct, H-1)", async () => {
    const { jobId } = await importFile(A, fileOf(Object.values(PEOPLE)));
    const attached = await withRlsBypass((tx) => tx.importedMembership.count({ where: { tenantId: A.tenantId, importJobId: jobId, memberId: { not: null } } }));
    expect(attached).toBe(0);
    // The rows are still kept (every CSV record has a disposition), just attached to nobody.
    expect(await withRlsBypass((tx) => tx.importedMembership.count({ where: { tenantId: A.tenantId, importJobId: jobId } }))).toBeGreaterThan(0);
    // The first import's own history is still attached to the people it created.
    const ann = await memberBy(A.tenantId, PEOPLE.ann.email);
    expect(await withRlsBypass((tx) => tx.importedMembership.count({ where: { tenantId: A.tenantId, memberId: ann.id } }))).toBeGreaterThan(0);
    expect(await withRlsBypass((tx) => tx.importedMembership.count({ where: { tenantId: A.tenantId, memberId: ann.id, importJobId: { not: firstJob } } }))).toBe(0);
  }, 60_000);

  it("staff-edited plan and status, and a MatFlow cancellation, survive a later upload, which lists them instead", async () => {
    const adv = await withRlsBypass((tx) => tx.membershipTier.findFirstOrThrow({ where: { tenantId: A.tenantId, name: ADV } }));
    await withRlsBypass(async (tx) => {
      await tx.member.updateMany({ where: { tenantId: A.tenantId, email: PEOPLE.ann.email }, data: { membershipTierId: adv.id, membershipType: ADV } });
      await tx.member.updateMany({ where: { tenantId: A.tenantId, email: PEOPLE.ben.email }, data: { status: "inactive" } });
      await tx.member.updateMany({ where: { tenantId: A.tenantId, email: PEOPLE.cat.email }, data: { status: "cancelled", cancelledAt: new Date("2026-10-01T00:00:00Z") } });
    });
    const before = await withRlsBypass((tx) => tx.member.findMany({ where: { tenantId: A.tenantId }, orderBy: { id: "asc" } }));
    const { jobId, body } = await importFile(A, fileOf(Object.values(PEOPLE)));
    expect(body.imported).toBe(0);
    expect(body.toReview).toBe(3);
    // Every member row is exactly as it was.
    expect(await withRlsBypass((tx) => tx.member.findMany({ where: { tenantId: A.tenantId }, orderBy: { id: "asc" } }))).toEqual(before);
    expect((await memberBy(A.tenantId, PEOPLE.ann.email)).membershipType).toBe(ADV);
    expect((await memberBy(A.tenantId, PEOPLE.cat.email)).status).toBe("cancelled");

    const r = await review(A, jobId);
    expect(r.status).toBe(200);
    const byName = new Map((r.body.conflicts ?? []).map((c) => [c.name as string, c]));
    expect((byName.get("Ann Lee")!.fields as unknown[])).toContainEqual(expect.objectContaining({ field: "plan", upload: BEG, now: ADV, stillDiffers: true }));
    expect((byName.get("Cat Ode")!.fields as unknown[])).toContainEqual(expect.objectContaining({ field: "status", upload: "active", now: "cancelled", stillDiffers: true }));
    expect((byName.get("Ben Ito")!.member as { href: string }).href).toMatch(/^\/dashboard\/members\//);

    // Someone resolves Ben by hand; the list now reads "matches now" from MatFlow's current value.
    await withRlsBypass((tx) => tx.member.updateMany({ where: { tenantId: A.tenantId, email: PEOPLE.ben.email }, data: { status: "active" } }));
    const again = await review(A, jobId);
    const ben = (again.body.conflicts ?? []).find((c) => c.name === "Ben Ito")!;
    expect(ben.fields as unknown[]).toContainEqual(expect.objectContaining({ field: "status", now: "active", stillDiffers: false }));
  }, 90_000);

  it("a status refresh (real route, refresh mode) changes nobody and lists the staff-edited people", async () => {
    const before = await withRlsBypass((tx) => tx.member.findMany({ where: { tenantId: A.tenantId }, orderBy: { id: "asc" } }));
    const { jobId, body } = await importFile(A, fileOf(Object.values(PEOPLE)), "refresh");
    expect(await withRlsBypass((tx) => tx.member.findMany({ where: { tenantId: A.tenantId }, orderBy: { id: "asc" } }))).toEqual(before);
    expect(await withRlsBypass((tx) => tx.member.count({ where: { tenantId: A.tenantId, billingStatusSource: jobId } }))).toBe(0);
    expect((body as unknown as { toReview: number }).toReview).toBeGreaterThanOrEqual(2); // Ann's plan, Cat's cancellation (Ben was resolved above)
    const r = await review(A, jobId);
    const names = (r.body.conflicts ?? []).map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["Ann Lee", "Cat Ode"]));
  }, 60_000);

  it("a member created in MatFlow (no import history) is preserved and flagged", async () => {
    const dee = { name: "Dee Ray", email: E("dee"), plan: BEG, dob: "1993-04-04" };
    await withRlsBypass((tx) => tx.member.create({ data: { tenantId: A.tenantId, name: "Dee Ray", email: dee.email, status: "active", paymentStatus: "overdue" } }));
    const before = await memberBy(A.tenantId, dee.email);
    const { body } = await importFile(A, fileOf([dee]));
    expect(body.imported).toBe(0);
    expect(body.toReview).toBe(1);
    expect(await memberBy(A.tenantId, dee.email)).toEqual(before);
  }, 60_000);

  it("email points at one member and the record key at another: flagged, nobody created or changed", async () => {
    // Eve was imported under her old address; a member created in MatFlow now holds the address in the file.
    const old = { name: "Eve Sol", email: E("eve-old"), plan: BEG, dob: "1994-05-05" };
    const now = { ...old, email: E("eve-now") };
    await withRlsBypass(async (tx) => {
      await tx.member.create({ data: { tenantId: A.tenantId, name: "Eve Sol", email: old.email, externalRef: teamupPersonKey(now.name, now.email) } });
      await tx.member.create({ data: { tenantId: A.tenantId, name: "Someone Else", email: now.email } });
    });
    const n = await count(A.tenantId);
    const { body } = await importFile(A, fileOf([now]));
    expect(body.imported).toBe(0);
    expect(await count(A.tenantId)).toBe(n);
    expect(body.manifest.existing).toMatchObject({ ambiguous: 1 });
  }, 60_000);

  it("a member deleted since the import is listed without a name or any values (review 25 Oct, M-5)", async () => {
    const fox = { name: "Fox Ward", email: E("fox"), plan: BEG, dob: "1995-06-06" };
    await importFile(A, fileOf([fox]));
    await withRlsBypass((tx) => tx.member.updateMany({ where: { tenantId: A.tenantId, email: fox.email }, data: { phone: "07700 900456" } }));
    const { jobId } = await importFile(A, fileOf([{ ...fox }]).replace(",GB,,,", ",GB,,07700 900999,"));
    const id = (await memberBy(A.tenantId, fox.email)).id;
    await withRlsBypass(async (tx) => {
      await tx.importedMembership.updateMany({ where: { memberId: id }, data: { memberId: null } });
      await tx.memberStatusEvent.deleteMany({ where: { memberId: id } });
      await tx.member.delete({ where: { id } });
    });
    const r = await review(A, jobId);
    expect(r.status).toBe(200);
    const text = JSON.stringify(r.body);
    expect(text).not.toContain("Fox Ward");
    expect(text).not.toContain("07700 900456");
    expect(text).not.toContain("07700 900999");
    expect(r.body.conflicts).toEqual([expect.objectContaining({ name: "A member since deleted", fields: [] })]);
  }, 60_000);

  it("the review list is owner-only and never shows another club's job", async () => {
    // A manager of the same club is refused.
    expect((await review(A, firstJob, "manager")).status).toBe(403);
    // The owner of another club gets not-found for club A's job, with no member data.
    const other = await review(B, firstJob);
    expect(other.status).toBe(404);
    expect(other.body.conflicts).toBeUndefined();
  }, 60_000);
});
