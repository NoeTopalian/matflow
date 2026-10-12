// Security lane D3 (iteration 2, 9 Oct 2026) — closes review R4's refusal of the mapping provenance (SF-74 / SF-92).
//
// R4 showed the D2 provenance digest was a keyed MAC over the SOURCE KEY ONLY, so a row could be COPIED: within a club
// onto a re-pointed mapping (P1, runtime database password only) or from the attacker's own club after minting it
// through the real decide route (P2, password + an owner session anywhere). The proof is now a MAC (same root key,
// derived sub-key) over the whole tuple — club, mapping id, kind, source-key digest, before, after, the row's own
// createdAt — chained to the previous provenance row of the same mapping (genesis = a fixed constant), and the importer
// trusts a person decision only when the LATEST row verifies, matches the mapping as stored, links to the row before
// it, and is not dated in the future.
//
// Cells adopted from R4 (docs/security/evidence/R4/zz-r4-provenance-probe-db.test.ts.txt): P1, P2 (red at 968d7bc →
// green), P3, P4, P5 (green before and after). Added: X1 cross-club re-home (identical row, only the club differs),
// P3b wrong key over the CORRECT tuple (the cell that catches mutant M3), E1/E2 empty signing key, P6 replayed older
// row, F1 future-dated row, F2 newer unproven row, C1 deleted earlier row (chain), and one OPEN cell (tail truncation
// needs AuditLog DELETE — closed by SF-57 v2, not by this lane) run as it.fails unless SEC_D3_STRICT=1.
//
// Runs only through the guarded runners (owner role / matflow_app with RLS), TEST branch. Prefix secd3-; count-checked
// teardown of this file's clubs (including every provenance row its clubs hold).
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, createHmac } from "node:crypto";

// The signing key must be non-empty in this process (R4: the harness runs with none, so every "keyed" digest was an
// HMAC with an EMPTY key). A synthetic value, set before any module reads lib/auth-secret.
const KEY = vi.hoisted(() => {
  if (!process.env.NEXTAUTH_SECRET && !process.env.AUTH_SECRET) process.env.NEXTAUTH_SECRET = `secd3-synthetic-signing-key-${Date.now()}-0123456789abcdef`;
  return { root: process.env.NEXTAUTH_SECRET ?? process.env.AUTH_SECRET ?? "" };
});

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
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
vi.mock("@/lib/api-authz", async (importOriginal) => {
  const ok = async () => {
    if (!gate.current) throw new Error("no club in scope");
    return { ok: true, tenantId: gate.current.tenantId, userId: gate.current.userId, session: { user: { id: gate.current.userId, tenantId: gate.current.tenantId, role: "owner" } } };
  };
  return { ...(await importOriginal<typeof import("@/lib/api-authz")>()), requireApiOwner: vi.fn(ok), requireApiOwnerOrManager: vi.fn(ok) };
});
const FILES = vi.hoisted(() => new Map<string, string>());
vi.mock("@/lib/import-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/import-storage")>()),
  readImportFile: vi.fn(async (url: string) => FILES.get(url) ?? null),
  deleteImportFile: vi.fn(async () => {}),
}));

