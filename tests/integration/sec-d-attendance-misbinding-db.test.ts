// Security lane D (9 Oct 2026) — AH-D1 / SEC-053 / SEC-055.
//
// Question: can the attendance import's name+email fallback (lib/importers/
// attendance.ts) COMMIT history to the wrong member? Preview visibility is not
// accepted as an answer, so every scenario drives the REAL route
// (app/api/admin/import/attendance: commit, step) against the Neon TEST branch
// and asserts the rows the commit wrote: ImportedBooking.memberId/matchMethod
// and AttendanceRecord.
//
// Scenarios: identical names (the documented "released address" residual),
// roster drift between commit start and a later step, missing references (no
// email, no name), duplicate references, shared contacts, changed source data,
// a stale preview, and (SEC-055) concurrent / replayed commit and step calls on
// two real pg connections. A positive control shows a unique name+email and an
// externalRef still import.
//
// Stubbed: the owner gate, CSRF, audit, mail, rate limiter and the file store
// (files are served from memory). Runs ONLY through the guarded runners
// (scratchpad att/run-engine.sh = owner role; q78/run-restricted.sh =
// matflow_app with RLS) — both refuse any host but the test branch. Fixture
// prefix secD- (names) / secd- (slugs, addresses); count-checked teardown.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash } from "node:crypto";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
// The audit log is REAL: the owner PATCH below must write the address-change row (oldEmailSha256) the importer reads.
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
const gate = vi.hoisted(() => ({ current: null as null | { tenantId: string; userId: string } }));
vi.mock("@/auth", () => ({
  auth: vi.fn(async () => (gate.current ? { user: { id: gate.current.userId, tenantId: gate.current.tenantId, role: "owner" } } : null)),
  signIn: vi.fn(), signOut: vi.fn(), handlers: {},
}));
vi.mock("@/lib/api-authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-authz")>()),
  requireApiOwner: vi.fn(async () => {
    if (!gate.current) throw new Error("no club in scope");
    return { ok: true, tenantId: gate.current.tenantId, userId: gate.current.userId, session: { user: { id: gate.current.userId, tenantId: gate.current.tenantId, role: "owner" } } };
  }),
}));
const FILES = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/import-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/import-storage")>()),
  readImportFile: vi.fn(async (url: string) => FILES.get(url) ?? null),
  deleteImportFile: vi.fn(async () => {}),
}));

