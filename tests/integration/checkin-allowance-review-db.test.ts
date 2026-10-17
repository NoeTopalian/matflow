// T7 review fixes (17 Oct 2026) against real Postgres. Companion to
// checkin-allowance-race-db.test.ts; same parking technique (a GATE
// transaction holds a row, the contenders are observed waiting on it in
// pg_stat_activity, then the GATE is released).
//
//  1. Coach tick door (R-ALLOW rule 6 / C10): a coach tick on session Y and a
//     self check-in on session X for a 1-class plan, both parked on the Member
//     lock: exactly one admission without acknowledgement; with it, any
//     admission past the allowance carries the override on the tick's audit row.
//  2. Stripe dispute webhook x pack check-in (§8b.3 C1 / §8b.4 R2): the
//     webhook now writes the Member row before voiding the pack, so with a
//     pack check-in holding Class + Member and waiting on the pack, the webhook
//     waits on the Member (not on the pack) and both complete: no 40P01.
//  3. R-ALLOW rule 2: a plan removed while a check-in waits on the Member lock
//     restarts it, and it is judged on the new row (refused), not admitted on
//     the plan it read before the lock.
//  4. Packs and the allowance in one transaction: a covered member whose
//     allowance is used up checks in on a pack at the member app and the
//     kiosk; the pack-paid visits are not counted.
// Skips when DATABASE_URL is unset (CI's Postgres and the Neon TEST branch
// run it; never production).

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
const staff = vi.hoisted(() => ({ tenantId: "", userId: "" }));
vi.mock("@/lib/api-authz", () => ({
  requireApiStaff: vi.fn(async () => ({ ok: true, tenantId: staff.tenantId, userId: staff.userId, role: "coach" })),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn(async (entry: Record<string, unknown>) => {
    audit.calls.push(entry);
  }),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/stripe-account-status", () => ({ refreshStripeAccountStatus: vi.fn(async () => {}) }));

import Stripe from "stripe";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { performCheckin, type PerformCheckinArgs, type PerformCheckinResult } from "@/lib/checkin";
import { memberAllowanceUsage } from "@/lib/class-allowance-count";
import { POST as coachTick } from "@/app/api/coach/instances/[id]/attendance/route";
import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const SECRET = "whsec_t7_review_synthetic_local_only_0123456789";

function selfArgs(tenantId: string, memberId: string, classInstanceId: string, method: "self" | "kiosk" = "self"): PerformCheckinArgs {
  return {
    tenantId, memberId, classInstanceId, method,
    enforceRankGate: true, enforceRosterGate: true, enforceTimeWindow: false, requireCoverage: method === "self",
    enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true, enforceKidsGate: true,
    enforceVenueGate: true, tierGate: "refuse", enforceClassStateGate: true, allowanceGate: "refuse",
  };
}

const MEMBER_LOCK_SQL = '%FROM "Member" WHERE "id"%UPDATE%';

async function waitForLockWaiters(pattern: string, n: number): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    const rows = await prisma.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM pg_stat_activity
       WHERE wait_event_type = 'Lock' AND datname = current_database() AND query LIKE ${pattern}
    `;
    if ((rows[0]?.n ?? 0) >= n) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${n} backend(s) blocked on ${pattern}`);
}

/** A transaction that takes a lock, signals, holds it until released, then optionally writes before committing. */
function holdLock(
  take: (tx: Prisma.TransactionClient) => Promise<unknown>,
  beforeCommit?: (tx: Prisma.TransactionClient) => Promise<unknown>,
) {
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let ready!: () => void;
  const isReady = new Promise<void>((r) => { ready = r; });
  const done = withRlsBypass(async (tx) => {
    await take(tx);
    ready();
    await released;
    if (beforeCommit) await beforeCommit(tx);
  });
  return { isReady, release, done };
}

function noDeadlock(results: unknown[]): void {
  for (const r of results) {
    if ((r as { kind?: string }).kind === "error") {
      const err = (r as { error?: { code?: string; message?: string } }).error;
      expect(String(err?.code ?? err?.message ?? err)).not.toMatch(/40P01|deadlock/i);
    }
  }
}

type TickResult = { status: number; body: Record<string, unknown> };
async function tick(instanceId: string, memberId: string, acknowledged?: string[]): Promise<TickResult> {
  const res = (await coachTick(
    new Request(`http://test/api/coach/instances/${instanceId}/attendance`, {
      method: "POST",
      body: JSON.stringify({ memberId, attended: true, ...(acknowledged ? { acknowledged } : {}) }),
    }),
    { params: Promise.resolve({ id: instanceId }) },
  )) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: res.status, body: await res.json() };
}

