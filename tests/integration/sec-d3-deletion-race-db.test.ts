// Security lane D3 (iteration 2, 9 Oct 2026) — review R4 §3 residual 1: the release digest must be of the address the
// deletion ACTUALLY released.
//
// R4 found member DELETE and DSAR erase digest an address read in an EARLIER transaction, and child DELETE (and staff
// DELETE) read it inside the transaction without a lock — so an address changed and committed in the window was
// released with the OLD address digested, and the importer's release gate never learned the new one was free.
//
// Each cell drives the REAL route and changes the address on a SECOND real connection at a point inside the window:
//   in-tx  — inside the deletion transaction, just before the row is deleted / scrubbed (a conditional
//            UPDATE … WHERE email = old, so it applies only if it gets in before the deletion);
//   pre-tx — after the route's earlier read and before its deletion transaction starts (committed).
// The assertion is the invariant: whichever address the row held when it was removed, THAT address's keyed release
// digest is recorded, and the other one's is not (for the DSAR pre-tx case the fix refuses with 409 and erases
// nothing, which also keeps the invariant). The second connection is a real pg connection from the pool.
//
// Runs only through the guarded runners (owner role / matflow_app with RLS), TEST branch. Prefix secd3r-; count-checked
// teardown of this file's clubs only.
import { vi, describe, it, expect, beforeAll, afterAll } from "vitest";

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
const gate = vi.hoisted(() => ({ current: null as null | { tenantId: string; userId: string; memberId?: string } }));
const sessionOf = () => (gate.current ? { user: { id: gate.current.userId, tenantId: gate.current.tenantId, role: "owner", ...(gate.current.memberId ? { memberId: gate.current.memberId } : {}) } } : null);
vi.mock("@/auth", () => ({ auth: vi.fn(async () => sessionOf()), signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));
vi.mock("@/lib/api-authz", async (importOriginal) => {
  const ok = async () => {
    if (!gate.current) throw new Error("no club in scope");
    return { ok: true, tenantId: gate.current.tenantId, userId: gate.current.userId, session: sessionOf() };
  };
  return { ...(await importOriginal<typeof import("@/lib/api-authz")>()), requireApiOwner: vi.fn(ok), requireApiOwnerOrManager: vi.fn(ok), requireApiRole: vi.fn(ok) };
});

// One-shot hook: the next call of tx.<model>.<op> whose args match fires `fire` first (inside the caller's transaction).
type Hook = { model: string; op: string; match: (args: unknown) => boolean; fire: () => Promise<void> } | null;
const HOOK = vi.hoisted(() => ({ current: null as Hook }));
vi.mock("@/lib/prisma-tenant", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/prisma-tenant")>();
  const wrap = <T extends object>(tx: T): T =>
    new Proxy(tx, {
      get(t, p) {
        const v = Reflect.get(t, p);
        if (typeof v === "function") return v.bind(t);
        if (v && typeof v === "object" && typeof p === "string") {
          return new Proxy(v as object, {
            get(d, op) {
              const f = Reflect.get(d, op);
              if (typeof f !== "function") return f;
              return async (args: unknown) => {
                const h = HOOK.current;
                if (h && h.model === p && h.op === op && h.match(args)) {
                  HOOK.current = null;
                  await h.fire();
                }
                return f.call(d, args);
              };
            },
          });
        }
        return v;
      },
    });
  return {
    ...real,
    withTenantContext: (tenantId: string, fn: (tx: never) => Promise<unknown>, opts?: unknown) =>
      real.withTenantContext(tenantId, (tx) => fn(wrap(tx) as never), opts as never),
  };
});

import { withRlsBypass } from "@/lib/prisma-tenant";
import { DELETE as memberDelete } from "@/app/api/members/[id]/route";
import { DELETE as childDelete } from "@/app/api/member/children/[id]/route";
import { DELETE as staffDelete } from "@/app/api/staff/[id]/route";
import { POST as dsarErase } from "@/app/api/admin/dsar/erase/route";
import { emailDigest } from "@/lib/login-email";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `secd3r-${Date.now().toString(36)}`;
const N = (who: string) => `secD3R ${who}`;
const E = (who: string) => `${STAMP}-${who}@example.test`;
const ORIGIN = { origin: "https://test.local", host: "test.local" };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Club = { tenantId: string; userId: string };
const clubs: Club[] = [];
async function mkClub(label: string): Promise<Club> {
  const club = await withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, timezone: "Europe/London", onboardingCompleted: true } });
    const u = await tx.user.create({ data: { tenantId: t.id, email: E(`${label}-owner`), name: "secD3R Owner", role: "owner", passwordHash: "x" } });
    return { tenantId: t.id, userId: u.id };
  });
  clubs.push(club);
  return club;
}
const mkMember = (club: Club, name: string, email: string, extra: Record<string, unknown> = {}) =>
  withRlsBypass((tx) => tx.member.create({ data: { tenantId: club.tenantId, name, email, ...extra }, select: { id: true } })).then((r) => r.id);