import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { teamupPersonKey } from "@/lib/importers/teamup";
import { JOB_SOURCE, LEDGER_SOURCE, MAPPING_VERSION, buildPlan, loadClubInputs, planHashOf, saveDecisions } from "@/lib/attendance-import";
import { POST } from "@/app/api/admin/import/attendance/route";
import { PATCH as patchMember, DELETE as deleteMember } from "@/app/api/members/[id]/route";
import { emailDigest } from "@/lib/login-email";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `secd-${Date.now().toString(36)}`;
const N = (who: string) => `secD ${who}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
const VENUE = "secD Main";
const OFFERING = "secD Adults Gi";
const HEADER = "Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Status";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Row = { name: string; email: string; at?: string; status?: string };
const csvOf = (rows: Row[]) =>
  [HEADER, ...rows.map((r) => [r.name, r.email, r.at ?? "2025-11-03T18:00:00+00:00", OFFERING, VENUE, r.status ?? "Attended"].join(","))].join("\n");

type Club = { tenantId: string; userId: string; classId: string; locationId: string };
const clubs: Club[] = [];
let seq = 0;

async function mkClub(label: string): Promise<Club> {
  const club = await withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: "Europe/London", onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: E(`${label}-owner`), name: "secD Owner", role: "owner", passwordHash: "x" } });
    const loc = await tx.location.create({ data: { tenantId: t.id, name: VENUE, isDefault: true } });
    const cls = await tx.class.create({ data: { tenantId: t.id, name: OFFERING, duration: 60, isActive: true } });
    return { tenantId: t.id, userId: u.id, classId: cls.id, locationId: loc.id };
  });
  clubs.push(club);
  const err = await withTenantContext(club.tenantId, (tx) =>
    saveDecisions(tx, club.tenantId, club.userId, [
      { kind: "offering", sourceKey: OFFERING, action: "class", targetId: club.classId },
      { kind: "venue", sourceKey: VENUE, action: "location", targetId: club.locationId },
    ]),
  );
  if (err) throw new Error(`fixture decisions refused: ${err}`);
  return club;
}

/**
 * A member id whose embedded creation time (cuid v1: ms since epoch, base36, chars 1-8) is `at`: a record that has
 * existed since before the bookings in the file, which is what the name+address fallback now requires.
 */
const idCreatedAt = (at: string) =>
  `c${new Date(at).getTime().toString(36).padStart(8, "0")}${Array.from({ length: 16 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("")}`;
const OLD_MEMBER = "2025-01-15T10:00:00Z";
const mkOldMember = (club: Club, name: string, email: string) =>
  withRlsBypass((tx) => tx.member.create({ data: { id: idCreatedAt(OLD_MEMBER), tenantId: club.tenantId, name, email, externalRef: null }, select: { id: true } })).then((r) => r.id);

const mkMember = (club: Club, name: string, email: string, externalRef: string | null) =>
  withRlsBypass((tx) => tx.member.create({ data: { tenantId: club.tenantId, name, email, externalRef }, select: { id: true } })).then((r) => r.id);

/** A preview job exactly as the route's preview leaves it (planHash over file + decisions + roster). */
async function mkPreview(club: Club, text: string) {
  const url = `test://${STAMP}/${++seq}`;
  FILES.set(url, text);
  const inputs = await withTenantContext(club.tenantId, (tx) => loadClubInputs(tx, club.tenantId));
  const fileHash = sha(text);
  const planHash = planHashOf(fileHash, inputs);
  const built = buildPlan(text, inputs, new Date());
  if (built.errors) throw new Error(built.errors.join(" "));
  const job = await withRlsBypass((tx) =>
    tx.importJob.create({
      data: {
        tenantId: club.tenantId, createdById: club.userId, source: JOB_SOURCE, fileName: `secd-${seq}.csv`, fileBlobUrl: url,
        status: "preview", fileHash, sourceExportedAt: new Date("2026-10-08T12:00:00Z"), sourceExportedAtProvenance: "owner_stated",
        mappingVersion: MAPPING_VERSION, totalRows: built.parsed.rows.length, dryRunSummary: { planHash } as never,
      },
      select: { id: true },
    }),
  );
  return { jobId: job.id, planHash, plan: built.plan };
}

const req = (body: unknown) =>
  new Request("http://localhost/api/admin/import/attendance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

async function call(club: Club, body: unknown) {
  gate.current = { tenantId: club.tenantId, userId: club.userId };
  const res = (await POST(req(body))) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: res.status, body: await res.json() };
}

async function commitAndRun(club: Club, jobId: string, planHash: string, between?: () => Promise<void>) {
  const c = await call(club, { action: "commit", jobId, planHash });
  expect(c.status, JSON.stringify(c.body)).toBe(202);
  if (between) await between();
  for (let i = 0; i < 6; i++) {
    const s = await call(club, { action: "step", jobId });
    expect([200, 202], JSON.stringify(s.body)).toContain(s.status);
    if (s.body.done) return;
  }
  throw new Error("import did not complete");
}

/** The REAL owner PATCH (app/api/members/[id]) — writes the member and its audit row in one transaction. */
async function ownerPatch(club: Club, memberId: string, body: Record<string, unknown>) {
  gate.current = { tenantId: club.tenantId, userId: club.userId };
  const req = new Request(`https://test.local/api/members/${memberId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify(body),
  });
  const res = (await patchMember(req, { params: Promise.resolve({ id: memberId }) })) as unknown as { status: number; json: () => Promise<unknown> };
  expect(res.status, JSON.stringify(await res.json())).toBe(200);
}

const ledger = (club: Club) =>
  withRlsBypass((tx) => tx.importedBooking.findMany({ where: { tenantId: club.tenantId, source: LEDGER_SOURCE }, select: { sourcePersonKey: true, memberId: true, matchMethod: true, disposition: true, attendanceRecordId: true } }));
const attendanceOf = (club: Club, memberId: string) =>
  withRlsBypass((tx) => tx.attendanceRecord.count({ where: { tenantId: club.tenantId, memberId } }));
const attendanceCount = (club: Club) => withRlsBypass((tx) => tx.attendanceRecord.count({ where: { tenantId: club.tenantId } }));

afterAll(async () => {
  if (!HAS_DB) return;
  const ids = clubs.map((c) => c.tenantId);
  for (const tenantId of ids) {
    await withRlsBypass(async (tx) => {
      await tx.importedBooking.deleteMany({ where: { tenantId } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.classSchedule.deleteMany({ where: { class: { tenantId } } });
      await tx.importSourceMapping.deleteMany({ where: { tenantId } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.importJob.deleteMany({ where: { tenantId } });
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.location.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.delete({ where: { id: tenantId } });
    }, { timeout: 60_000 });
  }
  const left = await withRlsBypass(async (tx) => ({
    tenants: await tx.tenant.count({ where: { slug: { startsWith: STAMP } } }),
    members: await tx.member.count({ where: { tenantId: { in: ids } } }),
    bookings: await tx.importedBooking.count({ where: { tenantId: { in: ids } } }),
    attendance: await tx.attendanceRecord.count({ where: { tenantId: { in: ids } } }),
    jobs: await tx.importJob.count({ where: { tenantId: { in: ids } } }),
    audit: await tx.auditLog.count({ where: { tenantId: { in: ids } } }),
  }));
  expect(left).toEqual({ tenants: 0, members: 0, bookings: 0, attendance: 0, jobs: 0, audit: 0 });
}, 180_000);

describe.skipIf(!HAS_DB)("SEC-053 / AH-D1 — attendance identity binding is never silently wrong (REAL route, TEST DB)", () => {
  beforeAll(async () => {
    const who = await withRlsBypass((tx) => tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`);
    console.log(`[sec-d] connected as ${who[0]?.current_user}; RLS_ENFORCED=${process.env.RLS_ENFORCED ?? "0"}`);
    // The role is asserted, not just logged: the restricted runner must really be matflow_app.
    if (process.env.RLS_ENFORCED === "1") expect(who[0]?.current_user).toBe("matflow_app");
    else expect(who[0]?.current_user).not.toBe("matflow_app");
    process.stderr.write(`[sec-d] role ${who[0]?.current_user} RLS_ENFORCED=${process.env.RLS_ENFORCED ?? "0"}\n`);
  });


  it("POSITIVE CONTROL: a unique name+email and an externalRef still import as attendance", async () => {
    const club = await mkClub("pos");
    const dana = await mkOldMember(club, N("Dana Solo"), E("dana"));
    const eli = await mkMember(club, N("Eli Ref"), E("eli"), teamupPersonKey(N("Eli Ref"), E("eli")));
    const { jobId, planHash } = await mkPreview(club, csvOf([{ name: N("Dana Solo"), email: E("dana") }, { name: N("Eli Ref"), email: E("eli") }]));
    await commitAndRun(club, jobId, planHash);
    const rows = await ledger(club);
    expect(rows.find((r) => r.memberId === dana)?.matchMethod).toBe("name_and_email");
    expect(rows.find((r) => r.memberId === eli)?.matchMethod).toBe("external_ref");
    expect(await attendanceOf(club, dana)).toBe(1);
    expect(await attendanceOf(club, eli)).toBe(1);
  });

  it("IDENTICAL NAMES: a same-name hand-added member who now holds the row's address is NOT bound; the booking stays pending", async () => {
    const club = await mkClub("same");
    // Bea (hand-added) moved to a new address; a DIFFERENT Bea Lane was added by hand on Bea's old one.
    const beaOrig = await mkMember(club, N("Bea Lane"), E("bea-new"), null);
    const beaOther = await mkMember(club, N("Bea Lane"), E("bea-old"), null);
    const { jobId, planHash, plan } = await mkPreview(club, csvOf([{ name: N("Bea Lane"), email: E("bea-old") }]));
    const person = plan.people[0];
    await commitAndRun(club, jobId, planHash);
    // What the COMMIT wrote — asserted before what the preview showed.
    expect(await attendanceOf(club, beaOther), "attendance committed to the other Bea Lane").toBe(0);
    expect(await attendanceOf(club, beaOrig)).toBe(0);
    const rows = await ledger(club);
    expect(rows).toHaveLength(1);
    expect(rows[0].memberId).toBeNull();
    expect(rows[0].disposition).toBe("pending_person");
    expect(person.memberId, "previewed as unresolved").toBeNull();
    expect(person.candidates.map((c) => c.memberId).sort()).toEqual([beaOrig, beaOther].sort());
  });

  it("ROSTER DRIFT: a member added AFTER the commit started is not bound by a later step (the commit binds only what was previewed)", async () => {
    const club = await mkClub("drift");
    const { jobId, planHash, plan } = await mkPreview(club, csvOf([{ name: N("Cal Drift"), email: E("cal") }]));
    expect(plan.people[0].memberId).toBeNull();
    let late = "";
    await commitAndRun(club, jobId, planHash, async () => {
      late = await mkMember(club, N("Cal Drift"), E("cal"), null);
    });
    expect(await attendanceOf(club, late), "attendance committed to a member that was never previewed").toBe(0);
    const rows = await ledger(club);
    expect(rows[0].memberId).toBeNull();
    expect(rows[0].disposition).toBe("pending_person");
  });

  it("ROSTER DRIFT (re-point): a previewed match is not moved to another member by an address swap mid-commit", async () => {
    const club = await mkClub("swap");
    const fin = await mkOldMember(club, N("Fin Swap"), E("fin"));
    const { jobId, planHash, plan } = await mkPreview(club, csvOf([{ name: N("Fin Swap"), email: E("fin") }]));
    expect(plan.people[0].memberId).toBe(fin);
    let other = "";
    await commitAndRun(club, jobId, planHash, async () => {
      // The previewed member gives the address up; a new same-name record takes it.
      await withRlsBypass((tx) => tx.member.update({ where: { id: fin }, data: { email: E("fin-moved") } }));
      other = await mkMember(club, N("Fin Swap"), E("fin"), null);
    });
    expect(await attendanceOf(club, other)).toBe(0);
    const rows = await ledger(club);
    // Either the previewed member or pending — never the record that was not previewed.
    expect([fin, null]).toContain(rows[0].memberId);
  });

  // Reviewer R variants (9 Oct 2026, REPORT-D.md): the true person differs from the row by an accent, a rename or a
  // zero-width character, moved to a new address through the REAL owner PATCH, and a DIFFERENT member holds the
  // released old address. None may receive the history.
  const releasedAddressCase = async (label: string, original: string, rename?: string) => {
    const club = await mkClub(label);
    const orig = await mkMember(club, original, E(`${label}-old`), null);
    await ownerPatch(club, orig, { email: E(`${label}-new`), ...(rename ? { name: rename } : {}) });
    const other = await mkMember(club, N("Bea Lane"), E(`${label}-old`), null);
    const { jobId, planHash, plan } = await mkPreview(club, csvOf([{ name: N("Bea Lane"), email: E(`${label}-old`) }]));
    await commitAndRun(club, jobId, planHash);
    expect(await attendanceOf(club, other), "attendance committed to the member who took the released address").toBe(0);
    expect(await attendanceOf(club, orig)).toBe(0);
    const rows = await ledger(club);
    expect(rows[0].memberId).toBeNull();
    expect(rows[0].disposition).toBe("pending_person");
    expect(plan.people[0].candidates.map((c) => c.memberId).sort()).toEqual([orig, other].sort());
  };

  it("VARIANT accent: the original 'Béa Lane' moved away; a different 'Bea Lane' holds the released address → pending", async () => {
    await releasedAddressCase("accent", N("B" + String.fromCharCode(0xe9) + "a Lane")); // precomposed e-acute
  });

  it("VARIANT rename: the original renamed 'Beatrice Lane' and moved; a different 'Bea Lane' holds the released address → pending", async () => {
    await releasedAddressCase("rename", N("Bea Lane"), N("Beatrice Lane"));
  });

  it("VARIANT zero-width: the original 'Be<ZWSP>a Lane' moved away; a different 'Bea Lane' holds the released address → pending", async () => {
    await releasedAddressCase("zw", N("Be" + String.fromCharCode(0x200b) + "a Lane")); // zero-width space
  });

  it("POSITIVE CONTROL: a member who moved to a NEW address (never held by anyone else) still matches on it", async () => {
    const club = await mkClub("moved");
    const ola = await mkOldMember(club, N("Ola Moved"), E("ola-old"));
    await ownerPatch(club, ola, { email: E("ola-new") });
    const { jobId, planHash } = await mkPreview(club, csvOf([{ name: N("Ola Moved"), email: E("ola-new") }]));
    await commitAndRun(club, jobId, planHash);
    expect((await ledger(club))[0].matchMethod).toBe("name_and_email");
    expect(await attendanceOf(club, ola)).toBe(1);
  });

  // Reviewer R third-pass variants (REPORT-D2.md): the release of the address is NOT in a keyed audit row.
  const unauditedReleaseCase = async (label: string, release: (club: Club, origId: string) => Promise<void>) => {
    const club = await mkClub(label);
    const orig = await mkOldMember(club, N("Bea Lane"), E(`${label}-old`));
    await release(club, orig);
    const other = await mkMember(club, N("Bea Lane"), E(`${label}-old`), null);
    const { jobId, planHash, plan } = await mkPreview(club, csvOf([{ name: N("Bea Lane"), email: E(`${label}-old`) }]));
    await commitAndRun(club, jobId, planHash);
    expect(await attendanceOf(club, other), "attendance committed to the member who took the released address").toBe(0);
    const rows = await ledger(club);
    expect(rows[0].memberId).toBeNull();
    expect(rows[0].disposition).toBe("pending_person");
    expect(plan.people[0].candidates.map((c) => c.memberId)).toContain(other);
    return { club, orig };
  };

  it("VARIANT raw SQL: the original renamed and re-addressed by raw SQL (no audit row) → the new same-name holder is not bound", async () => {
    await unauditedReleaseCase("rawsql", (club, orig) =>
      withRlsBypass((tx) => tx.$executeRaw`UPDATE "Member" SET email = ${E("rawsql-new")}, name = ${N("Beatrice Lane")} WHERE id = ${orig} AND "tenantId" = ${club.tenantId}`).then(() => undefined));
  });

  it("VARIANT unkeyed: the move recorded before AH-E2 with the UNKEYED SHA-256 form → not bound", async () => {
    await unauditedReleaseCase("unkeyed", async (club, orig) => {
      await withRlsBypass(async (tx) => {
        await tx.member.update({ where: { id: orig }, data: { email: E("unkeyed-new"), name: N("Beatrice Lane") } });
        await tx.auditLog.create({ data: { tenantId: club.tenantId, userId: club.userId, action: "member.update", entityType: "Member", entityId: orig,
          metadata: { oldEmailSha256: createHash("sha256").update(E("unkeyed-old").trim().toLowerCase()).digest("hex") } } });
      });
    });
  });

  it("VARIANT deleted: the original deleted through the REAL member DELETE, a different Bea Lane created at the address → not bound; the delete records the released address", async () => {
    const { club, orig } = await unauditedReleaseCase("deleted", async (club, origId) => {
      gate.current = { tenantId: club.tenantId, userId: club.userId };
      const req = new Request(`https://test.local/api/members/${origId}?confirm=1`, { method: "DELETE", headers: { origin: "https://test.local", host: "test.local" } });
      const res = (await deleteMember(req, { params: Promise.resolve({ id: origId }) })) as unknown as { status: number; json: () => Promise<unknown> };
      expect(res.status, JSON.stringify(await res.json())).toBe(200);
    });
    const audit = await withRlsBypass((tx) => tx.auditLog.findFirst({ where: { tenantId: club.tenantId, action: "member.delete", entityId: orig }, select: { metadata: true } }));
    expect((audit?.metadata as Record<string, unknown> | null)?.releasedEmailSha256).toBe(emailDigest(E("deleted-old")));
  });

  it("POSITIVE CONTROL (inverted rule): a member who has held the address since before the bookings still matches", async () => {
    const club = await mkClub("heldsince");
    const pia = await mkOldMember(club, N("Pia Held"), E("pia"));
    const { jobId, planHash } = await mkPreview(club, csvOf([{ name: N("Pia Held"), email: E("pia") }]));
    await commitAndRun(club, jobId, planHash);
    expect((await ledger(club))[0].matchMethod).toBe("name_and_email");
    expect(await attendanceOf(club, pia)).toBe(1);
  });

  it("INVERTED RULE: a member created AFTER the bookings is not bound by name+address (offered as a candidate instead)", async () => {
    const club = await mkClub("newcomer");
    const neo = await mkMember(club, N("Neo New"), E("neo"), null);
    const { jobId, planHash, plan } = await mkPreview(club, csvOf([{ name: N("Neo New"), email: E("neo") }]));
    await commitAndRun(club, jobId, planHash);
    expect(await attendanceOf(club, neo)).toBe(0);
    expect(plan.people[0].candidates.map((c) => c.memberId)).toContain(neo);
  });

  it("MISSING REFERENCES: a row with no email, or with no name, never binds by the fallback", async () => {
    const club = await mkClub("missing");
    const gil = await mkMember(club, N("Gil Noemail"), E("gil"), null);
    const hana = await mkMember(club, N("Hana Noname"), E("hana"), null);
    const { jobId, planHash } = await mkPreview(club, csvOf([{ name: N("Gil Noemail"), email: "" }, { name: "", email: E("hana") }]));
    await commitAndRun(club, jobId, planHash);
    const rows = await ledger(club);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.memberId === null)).toBe(true);
    expect(await attendanceOf(club, gil)).toBe(0);
    expect(await attendanceOf(club, hana)).toBe(0);
  });

  it("DUPLICATE REFERENCES: the database refuses a second member with the same externalRef, so the planner's duplicate guard is defence in depth", async () => {
    const club = await mkClub("dupref");
    const key = teamupPersonKey(N("Ivo Twin"), E("ivo"));
    const a = await mkMember(club, N("Ivo Twin"), E("ivo"), key);
    await expect(mkMember(club, N("Ivo Twin"), E("ivo-2"), key)).rejects.toThrow(/Unique constraint/);
    // A same-name, same-address record without the ref cannot exist either (unique tenantId+email); the ref holder is bound.
    const { jobId, planHash } = await mkPreview(club, csvOf([{ name: N("Ivo Twin"), email: E("ivo") }]));
    await commitAndRun(club, jobId, planHash);
    const rows = await ledger(club);
    expect(rows[0].memberId).toBe(a);
    expect(rows[0].matchMethod).toBe("external_ref");
  });

  it("SHARED CONTACTS: two people on one address — only the one whose NAME and address match is bound; the other stays pending", async () => {
    const club = await mkClub("shared");
    const jan = await mkOldMember(club, N("Jan Share"), E("family"));
    const { jobId, planHash } = await mkPreview(club, csvOf([{ name: N("Jan Share"), email: E("family") }, { name: N("Kai Share"), email: E("family") }]));
    await commitAndRun(club, jobId, planHash);
    const rows = await ledger(club);
    const kai = rows.find((r) => r.sourcePersonKey === teamupPersonKey(N("Kai Share"), E("family")));
    expect(kai?.memberId).toBeNull();
    expect(await attendanceOf(club, jan)).toBe(1);
  });

  it("CHANGED SOURCE DATA: a person renamed at TeamUp is not re-bound to a same-name hand-added record or by address alone", async () => {
    const club = await mkClub("renamed");
    const old = await mkMember(club, N("Lee Old"), E("lee"), teamupPersonKey(N("Lee Old"), E("lee")));
    const handAdded = await mkMember(club, N("Lee New"), E("lee-other"), null);
    const { jobId, planHash } = await mkPreview(club, csvOf([{ name: N("Lee New"), email: E("lee") }]));
    await commitAndRun(club, jobId, planHash);
    expect((await ledger(club))[0].memberId).toBeNull();
    expect(await attendanceOf(club, old)).toBe(0);
    expect(await attendanceOf(club, handAdded)).toBe(0);
  });

  it("STALE PREVIEW: a roster change between preview and commit is refused (409) and nothing is written", async () => {
    const club = await mkClub("stale");
    const { jobId, planHash } = await mkPreview(club, csvOf([{ name: N("Mo Stale"), email: E("mo") }]));
    await mkMember(club, N("Mo Stale"), E("mo"), null);
    const c = await call(club, { action: "commit", jobId, planHash });
    expect(c.status).toBe(409);
    expect(c.body.stale).toBe(true);
    const job = await withRlsBypass((tx) => tx.importJob.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } }));
    expect(job.status).toBe("preview");
    expect(await ledger(club)).toHaveLength(0);
  });
});

