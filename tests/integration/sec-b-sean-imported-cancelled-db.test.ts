// Security lane B (9 Oct 2026) — "Contact-email route refuses no-login records"
// reconciliation. Sean's scenario, reproduced with SYNTHETIC data on the Neon
// TEST branch, under both database roles (owner runner and matflow_app/RLS):
//
//   the club owner should sign in with an address that an IMPORTED, CANCELLED,
//   PASSWORDLESS member already holds.
//
// The member is created by the REAL TeamUp import (lib/importers/teamup.ts via
// the real commit route app/api/admin/import/[id]/commit), so its field state is
// exactly what a real export produces: email = the payer address, passwordHash
// NULL, status "cancelled", paymentStatus "cancelled", externalRef
// "teamup:<email>|<name>", billedBy "teamup", importJobId set. The same file
// carries the shapes that make a record "no-login" or "contact only" in this
// schema: a child on the same address (synthesised @no-login.matflow.local,
// suggested parent link) and a second adult sharing the address (synthesised
// login + unverifiedEmail). An erased record is a fixture shaped exactly like
// the DSAR erase route's write (deleted-<id>@deleted.invalid, cancelled).
//
// Then the hub sequence, through the real routes: check → member contact change
// → re-check → owner login change; then the sign-in lookup auth.ts performs
// (findUnique on (tenantId, email) in User and Member, User wins) on the
// database, and a second import of a changed file after the correction.
//
// Runs only via the guarded runners (scratchpad att/run-engine.sh and
// q78/run-restricted.sh refuse any host but the test branch). Fixture prefix
// secB-; count-checked teardown.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "sec-b-sean-scenario-db-test-secret-0123456789abcdef";
  return {
    jar: new Map<string, string>(),
    files: new Map<string, string>(),
    club: null as null | { tenantId: string; userId: string },
  };
});

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (h.jar.has(n) ? { name: n, value: h.jar.get(n)! } : undefined),
    getAll: () => [...h.jar.entries()].map(([name, value]) => ({ name, value })),
    has: (n: string) => h.jar.has(n),
    set: () => {},
    delete: () => {},
  }),
  headers: async () => new Headers(),
}));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "203.0.113.21",
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => null), signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
// The import's owner gate answers for the synthetic club only; the file is
// served from memory (no blob store locally).
vi.mock("@/lib/api-authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-authz")>()),
  requireApiOwner: vi.fn(async () =>
    h.club ? { ok: true, tenantId: h.club.tenantId, userId: h.club.userId, session: null } : { ok: false, response: new Response(null, { status: 401 }) },
  ),
}));
vi.mock("@/lib/import-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/import-storage")>()),
  readImportFile: vi.fn(async (url: string) => h.files.get(url) ?? null),
  deleteImportFile: vi.fn(async () => {}),
}));

import { prisma } from "@/lib/prisma";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { issueOperatorSession } from "@/lib/operator-auth";
import { STEP_UP_HEADER, issueStepUpGrant, stepUpVersionDigestIn } from "@/lib/operator-step-up";
import { isSynthesisedEmail } from "@/lib/synthesise-kid-email";
import { POST as commit } from "@/app/api/admin/import/[id]/commit/route";
import { POST as checkRoute } from "@/app/api/admin/customers/[id]/login-email/check/route";
import { POST as contactRoute } from "@/app/api/admin/customers/[id]/members/[memberId]/contact-email/route";
import { POST as ownerRoute } from "@/app/api/admin/customers/[id]/login-email/route";