/** Is this address's keyed release digest recorded anywhere in the club's audit trail? */
const digestRecorded = async (club: Club, email: string) => {
  const d = emailDigest(email);
  const rows = await withRlsBypass((tx) => tx.$queryRaw<{ n: bigint }[]>`
    SELECT count(*) AS n FROM "AuditLog" WHERE "tenantId" = ${club.tenantId}
      AND (metadata->>'releasedEmailSha256' = ${d} OR metadata->'releasedEmailSha256' ? ${d})`);
  return Number(rows[0]?.n ?? 0) > 0;
};

/** Change the address on a second connection: `UPDATE … SET email = new WHERE id AND email = old`. */
function startChange(table: "Member" | "User", id: string, oldE: string, newE: string) {
  const p = withRlsBypass((tx) => table === "Member"
    ? tx.$executeRaw`UPDATE "Member" SET email = ${newE} WHERE id = ${id} AND email = ${oldE}`
    : tx.$executeRaw`UPDATE "User" SET email = ${newE} WHERE id = ${id} AND email = ${oldE}`);
  p.catch(() => {});
  return p;
}
type Race = { done: Promise<number> | null; blockedInWindow: boolean | null };
/** Arm a hook that starts the change and waits up to 1.5 s for it inside the window (a lock makes it wait longer). */
function armInTx(race: Race, model: string, op: string, match: (args: unknown) => boolean, table: "Member" | "User", id: string, oldE: string, newE: string) {
  HOOK.current = {
    model, op, match,
    fire: async () => {
      race.done = startChange(table, id, oldE, newE);
      race.blockedInWindow = (await Promise.race([race.done.then(() => "done"), sleep(1500).then(() => "pending")])) === "pending";
    },
  };
}
/** Arm a hook that commits the change completely before the route goes on (the pre-transaction window). */
function armPreTx(race: Race, model: string, op: string, table: "Member" | "User", id: string, oldE: string, newE: string) {
  HOOK.current = {
    model, op, match: () => true,
    fire: async () => { race.done = startChange(table, id, oldE, newE); await race.done; race.blockedInWindow = false; },
  };
}
const whereId = (id: string) => (args: unknown) => (args as { where?: { id?: unknown } } | undefined)?.where?.id === id;

/** The invariant: the digest recorded is of the address the row held when it was removed — never only the other one. */
async function expectDigestOfReleased(club: Club, race: Race, oldE: string, newE: string, label: string) {
  expect(race.done, `${label}: the hook fired`).not.toBeNull();
  const applied = await race.done!;
  const released = applied === 1 ? newE : oldE;
  const other = applied === 1 ? oldE : newE;
  process.stderr.write(`[secd3r] ${label}: change applied=${applied} blockedInWindow=${race.blockedInWindow} released=${applied === 1 ? "NEW" : "OLD"}\n`);
  expect({ releasedDigested: await digestRecorded(club, released), otherDigested: await digestRecorded(club, other) }, `${label}: release digest must be of the released address`)
    .toEqual({ releasedDigested: true, otherDigested: false });
}

afterAll(async () => {
  if (!HAS_DB) return;
  HOOK.current = null;
  const ids = clubs.map((c) => c.tenantId);
  for (const tenantId of ids) {
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId, parentMemberId: { not: null } } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.delete({ where: { id: tenantId } });
    }, { timeout: 60_000 });
  }
  const left = await withRlsBypass(async (tx) => ({
    tenants: await tx.tenant.count({ where: { slug: { startsWith: STAMP } } }),
    members: await tx.member.count({ where: { OR: [{ tenantId: { in: ids } }, { email: { startsWith: STAMP } }] } }),
    users: await tx.user.count({ where: { OR: [{ tenantId: { in: ids } }, { email: { startsWith: STAMP } }] } }),
    audit: await tx.auditLog.count({ where: { tenantId: { in: ids } } }),
  }));
  expect(left).toEqual({ tenants: 0, members: 0, users: 0, audit: 0 });
  process.stderr.write(`[secd3r] teardown: ${ids.length} clubs removed, 0 rows left\n`);
}, 240_000);

