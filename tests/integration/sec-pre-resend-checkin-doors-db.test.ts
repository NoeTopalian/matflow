// Pre-Resend adversarial pass (W6, owner instruction of 28 Oct 2026): the
// check-in doors as they stand on the pre-Resend candidate, attacked through
// their real route handlers against the Neon TEST branch, as both database
// roles (db-tests.mjs: the owner role, then matflow_app with RLS enforced).
//
// Doors: POST /api/checkin (self, parent, admin, auto), DELETE /api/checkin,
// POST /api/checkin/card, POST /api/kiosk/[token]/checkin and the coach tick
// POST /api/coach/instances/[id]/attendance.
//
// Every test asserts the SECURE outcome. Synthetic data only: two fixture
// clubs created and torn down here, example.test addresses. No provider is
// reached: email, Sentry and audit are replaced below, the rate limiter is
// replaced (it would otherwise write buckets), and nothing here imports Stripe.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class extends Request {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));
const authState = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: () => "203.0.113.7",
}));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn(async (entry: Record<string, unknown>) => {
    audit.calls.push(entry);
  }),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import type { Prisma } from "@prisma/client";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { hashToken } from "@/lib/token-hash";
import { signCardToken } from "@/lib/card-token";
import { signKioskMemberToken } from "@/lib/kiosk-token";
import { performCheckin } from "@/lib/checkin";
import { POST as checkinPost, DELETE as checkinDelete } from "@/app/api/checkin/route";
import { POST as cardPost } from "@/app/api/checkin/card/route";
import { POST as kioskPost } from "@/app/api/kiosk/[token]/checkin/route";
import { POST as tickPost } from "@/app/api/coach/instances/[id]/attendance/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const DAY = 86_400_000;
// Each case walks several doors in sequence over the network (Neon latency).
vi.setConfig({ testTimeout: 240_000 });

type Res = { status: number; body: Record<string, unknown> };
async function read(res: unknown): Promise<Res> {
  const r = res as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: r.status, body: await r.json() };
}

/** A UTC session that is on now: the clubs below run on UTC with a 3-hour window either side. */
function nowSlot(offsetMin = 0): { date: Date; startTime: string; endTime: string } {
  const now = new Date(Date.now() + offsetMin * 60_000);
  const date = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const end = new Date(now.getTime() + 60 * 60_000);
  const endTime = `${String(end.getUTCHours()).padStart(2, "0")}:${String(end.getUTCMinutes()).padStart(2, "0")}`;
  return { date, startTime: `${hh}:${mm}`, endTime };
}