describe.skipIf(!HAS_DB)("T7 review fixes - real database", () => {
  let tenantId: string;
  let userId: string;
  let tierId: string;
  let classX: string;
  let classY: string;
  let packTemplate: string;
  let dayOffset = 0;
  const memberIds: string[] = [];

  async function freshPair(): Promise<{ x: string; y: string }> {
    dayOffset += 30;
    const date = new Date(Date.UTC(2032, 0, 5) + dayOffset * 86_400_000);
    return withRlsBypass(async (tx) => {
      const x = await tx.classInstance.create({ data: { classId: classX, date, startTime: "18:00", endTime: "19:00" } });
      const y = await tx.classInstance.create({ data: { classId: classY, date, startTime: "19:00", endTime: "20:00" } });
      return { x: x.id, y: y.id };
    });
  }
  async function newMember(data: Partial<Prisma.MemberUncheckedCreateInput> = {}): Promise<string> {
    const id = await withRlsBypass(async (tx) => (await tx.member.create({
      data: {
        tenantId, name: `Review ${memberIds.length}`, email: `t7-review-${STAMP}-${memberIds.length}@test.local`,
        membershipTierId: tierId, waiverAccepted: true, paymentStatus: "paid", ...data,
      },
    })).id);
    memberIds.push(id);
    return id;
  }
  async function givePack(memberId: string, credits: number, stripePaymentIntentId?: string): Promise<string> {
    return withRlsBypass(async (tx) => (await tx.memberClassPack.create({
      data: {
        tenantId, memberId, packId: packTemplate, creditsRemaining: credits, status: "active",
        expiresAt: new Date(Date.now() + 60 * 86_400_000), ...(stripePaymentIntentId ? { stripePaymentIntentId } : {}),
      },
    })).id);
  }
  const recordsIn = (ids: string[], mid: string) =>
    withRlsBypass((tx) => tx.attendanceRecord.count({ where: { memberId: mid, classInstanceId: { in: ids } } }));

  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_t7_review_synthetic_never_used";
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({
        data: { name: `Allowance review ${STAMP}`, slug: `allowance-review-${STAMP}`, stripeAccountId: `acct_t7r_${STAMP}` },
      })).id;
      userId = (await tx.user.create({
        data: { tenantId, email: `t7-review-coach-${STAMP}@test.local`, name: "Coach", role: "coach", passwordHash: "x" },
      })).id;
      tierId = (await tx.membershipTier.create({ data: { tenantId, name: "One a fortnight", classLimit: 1, classLimitWeeks: 2 } })).id;
      classX = (await tx.class.create({ data: { tenantId, name: "Review X", duration: 60, maxCapacity: 50 } })).id;
      classY = (await tx.class.create({ data: { tenantId, name: "Review Y", duration: 60, maxCapacity: 50 } })).id;
      packTemplate = (await tx.classPack.create({ data: { tenantId, name: "Ten", totalCredits: 10, validityDays: 90, pricePence: 9000 } })).id;
    });
    staff.tenantId = tenantId;
    staff.userId = userId;
  });

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.dispute.deleteMany({ where: { tenantId } });
      await tx.payment.deleteMany({ where: { tenantId } });
      await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_t7r_${STAMP}` } } });
      await tx.classPackRedemption.deleteMany({ where: { memberPack: { tenantId } } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.memberClassPack.deleteMany({ where: { tenantId } });
      await tx.classPack.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.membershipTier.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  it("coach tick vs self check-in, parked on the Member lock: exactly one admission without acknowledgement", async () => {
    const memberId = await newMember();
    const { x, y } = await freshPair();
    const gate = holdLock((tx) => tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${memberId} FOR UPDATE`);
    await gate.isReady;
    const own = performCheckin(selfArgs(tenantId, memberId, x));
    const coach = tick(y, memberId);
    await waitForLockWaiters(MEMBER_LOCK_SQL, 2);
    gate.release();
    await gate.done;
    const [o, c] = await Promise.all([own, coach]);
    noDeadlock([o]);
    const admissions = (o.kind === "success" ? 1 : 0) + (c.status === 200 ? 1 : 0);
    expect(admissions).toBe(1);
    if (o.kind === "success") {
      expect(c.status).toBe(403);
      expect(c.body).toMatchObject({ reason: "allowance_reached", askable: true, allowance: { used: 1, limit: 1, weeks: 2 } });
    } else {
      expect(o).toMatchObject({ kind: "allowance_reached", used: 1, limit: 1 });
    }
    expect(await recordsIn([x, y], memberId)).toBe(1);
  });

  it("coach tick vs self check-in with acknowledgement: an admission past the allowance carries the override on the tick", async () => {
    const memberId = await newMember();
    const { x, y } = await freshPair();
    audit.calls.length = 0;
    const gate = holdLock((tx) => tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${memberId} FOR UPDATE`);
    await gate.isReady;
    const own = performCheckin(selfArgs(tenantId, memberId, x));
    const coach = tick(y, memberId, ["allowance_reached"]);
    await waitForLockWaiters(MEMBER_LOCK_SQL, 2);
    gate.release();
    await gate.done;
    const [o, c] = await Promise.all([own, coach]);
    noDeadlock([o]);
    expect(c.status).toBe(200);
    const mark = audit.calls.find((e) => e.action === "attendance.mark") as { metadata: Record<string, unknown> } | undefined;
    expect(mark).toBeDefined();
    if (o.kind === "success") {
      // The member's own check-in took the place; the tick admitted past it and says so.
      expect(mark!.metadata.overrides).toEqual(["allowance_reached"]);
      expect(mark!.metadata.overAllowance).toMatchObject({ used: 1, limit: 1, weeks: 2 });
      expect(await recordsIn([x, y], memberId)).toBe(2);
    } else {
      // The tick won within the allowance (no override); the member was then refused.
      expect(mark!.metadata.overrides).toBeUndefined();
      expect(o).toMatchObject({ kind: "allowance_reached", used: 1 });
      expect(await recordsIn([x, y], memberId)).toBe(1);
    }
  });

  it("dispute webhook x pack check-in: the webhook waits on the Member, not the pack, and both complete (no 40P01)", async () => {
    // An overdue member (not covered), so the check-in pays with a pack:
    // Class, then Member, then the pack. The pack was bought with the charge
    // now disputed and lost.
    const pi = `pi_t7r_${STAMP}`;
    const charge = `ch_t7r_${STAMP}`;
    const customer = `cus_t7r_${STAMP}`;
    const memberId = await newMember({ membershipTierId: null, paymentStatus: "overdue", stripeCustomerId: customer });
    const packId = await givePack(memberId, 3, pi);
    await withRlsBypass((tx) => tx.payment.create({
      data: { tenantId, memberId, stripeChargeId: charge, stripePaymentIntentId: pi, amountPence: 9000, status: "succeeded", paidAt: new Date() },
    }));
    const { x } = await freshPair();

    // GATE holds the pack, so the check-in parks at its decrement while it
    // already holds Class X and the Member row.
    const gate = holdLock((tx) => tx.$queryRaw`SELECT "id" FROM "MemberClassPack" WHERE "id" = ${packId} FOR UPDATE`);
    await gate.isReady;
    const checkin = performCheckin(selfArgs(tenantId, memberId, x));
    await waitForLockWaiters("%MemberClassPack%", 1);

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-03-25.dahlia" as never });
    const payload = JSON.stringify({
      id: `evt_t7r_${STAMP}_dispute`, object: "event", type: "charge.dispute.updated", account: `acct_t7r_${STAMP}`,
      livemode: false, created: Math.floor(Date.now() / 1000),
      data: { object: {
        id: `dp_t7r_${STAMP}`, object: "dispute", status: "lost", charge, payment_intent: pi, customer,
        amount: 9000, currency: "gbp", reason: "fraudulent",
      } },
    });
    const signature = stripe.webhooks.generateTestHeaderString({
      payload, secret: SECRET, timestamp: Math.floor(Date.now() / 1000),
    } as Parameters<typeof stripe.webhooks.generateTestHeaderString>[0]);
    const webhook = (stripeWebhook(
      new Request("http://localhost/api/stripe/webhook", {
        method: "POST", headers: new Headers({ "content-type": "application/json", "stripe-signature": signature }), body: payload,
      }) as never,
    ) as unknown as Promise<{ status: number; json: () => Promise<Record<string, unknown>> }>);

    // Member before pack: the webhook's FIRST lock wait is the Member row the
    // check-in holds. (Before the fix it voided the pack first and queued on
    // the GATE's pack instead, which is the cycle Postgres broke with 40P01.)
    await waitForLockWaiters('%"Member" SET%', 1);
    gate.release();
    await gate.done;

    const [c, w] = await Promise.all([checkin, webhook]);
    noDeadlock([c]);
    expect(c.kind).toBe("success");
    expect(w.status).toBe(200);
    const after = await withRlsBypass(async (tx) => ({
      pack: await tx.memberClassPack.findUnique({ where: { id: packId }, select: { status: true, creditsRemaining: true } }),
      member: await tx.member.findUnique({ where: { id: memberId }, select: { paymentStatus: true } }),
      redemptions: await tx.classPackRedemption.count({ where: { memberPackId: packId } }),
    }));
    // The check-in spent a credit, then the lost dispute voided the pack.
    expect(after.pack).toEqual({ status: "refunded", creditsRemaining: 0 });
    expect(after.member?.paymentStatus).toBe("overdue");
    expect(after.redemptions).toBe(1);
  });

  it("a plan removed while a check-in waits on the Member lock restarts it: judged on the new row, not admitted on the old plan (R-ALLOW rule 2)", async () => {
    // A desk-plan member (a tier, paid, no subscription): covered, so the
    // check-in takes the straight path. The GATE removes the plan and commits
    // while the check-in is parked on the Member lock.
    const memberId = await newMember({ membershipTierId: tierId, paymentStatus: "paid" });
    const { x } = await freshPair();
    const gate = holdLock(
      (tx) => tx.$queryRaw`SELECT "id" FROM "Member" WHERE "id" = ${memberId} FOR UPDATE`,
      (tx) => tx.member.update({ where: { id: memberId }, data: { membershipTierId: null } }),
    );
    await gate.isReady;
    const checkin = performCheckin(selfArgs(tenantId, memberId, x));
    await waitForLockWaiters(MEMBER_LOCK_SQL, 1);
    gate.release();
    await gate.done;
    const r: PerformCheckinResult = await checkin;
    // No plan and no pack: the member app refuses. Before the fix it admitted
    // on the plan it read before the lock.
    expect(r.kind).toBe("no_coverage");
    expect(await recordsIn([x], memberId)).toBe(0);
  });

  it("an unchanged member with dates set is not restarted (the lock's epoch-ms dates match the pre-read)", async () => {
    const memberId = await newMember({
      nextDueAt: new Date(Date.UTC(2040, 0, 1, 12, 30, 15, 123)),
      holdUntil: new Date(Date.UTC(2020, 5, 1, 9, 0, 0, 7)),
    });
    const { x } = await freshPair();
    const r = await performCheckin(selfArgs(tenantId, memberId, x));
    expect(r.kind).toBe("success");
  });

  it("a covered member whose allowance is used up checks in on a pack, at the member app and the kiosk; pack visits are not counted", async () => {
    const memberId = await newMember({ stripeSubscriptionId: `sub_t7r_${STAMP}`, paymentStatus: "paid" });
    const packId = await givePack(memberId, 2);
    const first = await freshPair();
    const a = await performCheckin(selfArgs(tenantId, memberId, first.x));
    expect(a.kind === "success" && a.coverage.kind).toBe("subscription");
    const b = await performCheckin(selfArgs(tenantId, memberId, first.y));
    expect(b.kind === "success" && b.coverage).toEqual({ kind: "pack", creditsRemaining: 1 });
    // Same window, the kiosk: the allowance is still the one subscription
    // visit (the pack visit did not count), so the pack pays again.
    const extra = await withRlsBypass((tx) => tx.classInstance.create({
      data: { classId: classX, date: new Date(Date.UTC(2032, 0, 5) + dayOffset * 86_400_000), startTime: "07:00", endTime: "08:00" },
    }));
    const k = await performCheckin(selfArgs(tenantId, memberId, extra.id, "kiosk"));
    expect(k.kind === "success" && k.coverage).toEqual({ kind: "pack", creditsRemaining: 0 });
    // No credits left: the next one is refused with the allowance sentence.
    const late = await withRlsBypass((tx) => tx.classInstance.create({
      data: { classId: classY, date: new Date(Date.UTC(2032, 0, 5) + dayOffset * 86_400_000), startTime: "21:00", endTime: "22:00" },
    }));
    const refused = await performCheckin(selfArgs(tenantId, memberId, late.id));
    expect(refused).toMatchObject({ kind: "allowance_reached", used: 1, limit: 1 });
    expect(await withRlsBypass((tx) => tx.classPackRedemption.count({ where: { memberPackId: packId } }))).toBe(2);
    // The count the portal and the doors share sees one counted visit, not three.
    const usage = await withRlsBypass((tx) => memberAllowanceUsage(tx, {
      tenantId, memberId, now: new Date(Date.UTC(2032, 0, 5) + dayOffset * 86_400_000 + 23 * 3_600_000),
    }));
    expect(usage).toMatchObject({ used: 1, limit: 1, weeks: 2 });
  });
});