describe.skipIf(!HAS_DB)("D3 — the release digest is of the address actually released (REAL routes, two connections, TEST DB)", () => {
  beforeAll(async () => {
    const who = await withRlsBypass((tx) => tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`);
    if (process.env.RLS_ENFORCED === "1") expect(who[0]?.current_user).toBe("matflow_app");
    else expect(who[0]?.current_user).not.toBe("matflow_app");
    process.stderr.write(`[secd3r] role ${who[0]?.current_user} RLS_ENFORCED=${process.env.RLS_ENFORCED ?? "0"}\n`);
  });

  it("CONTROL: member DELETE with no concurrent change digests its address", async () => {
    const club = await mkClub("ctl");
    const oldE = E("ctl-old");
    const id = await mkMember(club, N("Ctl"), oldE);
    gate.current = { tenantId: club.tenantId, userId: club.userId };
    const res = (await memberDelete(new Request(`https://test.local/api/members/${id}?confirm=1`, { method: "DELETE", headers: ORIGIN }), { params: Promise.resolve({ id }) })) as unknown as { status: number };
    expect(res.status).toBe(200);
    expect(await digestRecorded(club, oldE)).toBe(true);
  });

  it("member DELETE, pre-tx: an address change committed after the preflight read → the digest is of the NEW (released) address", async () => {
    const club = await mkClub("m-pre");
    const oldE = E("m-pre-old"), newE = E("m-pre-new");
    const id = await mkMember(club, N("Mem Pre"), oldE);
    const race: Race = { done: null, blockedInWindow: null };
    armPreTx(race, "tenant", "findUnique", "Member", id, oldE, newE);
    gate.current = { tenantId: club.tenantId, userId: club.userId };
    const res = (await memberDelete(new Request(`https://test.local/api/members/${id}?confirm=1`, { method: "DELETE", headers: ORIGIN }), { params: Promise.resolve({ id }) })) as unknown as { status: number };
    expect(res.status).toBe(200);
    await expectDigestOfReleased(club, race, oldE, newE, "member DELETE pre-tx");
  });

  it("member DELETE, in-tx: a change attempted inside the deletion transaction cannot slip in under the digest", async () => {
    const club = await mkClub("m-in");
    const oldE = E("m-in-old"), newE = E("m-in-new");
    const id = await mkMember(club, N("Mem In"), oldE);
    const race: Race = { done: null, blockedInWindow: null };
    armInTx(race, "member", "deleteMany", whereId(id), "Member", id, oldE, newE);
    gate.current = { tenantId: club.tenantId, userId: club.userId };
    const res = (await memberDelete(new Request(`https://test.local/api/members/${id}?confirm=1`, { method: "DELETE", headers: ORIGIN }), { params: Promise.resolve({ id }) })) as unknown as { status: number };
    expect(res.status).toBe(200);
    await expectDigestOfReleased(club, race, oldE, newE, "member DELETE in-tx");
  });

  it("member DELETE ?strategy=cascade, in-tx: a CHILD's address changed inside the transaction is digested as released", async () => {
    const club = await mkClub("m-casc");
    const parentE = E("m-casc-parent"), oldE = E("m-casc-old"), newE = E("m-casc-new");
    const parent = await mkMember(club, N("Casc Parent"), parentE, { accountType: "parent" });
    const child = await mkMember(club, N("Casc Child"), oldE, { accountType: "junior", parentMemberId: parent });
    const race: Race = { done: null, blockedInWindow: null };
    armInTx(race, "member", "deleteMany", whereId(child), "Member", child, oldE, newE);
    gate.current = { tenantId: club.tenantId, userId: club.userId };
    const res = (await memberDelete(new Request(`https://test.local/api/members/${parent}?confirm=1&strategy=cascade`, { method: "DELETE", headers: ORIGIN }), { params: Promise.resolve({ id: parent }) })) as unknown as { status: number; json: () => Promise<unknown> };
    expect(res.status, JSON.stringify(await res.json())).toBe(200);
    expect(await digestRecorded(club, parentE)).toBe(true);
    await expectDigestOfReleased(club, race, oldE, newE, "member DELETE cascade child in-tx");
  });

  it("child DELETE, in-tx: a change attempted between the route's read and the delete cannot slip in under the digest", async () => {
    const club = await mkClub("c-in");
    const parent = await mkMember(club, N("Rel Parent"), E("c-in-parent"), { accountType: "parent" });
    const oldE = E("c-in-old"), newE = E("c-in-new");
    const child = await mkMember(club, N("Rel Child"), oldE, { accountType: "junior", parentMemberId: parent, guardianConfirmedAt: new Date("2025-02-01T00:00:00Z") });
    const race: Race = { done: null, blockedInWindow: null };
    armInTx(race, "member", "deleteMany", whereId(child), "Member", child, oldE, newE);
    gate.current = { tenantId: club.tenantId, userId: club.userId, memberId: parent };
    const res = (await childDelete(new Request(`https://test.local/api/member/children/${child}`, { method: "DELETE", headers: ORIGIN }), { params: Promise.resolve({ id: child }) })) as unknown as { status: number };
    expect(res.status).toBe(200);
    await expectDigestOfReleased(club, race, oldE, newE, "child DELETE in-tx");
  });

  it("staff DELETE, in-tx: a change attempted between the route's read and the delete cannot slip in under the digest", async () => {
    const club = await mkClub("s-in");
    const oldE = E("s-in-old"), newE = E("s-in-new");
    const staff = await withRlsBypass((tx) => tx.user.create({ data: { tenantId: club.tenantId, email: oldE, name: N("Coach"), role: "coach", passwordHash: "x" }, select: { id: true } })).then((r) => r.id);
    const race: Race = { done: null, blockedInWindow: null };
    armInTx(race, "user", "deleteMany", whereId(staff), "User", staff, oldE, newE);
    gate.current = { tenantId: club.tenantId, userId: club.userId };
    const res = (await staffDelete(new Request(`https://test.local/api/staff/${staff}`, { method: "DELETE", headers: ORIGIN }), { params: Promise.resolve({ id: staff }) })) as unknown as { status: number };
    expect(res.status).toBe(200);
    await expectDigestOfReleased(club, race, oldE, newE, "staff DELETE in-tx");
  });

  it("DSAR erase, in-tx: a change attempted inside the erase transaction (before the scrub) cannot slip in under the digest", async () => {
    const club = await mkClub("d-in");
    const oldE = E("d-in-old"), newE = E("d-in-new");
    const id = await mkMember(club, N("Dsar In"), oldE);
    const race: Race = { done: null, blockedInWindow: null };
    armInTx(race, "member", "update", whereId(id), "Member", id, oldE, newE);
    gate.current = { tenantId: club.tenantId, userId: club.userId };
    const res = (await dsarErase(new Request(`https://test.local/api/admin/dsar/erase?memberId=${id}`, { method: "POST", headers: ORIGIN }))) as unknown as { status: number };
    expect(res.status).toBe(200);
    await expectDigestOfReleased(club, race, oldE, newE, "DSAR erase in-tx");
  });

  it("DSAR erase, pre-tx: an address change committed after the pre-erase read → refused (409), nothing erased, no stale digest", async () => {
    const club = await mkClub("d-pre");
    const oldE = E("d-pre-old"), newE = E("d-pre-new");
    const id = await mkMember(club, N("Dsar Pre"), oldE);
    const race: Race = { done: null, blockedInWindow: null };
    armPreTx(race, "importSourceMapping", "count", "Member", id, oldE, newE);
    gate.current = { tenantId: club.tenantId, userId: club.userId };
    const res = (await dsarErase(new Request(`https://test.local/api/admin/dsar/erase?memberId=${id}`, { method: "POST", headers: ORIGIN }))) as unknown as { status: number };
    expect(await race.done, "the change committed before the erase transaction").toBe(1);
    const row = await withRlsBypass((tx) => tx.member.findUniqueOrThrow({ where: { id }, select: { email: true } }));
    const erased = await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: club.tenantId, action: "member.dsar_erase" } }));
    expect({ status: res.status, email: row.email === newE ? "NEW" : row.email === oldE ? "OLD" : "other", erased, oldDigested: await digestRecorded(club, oldE) }, "DSAR pre-tx: erased the new address under the old digest")
      .toEqual({ status: 409, email: "NEW", erased: 0, oldDigested: false });
  });
});