describe.skipIf(!HAS_DB)("W6 pre-Resend: check-in doors under attack (real database)", () => {
  const club = { A: "", B: "" };
  const kioskRaw = { A: `kiosk-a-${STAMP}-0123456789abcdef`, B: `kiosk-b-${STAMP}-0123456789abcdef` };
  const users = { ownerA: "", coachA: "", ownerB: "" };
  const tier = { A: "", B: "" };
  const packProduct = { A: "", B: "" };
  let seq = 0;

  const ownerA = () => ({ user: { id: users.ownerA, tenantId: club.A, role: "owner", email: `w6-owner-a-${STAMP}@example.test` } });
  const coachA = () => ({ user: { id: users.coachA, tenantId: club.A, role: "coach", email: `w6-coach-a-${STAMP}@example.test` } });
  const memberSession = (tenantId: string, memberId: string, email: string) => ({
    user: { id: `member-user-${memberId}`, tenantId, role: "member", email, memberId },
  });

  async function newMember(tenantId: string, data: Partial<Prisma.MemberUncheckedCreateInput> = {}): Promise<{ id: string; email: string }> {
    seq += 1;
    const email = `w6-${STAMP}-${seq}@example.test`;
    const id = await withRlsBypass(async (tx) => (await tx.member.create({
      data: {
        tenantId, name: `W6 Member ${seq}`, email, waiverAccepted: true, paymentStatus: "paid",
        membershipTierId: tenantId === club.A ? tier.A : tier.B, ...data,
      },
    })).id);
    return { id, email };
  }
  async function nowSession(tenantId: string, opts: { cancelled?: boolean; imported?: boolean } = {}): Promise<string> {
    seq += 1;
    return withRlsBypass(async (tx) => {
      const cls = await tx.class.create({ data: { tenantId, name: `W6 Class ${seq}`, duration: 60, maxCapacity: 100 } });
      const inst = await tx.classInstance.create({
        data: {
          classId: cls.id, ...nowSlot(), isCancelled: !!opts.cancelled,
          ...(opts.imported ? { sourceImportJobId: `w6-fake-import-${STAMP}-${seq}` } : {}),
        },
      });
      return inst.id;
    });
  }
  /** Use the member's one class of the week, through a row a staff mark would write. */
  async function useAllowance(tenantId: string, memberId: string): Promise<void> {
    const inst = await nowSession(tenantId);
    await withRlsBypass((tx) => tx.attendanceRecord.create({ data: { tenantId, memberId, classInstanceId: inst, checkInMethod: "admin" } }));
  }
  async function givePack(tenantId: string, memberId: string, data: Partial<Prisma.MemberClassPackUncheckedCreateInput> = {}): Promise<string> {
    return withRlsBypass(async (tx) => (await tx.memberClassPack.create({
      data: {
        tenantId, memberId, packId: tenantId === club.A ? packProduct.A : packProduct.B,
        creditsRemaining: 3, status: "active", expiresAt: new Date(Date.now() + 30 * DAY), ...data,
      },
    })).id);
  }
  const credits = (packId: string) => withRlsBypass(async (tx) => (await tx.memberClassPack.findUnique({ where: { id: packId } }))?.creditsRemaining);
  const rows = (memberId: string, classInstanceId?: string) =>
    withRlsBypass((tx) => tx.attendanceRecord.count({ where: { memberId, ...(classInstanceId ? { classInstanceId } : {}) } }));

  // ── the doors ──────────────────────────────────────────────────────────────
  async function checkin(session: unknown, body: Record<string, unknown>): Promise<Res> {
    authState.session = session;
    return read(await checkinPost(new Request("https://test.local/api/checkin", { method: "POST", body: JSON.stringify(body) })));
  }
  async function uncheck(session: unknown, classInstanceId: string, memberId: string): Promise<Res> {
    authState.session = session;
    return read(await checkinDelete(new Request(`https://test.local/api/checkin?classInstanceId=${classInstanceId}&memberId=${memberId}`, { method: "DELETE" })));
  }
  async function card(session: unknown, classInstanceId: string, tokens: string[]): Promise<Res> {
    authState.session = session;
    return read(await cardPost(new Request("https://test.local/api/checkin/card", { method: "POST", body: JSON.stringify({ classInstanceId, tokens }) })));
  }
  async function kiosk(raw: string, kioskMemberToken: string, classInstanceId: string): Promise<Res> {
    authState.session = null;
    return read(await kioskPost(
      new Request(`https://test.local/api/kiosk/${raw}/checkin`, { method: "POST", body: JSON.stringify({ kioskMemberToken, classInstanceId }) }),
      { params: Promise.resolve({ token: raw }) },
    ));
  }
  async function tick(session: unknown, instanceId: string, body: Record<string, unknown>): Promise<Res> {
    authState.session = session;
    return read(await tickPost(
      new Request(`https://test.local/api/coach/instances/${instanceId}/attendance`, { method: "POST", body: JSON.stringify(body) }),
      { params: Promise.resolve({ id: instanceId }) },
    ));
  }

  beforeAll(async () => {
    process.env.EMAIL_DELIVERY = "off";
    await withRlsBypass(async (tx) => {
      for (const k of ["A", "B"] as const) {
        const t = await tx.tenant.create({
          data: {
            name: `W6 Club ${k} ${STAMP}`, slug: `w6-${k.toLowerCase()}-${STAMP}`, timezone: "UTC",
            checkinWindowBeforeMin: 180, checkinWindowAfterMin: 180, subscriptionStatus: "active",
            kioskTokenHash: hashToken(kioskRaw[k]),
          },
        });
        club[k] = t.id;
        tier[k] = (await tx.membershipTier.create({ data: { tenantId: t.id, name: "One a week", classLimit: 1, classLimitBasis: "week" } })).id;
        packProduct[k] = (await tx.classPack.create({ data: { tenantId: t.id, name: "Five", totalCredits: 5, validityDays: 60, pricePence: 5000 } })).id;
      }
      users.ownerA = (await tx.user.create({ data: { tenantId: club.A, email: `w6-owner-a-${STAMP}@example.test`, name: "Owner A", role: "owner", passwordHash: "x" } })).id;
      users.coachA = (await tx.user.create({ data: { tenantId: club.A, email: `w6-coach-a-${STAMP}@example.test`, name: "Coach A", role: "coach", passwordHash: "x" } })).id;
      users.ownerB = (await tx.user.create({ data: { tenantId: club.B, email: `w6-owner-b-${STAMP}@example.test`, name: "Owner B", role: "owner", passwordHash: "x" } })).id;
    });
  });

  afterAll(async () => {
    if (!club.A) return;
    const ids = [club.A, club.B].filter(Boolean);
    await withRlsBypass(async (tx) => {
      await tx.classPackRedemption.deleteMany({ where: { memberPack: { tenantId: { in: ids } } } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.memberClassPack.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.classPack.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId: { in: ids } } } });
      await tx.class.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.member.deleteMany({ where: { tenantId: { in: ids }, parentMemberId: { not: null } } });
      await tx.member.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.membershipTier.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.user.deleteMany({ where: { tenantId: { in: ids } } });
      await tx.tenant.deleteMany({ where: { id: { in: ids } } });
    });
  });

  // ── 1. Cross-club substitution of member, class and record IDs ─────────────

  describe("cross-club ID substitution", () => {
    it("register: owner A marking club B's member into A's class is 404 and writes nothing", async () => {
      const b = await newMember(club.B);
      const instA = await nowSession(club.A);
      const r = await checkin(ownerA(), { classInstanceId: instA, memberId: b.id });
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.body)).not.toContain(b.email);
      expect(await rows(b.id)).toBe(0);
    });

    it("register: owner A marking A's member into club B's session is 404 and writes nothing", async () => {
      const a = await newMember(club.A);
      const instB = await nowSession(club.B);
      const r = await checkin(ownerA(), { classInstanceId: instB, memberId: a.id });
      expect(r.status).toBe(404);
      expect(await rows(a.id, instB)).toBe(0);
    });

    it("register: a forged tenantId in the body is ignored (unknown keys are stripped)", async () => {
      const b = await newMember(club.B);
      const instB = await nowSession(club.B);
      const r = await checkin(ownerA(), { classInstanceId: instB, memberId: b.id, tenantId: club.B, allowanceGate: "off" });
      expect(r.status).toBe(404);
      expect(await rows(b.id)).toBe(0);
    });

    it("member app: A's member checking into club B's session is refused class_not_found", async () => {
      const a = await newMember(club.A);
      const instB = await nowSession(club.B);
      const r = await checkin(memberSession(club.A, a.id, a.email), { classInstanceId: instB });
      expect(r.status).toBe(404);
      expect(r.body.reason).toBe("class_not_found");
      expect(await rows(a.id)).toBe(0);
    });

    it("parent: checking in club B's child, an unrelated child, or an unconfirmed link is 404 each time", async () => {
      const parent = await newMember(club.A);
      const parentB = await newMember(club.B);
      const kidB = await newMember(club.B, { accountType: "kids", parentMemberId: parentB.id, guardianConfirmedAt: new Date() });
      const otherParent = await newMember(club.A);
      const strangerKid = await newMember(club.A, { accountType: "kids", parentMemberId: otherParent.id, guardianConfirmedAt: new Date() });
      const unconfirmedKid = await newMember(club.A, { accountType: "kids", parentMemberId: parent.id, guardianConfirmedAt: null });
      const inst = await nowSession(club.A);
      for (const kid of [kidB, strangerKid, unconfirmedKid]) {
        const r = await checkin(memberSession(club.A, parent.id, parent.email), { classInstanceId: inst, onBehalfOfMemberId: kid.id });
        expect(r.status).toBe(404);
        expect(await rows(kid.id)).toBe(0);
      }
    });

    it("card scanner: club B's card at club A answers wrong_tenant with no member id or name", async () => {
      const b = await newMember(club.B);
      const instA = await nowSession(club.A);
      const token = signCardToken({ tenantId: club.B, memberId: b.id, cardVersion: 1 });
      const r = await card(coachA(), instA, [token]);
      expect(r.status).toBe(200);
      const [res] = r.body.results as Array<Record<string, unknown>>;
      expect(res.status).toBe("wrong_tenant");
      expect(res).not.toHaveProperty("memberId");
      expect(res).not.toHaveProperty("memberName");
      expect(await rows(b.id)).toBe(0);
    });

    it("card scanner: A's own card into club B's session is 404", async () => {
      const a = await newMember(club.A);
      const instB = await nowSession(club.B);
      const r = await card(coachA(), instB, [signCardToken({ tenantId: club.A, memberId: a.id, cardVersion: 1 })]);
      expect(r.status).toBe(404);
      expect(await rows(a.id)).toBe(0);
    });

    it("kiosk: club B's kiosk member token at club A's tablet is refused; A's token into B's session is 404", async () => {
      const a = await newMember(club.A);
      const b = await newMember(club.B);
      const instA = await nowSession(club.A);
      const instB = await nowSession(club.B);
      const r1 = await kiosk(kioskRaw.A, signKioskMemberToken({ tenantId: club.B, memberId: b.id }), instA);
      expect(r1.status).toBe(400);
      const r2 = await kiosk(kioskRaw.A, signKioskMemberToken({ tenantId: club.A, memberId: a.id }), instB);
      expect(r2.status).toBe(404);
      expect(await rows(a.id)).toBe(0);
      expect(await rows(b.id)).toBe(0);
    });

    it("coach tick: coach A ticking into club B's session, or B's member into A's session, is 404", async () => {
      const a = await newMember(club.A);
      const b = await newMember(club.B);
      const instA = await nowSession(club.A);
      const instB = await nowSession(club.B);
      expect((await tick(coachA(), instB, { memberId: a.id, attended: true })).status).toBe(404);
      expect((await tick(coachA(), instA, { memberId: b.id, attended: true })).status).toBe(404);
      expect(await rows(a.id)).toBe(0);
      expect(await rows(b.id)).toBe(0);
    });

    it("unmark: owner A removing club B's attendance deletes nothing and gives back no credit", async () => {
      const b = await newMember(club.B);
      const instB = await nowSession(club.B);
      const packB = await givePack(club.B, b.id, { creditsRemaining: 2 });
      const rec = await withRlsBypass((tx) => tx.attendanceRecord.create({ data: { tenantId: club.B, memberId: b.id, classInstanceId: instB, checkInMethod: "admin" } }));
      await withRlsBypass((tx) => tx.classPackRedemption.create({ data: { memberPackId: packB, attendanceRecordId: rec.id } }));
      await uncheck(ownerA(), instB, b.id);
      await tick(coachA(), instB, { memberId: b.id, attended: false });
      expect(await rows(b.id, instB)).toBe(1);
      expect(await credits(packB)).toBe(2);
    });

    it("engine: a member id from another club never reaches a gate (the answer is member_not_found, not that club's hold or waiver)", async () => {
      // Defence in depth: every route resolves the member inside its own club
      // first, so this is the engine on its own being handed a foreign id.
      // Club B's member is on hold with a dated hold and an unsigned waiver; a
      // gate judged on B's row would answer on_hold with B's date.
      const b = await newMember(club.B, { paymentStatus: "paused", holdUntil: new Date(Date.now() + 40 * DAY), waiverAccepted: false });
      const instA = await nowSession(club.A);
      const r = await performCheckin({
        tenantId: club.A, memberId: b.id, classInstanceId: instA, method: "kiosk",
        enforceRankGate: true, enforceTimeWindow: true, requireCoverage: false, enforceCapacity: true,
        enforceWaiverGate: true, enforceHoldGate: true, enforceKidsGate: true, enforceVenueGate: true,
        enforceClassStateGate: true, allowanceGate: "refuse",
      });
      expect(r.kind).toBe("member_not_found");
      expect(await rows(b.id)).toBe(0);
    });
  });

  // ── 2. Role, revoked-session bypasses through direct requests ──────────────

  describe("role and session bypasses", () => {
    it("a member sending a staff memberId (even their own) is 403; DELETE is 403", async () => {
      const a = await newMember(club.A);
      const other = await newMember(club.A);
      const inst = await nowSession(club.A);
      const s = memberSession(club.A, a.id, a.email);
      expect((await checkin(s, { classInstanceId: inst, memberId: other.id, checkInMethod: "admin" })).status).toBe(403);
      expect((await checkin(s, { classInstanceId: inst, memberId: a.id })).status).toBe(403);
      expect((await uncheck(s, inst, a.id)).status).toBe(403);
      expect(await rows(other.id)).toBe(0);
    });

    it("a member forging checkInMethod admin/auto on their own path is still judged as self (no coverage, no pack: refused)", async () => {
      const a = await newMember(club.A, { membershipTierId: null, paymentStatus: "pending" });
      const inst = await nowSession(club.A);
      for (const m of ["admin", "auto"]) {
        const r = await checkin(memberSession(club.A, a.id, a.email), { classInstanceId: inst, checkInMethod: m });
        expect(r.status).toBe(402);
        expect(r.body.reason).toBe("no_coverage");
      }
      expect(await rows(a.id)).toBe(0);
    });

    it("a member reaching the staff-only doors directly (card, coach tick) is 403", async () => {
      const a = await newMember(club.A);
      const inst = await nowSession(club.A);
      const s = memberSession(club.A, a.id, a.email);
      expect((await card(s, inst, [signCardToken({ tenantId: club.A, memberId: a.id, cardVersion: 1 })])).status).toBe(403);
      expect((await tick(s, inst, { memberId: a.id, attended: true })).status).toBe(403);
      expect(await rows(a.id)).toBe(0);
    });

    it("a revoked session (no session, or a session whose user was removed) is refused at every session door", async () => {
      // auth.ts drops `user` from a token whose sessionVersion was bumped; the
      // proxy answers 401 before any handler. At the handler itself the answer
      // must still be a refusal that writes nothing.
      const a = await newMember(club.A);
      const inst = await nowSession(club.A);
      const refused = async (p: Promise<Res>): Promise<number> => {
        try { return (await p).status; } catch { return 500; }
      };
      for (const revoked of [null, { expires: new Date(Date.now() + DAY).toISOString() }]) {
        for (const status of [
          await refused(checkin(revoked, { classInstanceId: inst, memberId: a.id })),
          await refused(checkin(revoked, { classInstanceId: inst })),
          await refused(uncheck(revoked, inst, a.id)),
          await refused(card(revoked, inst, [signCardToken({ tenantId: club.A, memberId: a.id, cardVersion: 1 })])),
          await refused(tick(revoked, inst, { memberId: a.id, attended: true })),
        ]) {
          expect(status).toBeGreaterThanOrEqual(400);
        }
      }
      expect(await rows(a.id)).toBe(0);
    });

    it("a revoked card (version bumped) is refused at the scanner", async () => {
      const a = await newMember(club.A, { cardVersion: 2 });
      const inst = await nowSession(club.A);
      const r = await card(coachA(), inst, [signCardToken({ tenantId: club.A, memberId: a.id, cardVersion: 1 })]);
      expect((r.body.results as Array<Record<string, unknown>>)[0].status).toBe("revoked");
      expect(await rows(a.id)).toBe(0);
    });

    it("a staff mark sent with checkInMethod auto or self is still attributed to the staff member and audited", async () => {
      // An unattributed attendance row with no audit line would let staff write
      // attendance nobody can trace (repudiation). The register only ever sends
      // "admin"; nothing in the product sends "auto" or a staff "self".
      for (const m of ["auto", "self"] as const) {
        const a = await newMember(club.A);
        const inst = await nowSession(club.A);
        audit.calls.length = 0;
        const r = await checkin(coachA(), { classInstanceId: inst, memberId: a.id, checkInMethod: m });
        expect(r.status).toBe(201);
        const row = await withRlsBypass((tx) => tx.attendanceRecord.findFirst({ where: { memberId: a.id, classInstanceId: inst } }));
        expect(row?.checkedInById).toBe(users.coachA);
        expect(row?.checkInMethod).not.toBe("self");
        const mark = audit.calls.find((c) => c.action === "attendance.mark");
        expect(mark?.userId).toBe(users.coachA);
      }
    });
  });

  // ── 3. Admission despite app check-in off, allowance, eligibility, status ──

  describe("admission gates", () => {
    it("app check-in off: self, parent, forged method and forged acknowledgement are all refused; nothing written", async () => {
      await withRlsBypass((tx) => tx.tenant.update({ where: { id: club.A }, data: { memberAppCheckin: false } }));
      try {
        const parent = await newMember(club.A);
        const kid = await newMember(club.A, { accountType: "kids", parentMemberId: parent.id, guardianConfirmedAt: new Date() });
        const inst = await nowSession(club.A);
        const s = memberSession(club.A, parent.id, parent.email);
        for (const body of [
          { classInstanceId: inst },
          { classInstanceId: inst, checkInMethod: "admin" },
          { classInstanceId: inst, acknowledged: ["on_hold"] },
          { classInstanceId: inst, onBehalfOfMemberId: kid.id },
        ]) {
          const r = await checkin(s, body);
          expect(r.status).toBe(403);
          expect(r.body.reason).toBe("app_checkin_off");
        }
        expect(await rows(parent.id)).toBe(0);
        expect(await rows(kid.id)).toBe(0);
      } finally {
        await withRlsBypass((tx) => tx.tenant.update({ where: { id: club.A }, data: { memberAppCheckin: true } }));
      }
    });

    it("allowance used, no pack: refused at all five doors, forged acknowledgements included", async () => {
      const a = await newMember(club.A);
      await useAllowance(club.A, a.id);
      const s = memberSession(club.A, a.id, a.email);
      const i = [await nowSession(club.A), await nowSession(club.A), await nowSession(club.A), await nowSession(club.A), await nowSession(club.A)];
      const self = await checkin(s, { classInstanceId: i[0], acknowledged: ["allowance_reached"] });
      const desk = await checkin(ownerA(), { classInstanceId: i[1], memberId: a.id, acknowledged: ["allowance_reached", "tier_not_included"] });
      const auto = await checkin(ownerA(), { classInstanceId: i[2], memberId: a.id, checkInMethod: "auto" });
      const scan = await read(await (async () => {
        authState.session = coachA();
        return cardPost(new Request("https://test.local/api/checkin/card", {
          method: "POST",
          body: JSON.stringify({ classInstanceId: i[3], tokens: [signCardToken({ tenantId: club.A, memberId: a.id, cardVersion: 1 })], acknowledged: ["allowance_reached"] }),
        }));
      })());
      const kio = await kiosk(kioskRaw.A, signKioskMemberToken({ tenantId: club.A, memberId: a.id }), i[4]);
      const tk = await tick(coachA(), i[4], { memberId: a.id, attended: true, acknowledged: ["allowance_reached"] });
      for (const r of [self, desk, auto, kio, tk]) {
        expect(r.status).toBe(403);
        expect(r.body.reason).toBe("allowance_reached");
      }
      expect((scan.body.results as Array<Record<string, unknown>>)[0]).toMatchObject({ status: "refused", reason: "allowance_reached" });
      expect(await rows(a.id)).toBe(1); // only the visit that used the allowance
    });

    it("allowance used: an expired, legacy-expired, refunded, other-member or other-club pack is never spent", async () => {
      const a = await newMember(club.A);
      const other = await newMember(club.A);
      await useAllowance(club.A, a.id);
      const expired = await givePack(club.A, a.id, { expiresAt: new Date(Date.now() - DAY) });
      const legacy = await givePack(club.A, a.id, { status: "expired", expiresAt: new Date(Date.now() + 30 * DAY) });
      const refunded = await givePack(club.A, a.id, { status: "refunded", creditsRemaining: 3 });
      const voided = await givePack(club.A, a.id, { status: "disputed", creditsRemaining: 3 });
      const othersPack = await givePack(club.A, other.id);
      // A row in club B naming A's member: a cross-club pack must not pay at A.
      const crossClub = await withRlsBypass(async (tx) => (await tx.memberClassPack.create({
        data: { tenantId: club.B, memberId: a.id, packId: packProduct.B, creditsRemaining: 3, status: "active", expiresAt: new Date(Date.now() + 30 * DAY) },
      })).id);
      const s = memberSession(club.A, a.id, a.email);
      const r1 = await checkin(s, { classInstanceId: await nowSession(club.A) });
      const r2 = await checkin(ownerA(), { classInstanceId: await nowSession(club.A), memberId: a.id });
      const r3 = await kiosk(kioskRaw.A, signKioskMemberToken({ tenantId: club.A, memberId: a.id }), await nowSession(club.A));
      const r4 = await tick(coachA(), await nowSession(club.A), { memberId: a.id, attended: true });
      for (const r of [r1, r2, r3, r4]) expect(r.body.reason).toBe("allowance_reached");
      for (const p of [expired, legacy, refunded, voided, othersPack, crossClub]) expect(await credits(p)).toBe(3);
      expect(await rows(a.id)).toBe(1);
    });

    it("control: allowance used with a no-expiry pack: the pack pays (one credit per admission)", async () => {
      const a = await newMember(club.A);
      await useAllowance(club.A, a.id);
      const noExpiry = await givePack(club.A, a.id, { expiresAt: null, creditsRemaining: 2 });
      const r = await checkin(ownerA(), { classInstanceId: await nowSession(club.A), memberId: a.id });
      expect(r.status).toBe(201);
      expect((r.body.coverage as Record<string, unknown>).kind).toBe("pack");
      expect(await credits(noExpiry)).toBe(1);
    });

    it("ineligible (plan not among the class's memberships): refused at every door with forged acknowledgements", async () => {
      const a = await newMember(club.A);
      const otherTier = await withRlsBypass(async (tx) => (await tx.membershipTier.create({ data: { tenantId: club.A, name: `Other ${STAMP}` } })).id);
      const inst = await nowSession(club.A);
      await withRlsBypass(async (tx) => {
        const ci = await tx.classInstance.findUniqueOrThrow({ where: { id: inst }, select: { classId: true } });
        await tx.classMembershipTier.create({ data: { tenantId: club.A, classId: ci.classId, tierId: otherTier } });
      });
      const s = memberSession(club.A, a.id, a.email);
      const r1 = await checkin(s, { classInstanceId: inst });
      const r2 = await checkin(ownerA(), { classInstanceId: inst, memberId: a.id, acknowledged: ["tier_not_included"] });
      const r3 = await kiosk(kioskRaw.A, signKioskMemberToken({ tenantId: club.A, memberId: a.id }), inst);
      const r4 = await tick(coachA(), inst, { memberId: a.id, attended: true, acknowledged: ["tier_not_included"] });
      const r5 = await card(coachA(), inst, [signCardToken({ tenantId: club.A, memberId: a.id, cardVersion: 1 })]);
      for (const r of [r1, r2, r3, r4]) expect(r.body.reason).toBe("tier_not_included");
      expect((r5.body.results as Array<Record<string, unknown>>)[0]).toMatchObject({ status: "refused", reason: "tier_not_included" });
      expect(await rows(a.id)).toBe(0);
    });

    it("cancelled membership: the member app refuses without a pack; the kiosk never reports the visit as covered", async () => {
      const a = await newMember(club.A, { status: "cancelled", paymentStatus: "cancelled" });
      const r1 = await checkin(memberSession(club.A, a.id, a.email), { classInstanceId: await nowSession(club.A) });
      expect(r1.status).toBe(402);
      expect(r1.body.reason).toBe("no_coverage");
      // The kiosk is "forgiving on subs" by design (route header): it admits
      // and flags for the desk. The secure property is that it is never
      // recorded as covered.
      const r2 = await kiosk(kioskRaw.A, signKioskMemberToken({ tenantId: club.A, memberId: a.id }), await nowSession(club.A));
      if (r2.status === 201) expect((r2.body.coverage as Record<string, unknown>).kind).toBe("uncovered_kiosk");
      // A cancelled member whose allowance is used is refused at the kiosk too.
      await useAllowance(club.A, a.id);
      const r3 = await kiosk(kioskRaw.A, signKioskMemberToken({ tenantId: club.A, memberId: a.id }), await nowSession(club.A));
      expect(r3.body.reason).toBe("allowance_reached");
    });

    it("on hold: self and kiosk refuse, whatever the client acknowledges", async () => {
      const a = await newMember(club.A, { paymentStatus: "paused", holdUntil: new Date(Date.now() + 10 * DAY) });
      const r1 = await checkin(memberSession(club.A, a.id, a.email), { classInstanceId: await nowSession(club.A), acknowledged: ["on_hold"] });
      const r2 = await kiosk(kioskRaw.A, signKioskMemberToken({ tenantId: club.A, memberId: a.id }), await nowSession(club.A));
      expect(r1.body.reason).toBe("on_hold");
      expect(r2.body.reason).toBe("on_hold");
      expect(await rows(a.id)).toBe(0);
    });

    it("coach tick: a cancelled session or an imported-history session is refused and spends no pack credit", async () => {
      // Every other door refuses both (lib/checkin.ts: class_cancelled, and an
      // import-created session is "class_not_found"). A tick that admits into
      // them would spend a member's paid credit on a class that did not run.
      const a = await newMember(club.A);
      await useAllowance(club.A, a.id);
      const pack = await givePack(club.A, a.id, { creditsRemaining: 2 });
      const cancelled = await nowSession(club.A, { cancelled: true });
      const imported = await nowSession(club.A, { imported: true });
      const r1 = await tick(coachA(), cancelled, { memberId: a.id, attended: true });
      const r2 = await tick(coachA(), imported, { memberId: a.id, attended: true });
      expect(r1.status).not.toBe(200);
      expect(r2.status).not.toBe(200);
      expect(await rows(a.id, cancelled)).toBe(0);
      expect(await rows(a.id, imported)).toBe(0);
      expect(await credits(pack)).toBe(2);
    });
  });

  // ── 4. Concurrency: double spending and duplicate attendance ───────────────

  describe("concurrency", () => {
    it("last pack credit, five doors at once on five sessions: exactly one admission, credit never below zero", async () => {
      const a = await newMember(club.A);
      await useAllowance(club.A, a.id);
      const pack = await givePack(club.A, a.id, { creditsRemaining: 1 });
      const i = await Promise.all([1, 2, 3, 4, 5].map(() => nowSession(club.A)));
      const s = memberSession(club.A, a.id, a.email);
      // The routes read the session through the shared mock, so the parallel
      // doors run through the engine directly with each door's own profile,
      // plus the coach tick route (staff session) for the fifth.
      authState.session = coachA();
      const doors = await Promise.all([
        performCheckin({ tenantId: club.A, memberId: a.id, classInstanceId: i[0], method: "self", enforceRankGate: true, enforceTimeWindow: true, requireCoverage: true, enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true, enforceKidsGate: true, enforceVenueGate: true, enforceClassStateGate: true, allowanceGate: "refuse" }),
        performCheckin({ tenantId: club.A, memberId: a.id, classInstanceId: i[1], method: "kiosk", enforceRankGate: true, enforceTimeWindow: true, requireCoverage: false, enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true, enforceKidsGate: true, enforceVenueGate: true, enforceClassStateGate: true, allowanceGate: "refuse" }),
        performCheckin({ tenantId: club.A, memberId: a.id, classInstanceId: i[2], method: "admin", enforceRankGate: false, enforceTimeWindow: false, requireCoverage: false, enforceCapacity: false, enforceWaiverGate: false, allowanceGate: "refuse", checkedInByUserId: users.ownerA }),
        performCheckin({ tenantId: club.A, memberId: a.id, classInstanceId: i[3], method: "qr", enforceRankGate: false, enforceTimeWindow: false, requireCoverage: false, enforceCapacity: false, enforceWaiverGate: false, allowanceGate: "refuse", checkedInByUserId: users.coachA, expectedCardVersion: 1 }),
        tickPost(
          new Request(`https://test.local/api/coach/instances/${i[4]}/attendance`, { method: "POST", body: JSON.stringify({ memberId: a.id, attended: true }) }),
          { params: Promise.resolve({ id: i[4] }) },
        ).then(read),
      ]);
      void s;
      const engine = doors.slice(0, 4) as Array<{ kind: string }>;
      const tickRes = doors[4] as Res;
      const admitted = engine.filter((r) => r.kind === "success").length + (tickRes.status === 200 ? 1 : 0);
      for (const r of engine) expect(["success", "allowance_reached"]).toContain(r.kind);
      expect(admitted).toBe(1);
      expect(await credits(pack)).toBe(0);
      const redemptions = await withRlsBypass((tx) => tx.classPackRedemption.count({ where: { memberPackId: pack } }));
      expect(redemptions).toBe(1);
      expect(await rows(a.id)).toBe(2); // the allowance visit + the one admission
    });

    it("duplicate attendance: five doors at once on ONE session write one row and spend at most one credit", async () => {
      const a = await newMember(club.A);
      await useAllowance(club.A, a.id);
      const pack = await givePack(club.A, a.id, { creditsRemaining: 3 });
      const inst = await nowSession(club.A);
      authState.session = coachA();
      const results = await Promise.all([
        performCheckin({ tenantId: club.A, memberId: a.id, classInstanceId: inst, method: "self", enforceRankGate: true, enforceTimeWindow: true, requireCoverage: true, enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true, enforceKidsGate: true, enforceVenueGate: true, enforceClassStateGate: true, allowanceGate: "refuse" }),
        performCheckin({ tenantId: club.A, memberId: a.id, classInstanceId: inst, method: "kiosk", enforceRankGate: true, enforceTimeWindow: true, requireCoverage: false, enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true, enforceKidsGate: true, enforceVenueGate: true, enforceClassStateGate: true, allowanceGate: "refuse" }),
        performCheckin({ tenantId: club.A, memberId: a.id, classInstanceId: inst, method: "admin", enforceRankGate: false, enforceTimeWindow: false, requireCoverage: false, enforceCapacity: false, enforceWaiverGate: false, allowanceGate: "refuse", checkedInByUserId: users.ownerA }),
        performCheckin({ tenantId: club.A, memberId: a.id, classInstanceId: inst, method: "qr", enforceRankGate: false, enforceTimeWindow: false, requireCoverage: false, enforceCapacity: false, enforceWaiverGate: false, allowanceGate: "refuse", checkedInByUserId: users.coachA, expectedCardVersion: 1 }),
        tickPost(
          new Request(`https://test.local/api/coach/instances/${inst}/attendance`, { method: "POST", body: JSON.stringify({ memberId: a.id, attended: true }) }),
          { params: Promise.resolve({ id: inst }) },
        ).then(read),
      ]);
      void results;
      expect(await rows(a.id, inst)).toBe(1);
      expect(await credits(pack)).toBe(2);
      const redemptions = await withRlsBypass((tx) => tx.classPackRedemption.count({ where: { memberPackId: pack } }));
      expect(redemptions).toBe(1);
    });
  });
});
