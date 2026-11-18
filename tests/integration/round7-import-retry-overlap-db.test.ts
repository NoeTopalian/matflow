// Round 7 (13 Nov 2026): members import — an interrupted run retried, two overlapping imports at once, and a staff
// edit racing a commit. Real commit route, real Postgres (Neon TEST branch), both roles; races are concurrent requests.
// Synthetic clubs, torn down. Only the file store, CSRF, audit, mail and the session are stubbed; one slice's status
// events can be made to fail, which rolls that slice's transaction back (an interrupted run).
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
const fault = vi.hoisted(() => ({ failOnCall: 0, failOnCalls: [] as number[], calls: 0 }));
vi.mock("@/lib/member-status", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/member-status")>();
  return {
    ...real,
    recordStatusEventsBulk: async (...args: Parameters<typeof real.recordStatusEventsBulk>) => {
      fault.calls += 1;
      if ((fault.failOnCall && fault.calls === fault.failOnCall) || fault.failOnCalls.includes(fault.calls)) throw new Error("injected: the run stops here");
      return real.recordStatusEventsBulk(...args);
    },
  };
});

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as commit } from "@/app/api/admin/import/[id]/commit/route";
import { POST as previewPOST } from "@/app/api/admin/import/[id]/preview/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r7r${Date.now().toString(36)}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
vi.setConfig({ testTimeout: 300_000 });

const T_HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
const PLAN = "Beginners 2026";
const person = (n: number, tag: string) => ({ name: `Person ${tag}${n}`, email: E(`${tag}${n}`), dob: `1990-01-${String((n % 28) + 1).padStart(2, "0")}` });
const tRow = (p: { name: string; email: string; dob: string }) =>
  [p.name, p.email, "", PLAN, "recurring", "active", "Stripe", "2026-01-05", "2026-01-05", "", "", "Yes", "", "", "", "", "", "", "GB", "", "", "", p.dob, "", "", ""].join(",");
const fileOf = (people: Array<{ name: string; email: string; dob: string }>) => [T_HEADER, ...people.map(tRow)].join("\n");