import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { teamupPersonKey } from "@/lib/importers/teamup";
import {
  JOB_SOURCE, LEDGER_SOURCE, MAPPING_VERSION, MAPPING_PROVENANCE_GENESIS, PROVENANCE_KEY_CONTEXT,
  buildPlan, loadClubInputs, planHashOf, provenanceCanonical, saveDecisions, sourceKeyDigest,
} from "@/lib/attendance-import";
import { POST } from "@/app/api/admin/import/attendance/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STRICT = process.env.SEC_D3_STRICT === "1";
/** OPEN cells: the secure assertion fails today (expected failure) unless SEC_D3_STRICT=1. */
const openIt = STRICT ? it : it.fails;
const STAMP = `secd3-${Date.now().toString(36)}`;
const N = (who: string) => `secD3 ${who}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
const VENUE = "secD3 Main";
const OFFERING = "secD3 Adults Gi";
const HEADER = "Customer Name,Customer Email,Event Starts At,Offering Type Name,Venue Name,Status";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const csvOf = (name: string, email: string) => [HEADER, [name, email, "2025-11-03T18:00:00+00:00", OFFERING, VENUE, "Attended"].join(",")].join("\n");
const ACTION = "import.mapping.changed";

/** The proof as a holder of `root` computes it: sub-key = HMAC(root, context); proof = HMAC(sub-key, canonical tuple). */
const macUnder = (root: string, canonical: string) =>
  createHmac("sha256", createHmac("sha256", root).update(PROVENANCE_KEY_CONTEXT).digest()).update(canonical).digest("hex");

type Club = { tenantId: string; userId: string; classId: string; locationId: string };
const clubs: Club[] = [];
let seq = 0;

async function mkClub(label: string): Promise<Club> {
  const club = await withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: "Europe/London", onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: E(`${label}-owner`), name: "secD3 Owner", role: "owner", passwordHash: "x" } });
    const loc = await tx.location.create({ data: { tenantId: t.id, name: VENUE, isDefault: true } });
    const cls = await tx.class.create({ data: { tenantId: t.id, name: OFFERING, duration: 60, isActive: true } });
    return { tenantId: t.id, userId: u.id, classId: cls.id, locationId: loc.id };
  });
  clubs.push(club);
  const err = await withTenantContext(club.tenantId, (tx) => saveDecisions(tx, club.tenantId, club.userId, [
    { kind: "offering", sourceKey: OFFERING, action: "class", targetId: club.classId },
    { kind: "venue", sourceKey: VENUE, action: "location", targetId: club.locationId },
  ]));
  if (err) throw new Error(err);
  return club;
}
const idCreatedAt = (at: string) =>
  `c${new Date(at).getTime().toString(36).padStart(8, "0")}${Array.from({ length: 16 }, () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]).join("")}`;
const mkOld = (club: Club, name: string, email: string) =>
  withRlsBypass((tx) => tx.member.create({ data: { id: idCreatedAt("2025-01-15T10:00:00Z"), tenantId: club.tenantId, name, email }, select: { id: true } })).then((r) => r.id);

async function call(club: Club, body: unknown) {
  gate.current = { tenantId: club.tenantId, userId: club.userId };
  const res = (await POST(new Request("http://localhost/api/admin/import/attendance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }))) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: res.status, body: await res.json() };
}
/** Preview, commit and step the victim's one booking through the REAL route. */
async function importVictim(club: Club, name: string, email: string) {
  const text = csvOf(name, email);
  const url = `test://${STAMP}/${++seq}`;
  FILES.set(url, text);
  const inputs = await withTenantContext(club.tenantId, (tx) => loadClubInputs(tx, club.tenantId));
  const planHash = planHashOf(sha(text), inputs);
  const built = buildPlan(text, inputs, new Date());
  if (built.errors) throw new Error(built.errors.join(" "));
  const job = await withRlsBypass((tx) => tx.importJob.create({
    data: { tenantId: club.tenantId, createdById: club.userId, source: JOB_SOURCE, fileName: `secd3-${seq}.csv`, fileBlobUrl: url, status: "preview", fileHash: sha(text),
      sourceExportedAt: new Date("2026-10-08T12:00:00Z"), sourceExportedAtProvenance: "owner_stated", mappingVersion: MAPPING_VERSION, totalRows: 1, dryRunSummary: { planHash } as never },
    select: { id: true },
  }));
  const c = await call(club, { action: "commit", jobId: job.id, planHash });
  expect(c.status, JSON.stringify(c.body)).toBe(202);
  for (let i = 0; i < 6; i++) { const s = await call(club, { action: "step", jobId: job.id }); if (s.body.done) break; }
  return inputs;
}
const ledger = (club: Club) => withRlsBypass((tx) => tx.importedBooking.findMany({ where: { tenantId: club.tenantId, source: LEDGER_SOURCE }, select: { memberId: true, matchMethod: true, disposition: true } }));
const attendanceOf = (club: Club, memberId: string) => withRlsBypass((tx) => tx.attendanceRecord.count({ where: { tenantId: club.tenantId, memberId } }));
async function expectNotBound(club: Club, wrong: string, why: string) {
  const rows = await ledger(club);
  expect({ attendance: await attendanceOf(club, wrong), memberId: rows[0]?.memberId ?? null, disposition: rows[0]?.disposition }, why)
    .toEqual({ attendance: 0, memberId: null, disposition: "pending_person" });
}
async function expectBound(club: Club, right: string) {
  expect((await ledger(club))[0]).toMatchObject({ memberId: right, matchMethod: "decision" });
}
const VIC = "Vic Lane";
const decide = (club: Club, sourceKey: string, targetId: string) =>
  withTenantContext(club.tenantId, (tx) => saveDecisions(tx, club.tenantId, club.userId, [{ kind: "person", sourceKey, action: "member", targetId }]));