const HAS_DB = !!process.env.DATABASE_URL;
const ROLE = process.env.RLS_ENFORCED === "1" ? "restricted" : "owner";
const STAMP = `secB-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const OP_ID = `${STAMP}-op`;
const E = (who: string) => `${STAMP.toLowerCase()}-${who}@example.test`;
const TARGET = E("founder"); // the owner's intended login; the imported member holds it
const MEMBER_NEW = `${STAMP.toLowerCase()}-founder+member@example.test`; // the member's own address afterwards
const ORIGIN = "http://localhost:3847";
const REASON = "club confirmed by call-back to the number on file; synthetic lane B ticket";

const HEADER =
  "Customer Name,Customer Email,Other Active,Membership Name,Type,Status,Payment Processor,Purchase Date,Start Date,Expiration Date,Cancelled Date,Is First Membership,Completed At,Address Line 1,Address Line 2,City,Region,Postcode,Country,Marketing Preference,Phone,Gender,Date of birth,Emergency Contact Name,Emergency Contact Phone,Emergency Contact Relationship";
type Row = { name: string; email: string; plan: string; status: string; start: string; cancelled?: string; dob?: string };
const csvRow = (r: Row) =>
  [r.name, r.email, "", r.plan, "recurring", r.status, "Stripe", r.start, r.start, "", r.cancelled ?? "", "Yes", "", "1 Invented Road", "", "Townsville", "", "TS1 1AA", "GB", "Yes", "", "", r.dob ?? "", "", "", ""].join(",");
const FILE_1 = [
  HEADER,
  // The founder: one cancelled membership, nothing live → status cancelled.
  csvRow({ name: "Sam Founder", email: TARGET, plan: "Adults Advanced 2026", status: "cancelled", start: "2025-01-06", cancelled: "2025-06-30" }),
  // A second adult on the same address → synthesised login + unverifiedEmail.
  csvRow({ name: "Robin Founder", email: TARGET, plan: "Adults Advanced 2026", status: "active", start: "2025-02-03" }),
  // A child on the same address → synthesised no-login + suggested parent link.
  csvRow({ name: "Kit Founder", email: TARGET, plan: "Kids Unlimited 2026", status: "active", start: "2025-03-03", dob: "2018-05-01" }),
].join("\n");
// A later export with one extra unrelated row (so it is not the same file).
const FILE_2 = [FILE_1, csvRow({ name: "Lee Later", email: E("later"), plan: "Adults Advanced 2026", status: "active", start: "2026-01-05" })].join("\n");

const req = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${ORIGIN}${url}`, {
    method: "POST",
    headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
async function read(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe.skipIf(!HAS_DB)(`Sean's scenario: imported, cancelled, passwordless holder of the owner's address (${ROLE} role)`, () => {
  const ids = { a: "", owner: "", sam: "", robin: "", kit: "", erased: "" };
  const memberSelect = {
    email: true, passwordHash: true, externalRef: true, status: true, paymentStatus: true, cancelledAt: true,
    billedBy: true, importJobId: true, accountType: true, unverifiedEmail: true, sessionVersion: true,
    parentMemberId: true, guardianConfirmedAt: true, name: true, tenantId: true, totpEnabled: true,
  } as const;
  const member = (id: string) => withRlsBypass((tx) => tx.member.findUniqueOrThrow({ where: { id }, select: memberSelect }));
  const check = async (email: string) =>
    read(await checkRoute(req(`/api/admin/customers/${ids.a}/login-email/check`, { email }), { params: Promise.resolve({ id: ids.a }) }));
  const contact = async (memberId: string, body: unknown, grant: string) =>
    read(
      await contactRoute(req(`/api/admin/customers/${ids.a}/members/${memberId}/contact-email`, body, { [STEP_UP_HEADER]: grant }), {
        params: Promise.resolve({ id: ids.a, memberId }),
      }),
    );
  const grantFor = (memberId: string, newEmail: string) =>
    issueStepUpGrant({ operatorId: OP_ID, action: "member.contact_email", targetId: `${ids.a}/${memberId}/change`, change: { newEmail } }).then((g) => g.grant);
  async function runImport(csv: string) {
    const url = `https://blob.test.local/${STAMP}/${Math.random().toString(36).slice(2)}.csv`;
    h.files.set(url, csv);
    const job = await withRlsBypass((tx) =>
      tx.importJob.create({ data: { tenantId: ids.a, createdById: ids.owner, source: "teamup", fileName: `${STAMP}.csv`, fileBlobUrl: url, status: "preview" } }),
    );
    h.club = { tenantId: ids.a, userId: ids.owner };
    const res = await commit(
      new Request(`${ORIGIN}/api/admin/import/${job.id}/commit`, { method: "POST", headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json" }, body: "{}" }),
      { params: Promise.resolve({ id: job.id }) },
    );
    h.club = null;
    return { status: res.status, body: (await res.json()) as Record<string, unknown>, jobId: job.id };
  }

  beforeAll(async () => {
    await prisma.operator.create({
      data: {
        id: OP_ID,
        email: `${STAMP.toLowerCase()}@operator.test`,
        name: "Lane B synthetic operator",
        passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1Q8m0Wq6r5pJ8dYpT0J3yq0QeQe9a",
        totpEnabled: true,
        totpSecret: "SYNTHETICSECRETNOTUSED",
      },
    });
    await withRlsBypass(async (tx) => {
      const a = await tx.tenant.create({ data: { name: `${STAMP} Club`, slug: `${STAMP.toLowerCase()}-a`, onboardingCompleted: true } });
      ids.a = a.id;
      ids.owner = (
        await tx.user.create({
          data: { tenantId: a.id, email: E("owner-placeholder"), name: "Synthetic Founder Owner", role: "owner", passwordHash: "owner-hash-unchanged", totpEnabled: true, totpSecret: "synthetic", totpRecoveryCodes: ["c1", "c2"] },
        })
      ).id;
      for (const [name, isKids] of [["Adults Advanced 2026", false], ["Kids Unlimited 2026", true]] as const) {
        await tx.membershipTier.create({ data: { tenantId: a.id, name, pricePence: 9000, currency: "GBP", billingCycle: "four_weekly", isKids, isActive: true } });
      }
    });
    h.jar.set("matflow_op_session", issueOperatorSession(OP_ID, 0));
  }, 120_000);

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 750)); // best-effort refusal rows land first
    if (ids.a) {
      await withRlsBypass(async (tx) => {
        await tx.auditLog.deleteMany({ where: { tenantId: ids.a } });
        await tx.magicLinkToken.deleteMany({ where: { tenantId: ids.a } });
        await tx.passwordResetToken.deleteMany({ where: { tenantId: ids.a } });
        await tx.memberStatusEvent.deleteMany({ where: { tenantId: ids.a } });
        await tx.importedMembership.deleteMany({ where: { tenantId: ids.a } });
        await tx.member.deleteMany({ where: { tenantId: ids.a, parentMemberId: { not: null } } }); // children first (Member_kids_must_have_parent)
        await tx.member.deleteMany({ where: { tenantId: ids.a } });
        await tx.importJob.deleteMany({ where: { tenantId: ids.a } });
        await tx.membershipTier.deleteMany({ where: { tenantId: ids.a } });
        await tx.user.deleteMany({ where: { tenantId: ids.a } });
        await tx.tenant.delete({ where: { id: ids.a } });
      }, { timeout: 120_000 });
    }
    await withRlsBypass((tx) => tx.auditLog.deleteMany({ where: { tenantId: null, entityType: "Operator", entityId: OP_ID } }));
    await prisma.operator.deleteMany({ where: { id: OP_ID } });
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { slug: { startsWith: STAMP.toLowerCase() } } }),
      members: ids.a ? await tx.member.count({ where: { tenantId: ids.a } }) : 0,
      audit: ids.a ? await tx.auditLog.count({ where: { tenantId: ids.a } }) : 0,
      operators: await tx.operator.count({ where: { id: OP_ID } }),
    }));
    expect(left).toEqual({ tenants: 0, members: 0, audit: 0, operators: 0 });
  }, 180_000);

  it("1. the REAL TeamUp import writes the field states the scenario depends on", async () => {
    const r = await runImport(FILE_1);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const rows = await withRlsBypass((tx) => tx.member.findMany({ where: { tenantId: ids.a }, select: { id: true, ...memberSelect } }));
    const by = (n: string) => rows.find((m) => m.name === n)!;
    const sam = by("Sam Founder"); const robin = by("Robin Founder"); const kit = by("Kit Founder");
    ids.sam = sam.id; ids.robin = robin.id; ids.kit = kit.id;
    // The founder: a REAL address, no password, cancelled, import identity set.
    expect(sam).toMatchObject({
      email: TARGET, passwordHash: null, status: "cancelled", paymentStatus: "cancelled", billedBy: "teamup",
      importJobId: r.jobId, accountType: "adult", unverifiedEmail: null, externalRef: `teamup:${TARGET}|sam founder`,
    });
    expect(sam.cancelledAt?.toISOString().slice(0, 10)).toBe("2025-06-30");
    // Second adult on the address: synthesised login, the address as contact only.
    expect(isSynthesisedEmail(robin.email)).toBe(true);
    expect(robin.unverifiedEmail).toBe(TARGET);
    // Child: synthesised no-login, SUGGESTED (unconfirmed) link to the founder.
    expect(isSynthesisedEmail(kit.email)).toBe(true);
    expect(kit).toMatchObject({ parentMemberId: ids.sam, guardianConfirmedAt: null, passwordHash: null });
    // The erased shape the DSAR erase route writes (sentinel + cancelled).
    ids.erased = (
      await withRlsBypass((tx) => tx.member.create({ data: { tenantId: ids.a, name: "Erased member", email: `${STAMP.toLowerCase()}-tmp@example.test`, status: "cancelled" } }))
    ).id;
    await withRlsBypass((tx) => tx.member.update({ where: { id: ids.erased }, data: { email: `deleted-${ids.erased}@deleted.invalid` } }));
  });

  let samVersion = "";
  it("2. check: exactly ONE holder (the cancelled founder); the contact-only and no-login rows are not holders", async () => {
    const r = await check(TARGET);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({
      free: false,
      holder: { kind: "member", id: ids.sam, status: "cancelled", access: "none", canSignIn: false },
    });
    samVersion = String((r.body.holder as { version: string }).version);
    expect(samVersion).toMatch(/^[a-f0-9]{64}$/);
  });

  it("3. guard kept: a no-login record (child, shared-address adult) and an erased record are refused 409 managed; a placeholder target 400; nothing written, grant unspent", async () => {
    for (const id of [ids.kit, ids.robin, ids.erased]) {
      const before = await member(id);
      const newEmail = E(`managed-${id.slice(-4)}`);
      const v = await withRlsBypass((tx) => stepUpVersionDigestIn(tx, "member.contact_email", `${ids.a}/${id}/change`));
      const grant = await grantFor(id, newEmail);
      const r = await contact(id, { newEmail, reason: REASON, version: v }, grant);
      expect(r.status, `${id} ${JSON.stringify(r.body)}`).toBe(409);
      expect(r.body.result).toBe("managed");
      expect(await member(id)).toEqual(before);
    }
    const grant = await grantFor(ids.sam, `kid-${"0".repeat(32)}@no-login.matflow.local`);
    const t = await contact(ids.sam, { newEmail: `kid-${"0".repeat(32)}@no-login.matflow.local`, reason: REASON, version: samVersion }, grant);
    expect(t.status).toBe(400);
    expect(t.body.result).toBe("managed");
    expect((await member(ids.sam)).email).toBe(TARGET);
  });

  it("4. the cancelled, imported, passwordless founder CAN be corrected: email only; import identity, standing, links untouched", async () => {
    const before = await member(ids.sam);
    const kitBefore = await member(ids.kit);
    const robinBefore = await member(ids.robin);
    const r = await contact(ids.sam, { newEmail: MEMBER_NEW, reason: REASON, version: samVersion }, await grantFor(ids.sam, MEMBER_NEW));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body).toMatchObject({ ok: true, memberId: ids.sam, canSignIn: false });
    const after = await member(ids.sam);
    expect(after.email).toBe(MEMBER_NEW);
    expect({ ...after, email: "(compared above)" }).toEqual({ ...before, email: "(compared above)" }); // externalRef, status, paymentStatus, cancelledAt, billedBy, importJobId, passwordHash, sessionVersion
    expect(await member(ids.kit)).toEqual(kitBefore); // suggested link to the founder kept
    expect(await member(ids.robin)).toEqual(robinBefore);
  });

  it("5. re-check free → owner login change → the owner holds the address; sign-in lookup resolves to the OWNER (User wins, no member row)", async () => {
    expect((await check(TARGET)).body).toMatchObject({ free: true, sameAsOwner: false });
    const { grant } = await issueStepUpGrant({ operatorId: OP_ID, action: "owner.login_email", targetId: `${ids.a}/${ids.owner}/change`, change: { newEmail: TARGET } });
    const r = await read(
      await ownerRoute(req(`/api/admin/customers/${ids.a}/login-email`, { action: "change", reason: REASON, newEmail: TARGET }, { [STEP_UP_HEADER]: grant }), {
        params: Promise.resolve({ id: ids.a }),
      }),
    );
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    // auth.ts Credentials: withTenantContext(tenant) → findUnique by (tenantId, email) in both tables.
    const [user, mem] = await withTenantContext(ids.a, (tx) =>
      Promise.all([
        tx.user.findUnique({ where: { tenantId_email: { tenantId: ids.a, email: TARGET } }, select: { id: true, role: true, passwordHash: true, loginEmailProvisionalSince: true } }),
        tx.member.findUnique({ where: { tenantId_email: { tenantId: ids.a, email: TARGET } }, select: { id: true } }),
      ]),
    );
    expect(user).toMatchObject({ id: ids.owner, role: "owner", passwordHash: "owner-hash-unchanged" });
    expect(user?.loginEmailProvisionalSince).not.toBeNull();
    expect(mem).toBeNull();
    // The founder signs in (if ever) on their own address; still the same record.
    const own = await withTenantContext(ids.a, (tx) => tx.member.findUnique({ where: { tenantId_email: { tenantId: ids.a, email: MEMBER_NEW } }, select: { id: true } }));
    expect(own?.id).toBe(ids.sam);
  });

  it("6. a later TeamUp import after the correction creates no second founder and never touches the owner's login", async () => {
    const ownerBefore = await withRlsBypass((tx) => tx.user.findUniqueOrThrow({ where: { id: ids.owner }, select: { email: true, sessionVersion: true, role: true } }));
    const r = await runImport(FILE_2);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const founders = await withRlsBypass((tx) => tx.member.findMany({ where: { tenantId: ids.a, name: "Sam Founder" }, select: { id: true, email: true } }));
    expect(founders).toEqual([{ id: ids.sam, email: MEMBER_NEW }]);
    expect(await withRlsBypass((tx) => tx.user.findUniqueOrThrow({ where: { id: ids.owner }, select: { email: true, sessionVersion: true, role: true } }))).toEqual(ownerBefore);
    // Nobody but the owner holds the address in this club.
    const holders = await withRlsBypass((tx) => tx.member.count({ where: { tenantId: ids.a, email: TARGET } }));
    expect(holders).toBe(0);
  });
});