describe.skipIf(!HAS_DB)("members import: retry, overlap and concurrent staff edits", () => {
  let tenantId = "";
  let userId = "";
  let seq = 0;

  async function job(csv: string) {
    const url = `https://blob.test.local/${STAMP}/${++seq}.csv`;
    FILES.set(url, csv);
    return withRlsBypass((tx) =>
      tx.importJob.create({ data: { tenantId, createdById: userId, source: "teamup", mode: "create", fileName: `f${seq}.csv`, fileBlobUrl: url, status: "preview", fileHash: `${STAMP}-${seq}`, sourceExportedAt: new Date(Date.UTC(2026, 10, 1 + seq, 8)), sourceExportedAtProvenance: "owner_stated" } }),
    );
  }
  async function run(jobId: string) {
    const res = await commit(
      new Request(`https://test.local/api/admin/import/${jobId}/commit`, { method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: "{}" }),
      { params: Promise.resolve({ id: jobId }) },
    );
    return { status: res.status, body: (await res.json()) as Record<string, unknown> & { imported?: number; manifest?: Record<string, unknown> } };
  }
  const emailsOf = async (prefix: string) =>
    (await withRlsBypass((tx) => tx.member.findMany({ where: { tenantId, email: { startsWith: `${STAMP}-${prefix}` } }, select: { email: true } }))).map((m) => m.email);

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

  it("a run interrupted after its first 25 people, then run again: everyone once, the retry reports its own share, the job reconciles", async () => {
    const people = Array.from({ length: 30 }, (_, i) => person(i + 1, "r"));
    const j = await job(fileOf(people));
    // Previewed first, as the panel does (review N3): the resume is then compared with that preview too.
    const pv = await previewPOST(
      new Request(`https://test.local/api/admin/import/${j.id}/preview`, { method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: "{}" }),
      { params: Promise.resolve({ id: j.id }) },
    );
    expect(pv.status).toBe(200);
    fault.calls = 0;
    fault.failOnCall = 2; // the second slice's write fails and rolls back
    const first = await run(j.id);
    fault.failOnCall = 0;
    expect(first.status).not.toBe(200);
    expect((await emailsOf("r")).length).toBe(25);
    expect((await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: j.id }, select: { status: true } }))).status).toBe("failed");

    const again = await run(j.id);
    expect(again.status).toBe(200);
    expect(again.body.imported).toBe(5);
    const emails = await emailsOf("r");
    expect(emails.length).toBe(30);
    expect(new Set(emails).size).toBe(30);
    const after = await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: j.id }, select: { status: true, importedRows: true, manifest: true } }));
    expect(after.status).toBe("complete");
    expect(after.importedRows).toBe(30);
    expect(after.manifest).toMatchObject({ resumedWith: 25, reconciles: true, created: { total: 30 } });
    // The preview said 30 new; the run made 30 (25 before the interruption, 5 now): no change is claimed.
    expect((after.manifest as { sincePreview?: unknown }).sincePreview).toEqual({ changed: false, counts: [] });
    // Review P1: everyone this job created carries their imported membership history, including the five created on
    // the retry (the interrupted run had written their rows with no member).
    expect(await withRlsBypass((tx) => tx.importedMembership.count({ where: { tenantId, importJobId: j.id, memberId: null } }))).toBe(0);
    expect(await withRlsBypass((tx) => tx.importedMembership.count({ where: { tenantId, importJobId: j.id } }))).toBe(30);
    // Each person's import status event is recorded once, not once per attempt.
    const events = await withRlsBypass((tx) => tx.memberStatusEvent.count({ where: { tenantId, member: { email: { startsWith: `${STAMP}-r` } } } }));
    expect(events).toBe(30);
  });

  it("a retry that must link more people than one batch holds (45 left by failed slices): everyone's history linked once", async () => {
    // Re-review of a1cef92d: the linking runs in batches of 20; this crosses two batch boundaries (20, 20, 5).
    // A failed slice does not stop the run (the next slice is still written), so slices 2 and 3 (25 + 20 people) fail
    // and only slice 1's 25 are written; every ledger row is written, those 45 people's with no member.
    // Tag "link", not "b": the overlap case below adds person "b1" as a NEW person; sharing the tag made it a duplicate.
    const people = Array.from({ length: 70 }, (_, i) => person(i + 1, "link"));
    const j = await job(fileOf(people));
    fault.calls = 0;
    fault.failOnCalls = [2, 3];
    expect((await run(j.id)).status).not.toBe(200);
    fault.failOnCalls = [];
    expect((await emailsOf("link")).length).toBe(25);
    const again = await run(j.id);
    expect(again.status).toBe(200);
    expect(again.body.imported).toBe(45);
    const rows = await withRlsBypass((tx) => tx.importedMembership.findMany({ where: { tenantId, importJobId: j.id }, select: { memberId: true } }));
    expect(rows.length).toBe(70);
    expect(rows.filter((r) => r.memberId === null).length).toBe(0);
    const members = await withRlsBypass((tx) => tx.member.findMany({ where: { tenantId, importJobId: j.id }, select: { id: true } }));
    expect(members.length).toBe(70);
    // One history row per person, each on its own person.
    const perMember = new Map<string, number>();
    for (const r of rows) perMember.set(r.memberId!, (perMember.get(r.memberId!) ?? 0) + 1);
    expect(perMember.size).toBe(70);
    expect([...perMember.values()].every((n) => n === 1)).toBe(true);
    expect(new Set(members.map((m) => m.id))).toEqual(new Set(perMember.keys()));
  });

  it("two imports naming the same people, committed at the same moment: each person once; the other import counts them as already here; both reconcile", async () => {
    const shared = [1, 2, 3].map((n) => person(n, "s"));
    const onlyA = [person(1, "a")];
    const onlyB = [person(1, "b")];
    const [ja, jb] = [await job(fileOf([...shared, ...onlyA])), await job(fileOf([...shared, ...onlyB]))];
    const [ra, rb] = await Promise.all([run(ja.id), run(jb.id)]);
    expect([ra.status, rb.status]).toEqual([200, 200]);
    for (const p of [...shared, ...onlyA, ...onlyB]) {
      expect(await withRlsBypass((tx) => tx.member.count({ where: { tenantId, email: p.email } }))).toBe(1);
    }
    // The shared three were created by exactly one of the two jobs, and counted as already here by the other.
    expect((ra.body.imported ?? 0) + (rb.body.imported ?? 0)).toBe(shared.length + 2);
    for (const r of [ra, rb]) expect(r.body.manifest?.reconciles).toBe(true);
    // Accurate, not just reconciled: the job that did not create a shared person says it was ALREADY HERE (it waited on
    // the address lock and saw the other job's row), rather than an unexplained skip that only the unique index caught.
    const dupes = (r: typeof ra) => ((r.body.manifest?.existing as { duplicates?: number } | undefined)?.duplicates ?? 0);
    expect(dupes(ra) + dupes(rb)).toBe(shared.length);
    const createdBy = await withRlsBypass((tx) => tx.member.groupBy({ by: ["importJobId"], where: { tenantId, email: { in: shared.map((p) => p.email) } }, _count: { _all: true } }));
    expect(createdBy).toHaveLength(1);
  });

  // Concurrent, but the order of the edit and the commit's read is not controlled: this guards "an import never writes
  // to an existing member" whichever lands first, not a specific interleaving.
  it("a staff edit sent alongside a commit that names the same member: the staff values stand, the import writes nothing to them", async () => {
    const existing = person(1, "x");
    const fresh = Array.from({ length: 20 }, (_, i) => person(i + 2, "x"));
    // The member is already in the club (an earlier import), then the club edits them while a later file is committed.
    await run((await job(fileOf([existing]))).id);
    const later = await job(fileOf([{ ...existing }, ...fresh]));
    const staffEdit = withRlsBypass((tx) => tx.member.updateMany({ where: { tenantId, email: existing.email }, data: { phone: "07700900123", notes: "Edited by the desk during the import" } }));
    const [, done] = await Promise.all([staffEdit, run(later.id)]);
    expect(done.status).toBe(200);
    const m = await withRlsBypass((tx) => tx.member.findFirstOrThrow({ where: { tenantId, email: existing.email }, select: { phone: true, notes: true } }));
    expect(m).toEqual({ phone: "07700900123", notes: "Edited by the desk during the import" });
    expect(await withRlsBypass((tx) => tx.member.count({ where: { tenantId, email: existing.email } }))).toBe(1);
    expect(done.body.manifest?.reconciles).toBe(true);
  });
});