const mappingOf = (club: Club, key: string) =>
  withRlsBypass((tx) => tx.importSourceMapping.findFirstOrThrow({ where: { tenantId: club.tenantId, kind: "person", sourceKey: key }, select: { id: true } }));
type Row = { id: string; metadata: Record<string, unknown>; createdAt: Date };
/** Every provenance row of a mapping, oldest first (the attacker READS these; reading needs no key). */
const rowsOf = async (club: Club, mappingId: string): Promise<Row[]> =>
  (await withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId: club.tenantId, action: ACTION, entityId: mappingId }, orderBy: { createdAt: "asc" }, select: { id: true, metadata: true, createdAt: true } })))
    .map((r) => ({ id: r.id, metadata: (r.metadata ?? {}) as Record<string, unknown>, createdAt: r.createdAt }));
/** Insert a provenance row by raw write (prerequisite a). */
const insertRow = (club: Club, mappingId: string, metadata: Record<string, unknown>, at?: Date) =>
  withRlsBypass((tx) => tx.auditLog.create({ data: { tenantId: club.tenantId, action: ACTION, entityType: "ImportSourceMapping", entityId: mappingId, ...(at ? { createdAt: at } : {}), metadata: metadata as never } }));
const forgedMapping = (club: Club, key: string, targetId: string) =>
  withRlsBypass((tx) => tx.importSourceMapping.create({ data: { tenantId: club.tenantId, source: LEDGER_SOURCE, kind: "person", sourceKey: key, action: "member", targetId, decidedById: club.userId }, select: { id: true } }));
/** A row correct in every field (tuple, chain, date) whose proof is computed under `root`. */
async function forgeUnder(club: Club, root: string, mappingId: string, key: string, targetId: string, at = new Date()) {
  const prior = await rowsOf(club, mappingId);
  const last = prior[prior.length - 1];
  const prev = last ? (last.metadata.proof as string) : MAPPING_PROVENANCE_GENESIS;
  const fields = { tenantId: club.tenantId, mappingId, kind: "person", sourceKeyDigest: sourceKeyDigest("person", key), before: null, after: { action: "member", targetId }, createdAtMs: at.getTime(), prev };
  await insertRow(club, mappingId, { kind: "person", source: LEDGER_SOURCE, sourceKeyDigest: fields.sourceKeyDigest, before: null, after: fields.after, via: "decide", prev, proof: macUnder(root, provenanceCanonical(fields)) }, at);
}

afterAll(async () => {
  if (!HAS_DB) return;
  const ids = clubs.map((c) => c.tenantId);
  let provenanceRows = 0;
  for (const tenantId of ids) {
    await withRlsBypass(async (tx) => {
      provenanceRows += (await tx.auditLog.deleteMany({ where: { tenantId, action: ACTION } })).count;
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
    members: await tx.member.count({ where: { OR: [{ tenantId: { in: ids } }, { email: { startsWith: STAMP } }] } }),
    users: await tx.user.count({ where: { email: { startsWith: STAMP } } }),
    mappings: await tx.importSourceMapping.count({ where: { tenantId: { in: ids } } }),
    bookings: await tx.importedBooking.count({ where: { tenantId: { in: ids } } }),
    audit: await tx.auditLog.count({ where: { tenantId: { in: ids } } }),
  }));
  expect(left).toEqual({ tenants: 0, members: 0, users: 0, mappings: 0, bookings: 0, audit: 0 });
  process.stderr.write(`[secd3] teardown: ${ids.length} clubs removed (${provenanceRows} provenance rows), 0 rows left\n`);
}, 240_000);