describe.skipIf(!HAS_DB)("SEC-055 — concurrent and replayed commit/step calls (two real connections)", () => {
  it("two commits at once: exactly one starts; two steps at once: one works, the other is told busy; replays change nothing", async () => {
    const club = await mkClub("race");
    const ids = await Promise.all(["Nia", "Oli", "Pip"].map((n) => mkMember(club, N(`${n} Race`), E(n.toLowerCase()), teamupPersonKey(N(`${n} Race`), E(n.toLowerCase())))));
    const rows: Row[] = [];
    for (const [i, n] of ["Nia", "Oli", "Pip"].entries()) {
      for (let d = 1; d <= 20; d++) rows.push({ name: N(`${n} Race`), email: E(n.toLowerCase()), at: `2025-11-${String(d).padStart(2, "0")}T1${i}:00:00+00:00` });
    }
    const { jobId, planHash } = await mkPreview(club, csvOf(rows));
    const [c1, c2] = await Promise.all([call(club, { action: "commit", jobId, planHash }), call(club, { action: "commit", jobId, planHash })]);
    const statuses = [c1.status, c2.status].sort();
    // One 202 (started); the other is refused as busy (409) or told to resume the running job (200).
    expect(statuses).toContain(202);
    expect(statuses.filter((s) => s === 202)).toHaveLength(1);
    const [s1, s2] = await Promise.all([call(club, { action: "step", jobId }), call(club, { action: "step", jobId })]);
    expect([s1.status, s2.status].every((s) => s === 200 || s === 202)).toBe(true);
    for (let i = 0; i < 6; i++) {
      const s = await call(club, { action: "step", jobId });
      if (s.body.done) break;
    }
    const after = { bookings: (await ledger(club)).length, attendance: await attendanceCount(club) };
    expect(after).toEqual({ bookings: 60, attendance: 60 });
    for (const id of ids) expect(await attendanceOf(club, id)).toBe(20);
    // Replays: commit again → 409 complete; step again → done; nothing changes.
    const again = await call(club, { action: "commit", jobId, planHash });
    expect(again.status).toBe(409);
    const stepAgain = await call(club, { action: "step", jobId });
    expect(stepAgain.body.done).toBe(true);
    expect({ bookings: (await ledger(club)).length, attendance: await attendanceCount(club) }).toEqual(after);
    // A second job over the SAME file (a replayed upload) leaves the ledger and attendance unchanged.
    const second = await mkPreview(club, csvOf(rows));
    await commitAndRun(club, second.jobId, second.planHash);
    expect({ bookings: (await ledger(club)).length, attendance: await attendanceCount(club) }).toEqual(after);
  }, 120_000);
});