describe.skipIf(!HAS_DB)("D3 — the mapping-provenance proof is bound to its row, club and chain (REAL route, TEST DB)", () => {
  beforeAll(async () => {
    const who = await withRlsBypass((tx) => tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`);
    if (process.env.RLS_ENFORCED === "1") expect(who[0]?.current_user).toBe("matflow_app");
    else expect(who[0]?.current_user).not.toBe("matflow_app");
    expect(KEY.root.length, "the test process must sign with a non-empty key").toBeGreaterThan(0);
    process.stderr.write(`[secd3] role ${who[0]?.current_user} RLS_ENFORCED=${process.env.RLS_ENFORCED ?? "0"} keyLen=${KEY.root.length} STRICT=${STRICT ? 1 : 0}\n`);
  });

  it("CONTROL: a decision saved through the real decide route binds as decided; its row carries a chained proof", async () => {
    const club = await mkClub("ctl");
    const right = await mkOld(club, N("Vee Right"), E("right"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    const r = await call(club, { action: "decide", decisions: [{ kind: "person", sourceKey: key, action: "member", targetId: right }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = await rowsOf(club, (await mappingOf(club, key)).id);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata.prev).toBe(MAPPING_PROVENANCE_GENESIS);
    expect(rows[0].metadata.proof).toMatch(/^[0-9a-f]{64}$/);
    await importVictim(club, N(VIC), E("vic"));
    await expectBound(club, right);
  });

  it("CONTROL: two decisions in a row — the second chains to the first and binds", async () => {
    const club = await mkClub("ctl2");
    const first = await mkOld(club, N("Fay First"), E("fay"));
    const second = await mkOld(club, N("Sid Second"), E("sid"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    expect(await decide(club, key, first)).toBeNull();
    expect(await decide(club, key, second)).toBeNull();
    const rows = await rowsOf(club, (await mappingOf(club, key)).id);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.metadata.proof)).toEqual([expect.stringMatching(/^[0-9a-f]{64}$/), expect.stringMatching(/^[0-9a-f]{64}$/)]);
    expect(rows[1].metadata.prev).toBe(rows[0].metadata.proof);
    expect(rows[1].createdAt.getTime()).toBeGreaterThan(rows[0].createdAt.getTime());
    await importVictim(club, N(VIC), E("vic"));
    await expectBound(club, second);
  });

  it("P1 (a) COPIED PROOF, same club: re-point by raw UPDATE + INSERT a row copied from the legitimate one (after → attacker) → pending", async () => {
    const club = await mkClub("p1");
    const right = await mkOld(club, N("Vee Right"), E("right"));
    const mal = await mkOld(club, N("Mal Lory"), E("mal"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    expect(await decide(club, key, right)).toBeNull();
    const m = await mappingOf(club, key);
    const [legit] = await rowsOf(club, m.id);
    await withRlsBypass((tx) => tx.$executeRaw`UPDATE "ImportSourceMapping" SET "targetId" = ${mal} WHERE id = ${m.id}`);
    await insertRow(club, m.id, { ...legit.metadata, before: { action: "member", targetId: right }, after: { action: "member", targetId: mal } });
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, mal, "P1: a copied proof vouched for a re-pointed decision");
  });

  it("P2 (a)+(b) PROOF MINTED IN THE ATTACKER'S OWN CLUB through the real decide route, copied whole into the victim club → pending", async () => {
    const victimClub = await mkClub("p2-a");
    const attackerClub = await mkClub("p2-b");
    const mal = await mkOld(victimClub, N("Mal Lory"), E("mal"));
    const decoy = await mkOld(attackerClub, N("Any One"), E("decoy"));
    const key = teamupPersonKey(N(VIC), E("vic")); // the victim's name + address are all the attacker needs
    const r = await call(attackerClub, { action: "decide", decisions: [{ kind: "person", sourceKey: key, action: "member", targetId: decoy }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const [minted] = await rowsOf(attackerClub, (await mappingOf(attackerClub, key)).id);
    const forged = await forgedMapping(victimClub, key, mal);
    await insertRow(victimClub, forged.id, { ...minted.metadata, after: { action: "member", targetId: mal } }, minted.createdAt);
    await importVictim(victimClub, N(VIC), E("vic"));
    await expectNotBound(victimClub, mal, "P2: a proof minted in another club vouched for a forged decision");
  });

  it("X1 (a)+(b) CROSS-CLUB RE-HOME: a decision minted in club B moved whole into club A (mapping, its row and the target; only the club differs) does not verify in A", async () => {
    const clubA = await mkClub("x1-a");
    const clubB = await mkClub("x1-b");
    const key = teamupPersonKey(N(VIC), E("vic")); // identical source key in both clubs
    const decoy = await mkOld(clubB, N("Mal Moved"), E("moved"));
    const r = await call(clubB, { action: "decide", decisions: [{ kind: "person", sourceKey: key, action: "member", targetId: decoy }] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const m = await mappingOf(clubB, key);
    await withRlsBypass(async (tx) => {
      await tx.$executeRaw`UPDATE "Member" SET "tenantId" = ${clubA.tenantId} WHERE id = ${decoy}`;
      await tx.$executeRaw`UPDATE "ImportSourceMapping" SET "tenantId" = ${clubA.tenantId} WHERE id = ${m.id}`;
      await tx.$executeRaw`UPDATE "AuditLog" SET "tenantId" = ${clubA.tenantId} WHERE "entityId" = ${m.id} AND action = ${ACTION}`;
    });
    const inputs = await importVictim(clubA, N(VIC), E("vic"));
    expect(inputs.unprovenDecisions).toContain(m.id);
    await expectNotBound(clubA, decoy, "X1: a decision minted in club B verified in club A");
  });

  it("P3 WRONG-KEY DIGEST (R4 form): a forged mapping whose row carries a digest under another key → pending", async () => {
    const club = await mkClub("p3");
    const mal = await mkOld(club, N("Mal Lory"), E("mal"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    const forged = await forgedMapping(club, key, mal);
    const wrong = createHmac("sha256", "secd3-not-the-signing-key").update(`import-source-key:v1:person\u0001${key}`).digest("hex");
    await insertRow(club, forged.id, { kind: "person", source: LEDGER_SOURCE, sourceKeyDigest: wrong, before: null, after: { action: "member", targetId: mal }, via: "decide" });
    const inputs = await importVictim(club, N(VIC), E("vic"));
    expect(inputs.unprovenDecisions).toContain(forged.id);
    await expectNotBound(club, mal, "P3: a digest under another key vouched");
  });

  it("P3b WRONG KEY, CORRECT TUPLE: the row is right in every field (digest copied from a real decision, chain, date) but the proof is under another key → pending", async () => {
    const club = await mkClub("p3b");
    const right = await mkOld(club, N("Vee Right"), E("right"));
    const mal = await mkOld(club, N("Mal Lory"), E("mal"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    expect(await decide(club, key, right)).toBeNull();
    const m = await mappingOf(club, key);
    await withRlsBypass((tx) => tx.$executeRaw`UPDATE "ImportSourceMapping" SET "targetId" = ${mal} WHERE id = ${m.id}`);
    await forgeUnder(club, "secd3-not-the-signing-key", m.id, key, mal);
    const inputs = await importVictim(club, N(VIC), E("vic"));
    expect(inputs.unprovenDecisions).toContain(m.id);
    await expectNotBound(club, mal, "P3b: a proof under another key vouched");
  });

  it("E1 EMPTY KEY: a proof computed with an EMPTY signing key over the correct tuple is refused (process signs with a real key)", async () => {
    const club = await mkClub("e1");
    const mal = await mkOld(club, N("Mal Lory"), E("mal"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    const forged = await forgedMapping(club, key, mal);
    await forgeUnder(club, "", forged.id, key, mal);
    const inputs = await importVictim(club, N(VIC), E("vic"));
    expect(inputs.unprovenDecisions).toContain(forged.id);
    await expectNotBound(club, mal, "E1: an empty-key proof vouched");
  });

  it("E2 EMPTY KEY IN THE PROCESS: with no signing secret the importer trusts no decision — not one it saved itself, not one proven under the empty key", async () => {
    const club = await mkClub("e2");
    const right = await mkOld(club, N("Vee Right"), E("right"));
    const mal = await mkOld(club, N("Mal Lory"), E("mal"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    const key2 = teamupPersonKey(N("Other Person"), E("other"));
    const saved = { n: process.env.NEXTAUTH_SECRET, a: process.env.AUTH_SECRET };
    try {
      delete process.env.NEXTAUTH_SECRET;
      delete process.env.AUTH_SECRET;
      vi.resetModules();
      const fresh = await import("@/lib/attendance-import");
      const ctx = await import("@/lib/prisma-tenant");
      expect(await ctx.withTenantContext(club.tenantId, (tx) => fresh.saveDecisions(tx, club.tenantId, club.userId, [{ kind: "person", sourceKey: key, action: "member", targetId: right }]))).toBeNull();
      const own = await rowsOf(club, (await mappingOf(club, key)).id);
      expect(own[0].metadata.proof ?? null, "no proof is minted under an empty key").toBeNull();
      const forged = await forgedMapping(club, key2, mal);
      await forgeUnder(club, "", forged.id, key2, mal); // exactly what the module would compute with an empty root
      const inputs = await ctx.withTenantContext(club.tenantId, (tx) => fresh.loadClubInputs(tx, club.tenantId));
      expect(inputs.decisions.person[key]).toEqual({ action: "pending" });
      expect(inputs.decisions.person[key2], "E2: an empty-key proof vouched in an empty-key process").toEqual({ action: "pending" });
    } finally {
      if (saved.n === undefined) delete process.env.NEXTAUTH_SECRET; else process.env.NEXTAUTH_SECRET = saved.n;
      if (saved.a === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = saved.a;
      vi.resetModules();
    }
  });

  it("P4 OLDER MATCHING ROW: owner decided mal, then right; raw UPDATE back to mal → the latest row disagrees → pending", async () => {
    const club = await mkClub("p4");
    const right = await mkOld(club, N("Vee Right"), E("right"));
    const mal = await mkOld(club, N("Mal Lory"), E("mal"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    expect(await decide(club, key, mal)).toBeNull();
    expect(await decide(club, key, right)).toBeNull();
    const m = await mappingOf(club, key);
    await withRlsBypass((tx) => tx.$executeRaw`UPDATE "ImportSourceMapping" SET "targetId" = ${mal} WHERE id = ${m.id}`);
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, mal, "P4: an older provenance row vouched although a newer one disagrees");
  });

  it("P6 REPLAYED OLDER ROW: the older (mal) row copied as a new latest row → its proof is bound to its own date and chain → pending", async () => {
    const club = await mkClub("p6");
    const right = await mkOld(club, N("Vee Right"), E("right"));
    const mal = await mkOld(club, N("Mal Lory"), E("mal"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    expect(await decide(club, key, mal)).toBeNull();
    expect(await decide(club, key, right)).toBeNull();
    const m = await mappingOf(club, key);
    const [older] = await rowsOf(club, m.id);
    await withRlsBypass((tx) => tx.$executeRaw`UPDATE "ImportSourceMapping" SET "targetId" = ${mal} WHERE id = ${m.id}`);
    await insertRow(club, m.id, { ...older.metadata });
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, mal, "P6: a replayed older row vouched");
  });

  it("P5 KEY ROTATION: a decision saved under K1 is held pending when the process signs with K2; re-deciding under K2 binds", async () => {
    const club = await mkClub("p5");
    const right = await mkOld(club, N("Vee Right"), E("right"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    expect(await decide(club, key, right)).toBeNull();
    const m = await mappingOf(club, key);
    const saved = { n: process.env.NEXTAUTH_SECRET, a: process.env.AUTH_SECRET };
    try {
      process.env.NEXTAUTH_SECRET = `secd3-rotated-${Date.now()}`;
      vi.resetModules();
      const fresh = await import("@/lib/attendance-import");
      const freshCtx = await import("@/lib/prisma-tenant");
      const after = await freshCtx.withTenantContext(club.tenantId, (tx) => fresh.loadClubInputs(tx, club.tenantId));
      expect(after.decisions.person[key]).toEqual({ action: "pending" });
      expect(after.unprovenDecisions).toContain(m.id);
      expect(await freshCtx.withTenantContext(club.tenantId, (tx) => fresh.saveDecisions(tx, club.tenantId, club.userId, [{ kind: "person", sourceKey: key, action: "member", targetId: right }]))).toBeNull();
      const again = await freshCtx.withTenantContext(club.tenantId, (tx) => fresh.loadClubInputs(tx, club.tenantId));
      expect(again.decisions.person[key]).toEqual({ action: "member", targetId: right });
      // AUTH_SECRET alone does not matter while NEXTAUTH_SECRET is set (lib/auth-secret.ts prefers NEXTAUTH_SECRET).
      process.env.AUTH_SECRET = `secd3-other-${Date.now()}`;
      vi.resetModules();
      const fresh2 = await import("@/lib/attendance-import");
      const ctx2 = await import("@/lib/prisma-tenant");
      const third = await ctx2.withTenantContext(club.tenantId, (tx) => fresh2.loadClubInputs(tx, club.tenantId));
      expect(third.decisions.person[key]).toEqual({ action: "member", targetId: right });
    } finally {
      if (saved.n === undefined) delete process.env.NEXTAUTH_SECRET; else process.env.NEXTAUTH_SECRET = saved.n;
      if (saved.a === undefined) delete process.env.AUTH_SECRET; else process.env.AUTH_SECRET = saved.a;
      vi.resetModules();
    }
  });

  it("F1 FUTURE-DATED ROW: a row right in every field and proven under the REAL key but dated a day ahead is refused", async () => {
    const club = await mkClub("f1");
    const mal = await mkOld(club, N("Mal Lory"), E("mal"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    const forged = await forgedMapping(club, key, mal);
    await forgeUnder(club, KEY.root, forged.id, key, mal, new Date(Date.now() + 86_400_000));
    const inputs = await importVictim(club, N(VIC), E("vic"));
    expect(inputs.unprovenDecisions).toContain(forged.id);
    await expectNotBound(club, mal, "F1: a future-dated row vouched");
  });

  it("F1 CONTROL: the same row proven under the real key and dated now DOES bind (so F1 refuses on the date alone)", async () => {
    const club = await mkClub("f1c");
    const right = await mkOld(club, N("Vee Right"), E("right"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    const m = await forgedMapping(club, key, right);
    await forgeUnder(club, KEY.root, m.id, key, right, new Date(Date.now() - 1000));
    await importVictim(club, N(VIC), E("vic"));
    await expectBound(club, right);
  });

  it("F2 NEWER UNPROVEN ROW: a raw row dated after the owner's decision makes the decision untrusted (latest row only — never fall back to an older one)", async () => {
    const club = await mkClub("f2");
    const right = await mkOld(club, N("Vee Right"), E("right"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    expect(await decide(club, key, right)).toBeNull();
    const m = await mappingOf(club, key);
    await insertRow(club, m.id, { kind: "person", source: LEDGER_SOURCE, before: null, after: { action: "member", targetId: right }, via: "decide" }, new Date(Date.now() + 1000));
    const inputs = await withTenantContext(club.tenantId, (tx) => loadClubInputs(tx, club.tenantId));
    expect(inputs.decisions.person[key]).toEqual({ action: "pending" });
    expect(inputs.unprovenDecisions).toContain(m.id);
  });

  it("C1 CHAIN: deleting an earlier provenance row breaks the latest row's link → pending (history cannot be pruned silently)", async () => {
    const club = await mkClub("c1");
    const first = await mkOld(club, N("Fay First"), E("fay"));
    const right = await mkOld(club, N("Vee Right"), E("right"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    expect(await decide(club, key, first)).toBeNull();
    expect(await decide(club, key, right)).toBeNull();
    const m = await mappingOf(club, key);
    const [older] = await rowsOf(club, m.id);
    await withRlsBypass((tx) => tx.auditLog.delete({ where: { id: older.id } }));
    const inputs = await withTenantContext(club.tenantId, (tx) => loadClubInputs(tx, club.tenantId));
    expect(inputs.decisions.person[key]).toEqual({ action: "pending" });
  });

  openIt("OPEN (a) TAIL TRUNCATION: delete the latest row and re-point to the older owner decision → bound [rollback to a prior owner decision needs AuditLog DELETE; closed by SF-57 v2 append-only, not by a MAC]", async () => {
    const club = await mkClub("t1");
    const mal = await mkOld(club, N("Mal Lory"), E("mal"));
    const right = await mkOld(club, N("Vee Right"), E("right"));
    const key = teamupPersonKey(N(VIC), E("vic"));
    expect(await decide(club, key, mal)).toBeNull();
    expect(await decide(club, key, right)).toBeNull();
    const m = await mappingOf(club, key);
    const rows = await rowsOf(club, m.id);
    await withRlsBypass(async (tx) => {
      await tx.auditLog.delete({ where: { id: rows[1].id } });
      await tx.$executeRaw`UPDATE "ImportSourceMapping" SET "targetId" = ${mal} WHERE id = ${m.id}`;
    });
    await importVictim(club, N(VIC), E("vic"));
    await expectNotBound(club, mal, "tail truncation restored an older owner decision");
  });
});
