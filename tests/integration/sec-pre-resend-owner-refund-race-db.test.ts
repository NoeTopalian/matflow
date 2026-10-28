// Pre-Resend adversarial pass (W6, 28 Oct 2026): the OWNER refund route
// (POST /api/payments/[id]/refund) racing a member spending a credit of the
// pack the refunded payment funded. Companion to
// sec-pre-resend-pack-refund-race-db.test.ts, which drives the charge.refunded
// webhook leg; same parking technique (a GATE holds the pack row, the
// check-in and the refund are seen queued in pg_stat_activity, then released).
//
// Real Postgres (Neon TEST branch, both roles via db-tests.mjs). Stripe is a
// local stand-in class (no network): the charge has nothing refunded before,
// the refund succeeds, and the settled charge then reports £25 refunded.
// Session, CSRF, rate limiter, audit, email and Sentry are stubbed.
// Synthetic club, torn down.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class extends Request {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
const authState = vi.hoisted(() => ({ session: null as unknown }));
vi.mock("@/auth", () => ({ auth: vi.fn(async () => authState.session) }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: () => "203.0.113.7",
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
const stripeState = vi.hoisted(() => ({ refunded: 0 }));
vi.mock("stripe", () => ({
  default: class {
    charges = {
      retrieve: vi.fn(async () => ({ id: "ch", amount_refunded: stripeState.refunded })),
    };
    refunds = {
      create: vi.fn(async (args: { amount: number }) => {
        stripeState.refunded += args.amount;
        return { id: `re_w6_${Date.now()}`, amount: args.amount, status: "succeeded", charge: "ch_settled" };
      }),
    };
    subscriptions = { cancel: vi.fn(), update: vi.fn() };
  },
}));

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { performCheckin } from "@/lib/checkin";
import { POST as refundPost } from "@/app/api/payments/[id]/refund/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
vi.setConfig({ testTimeout: 240_000 });

async function waitForLockWaiters(pattern: string, n: number): Promise<void> {
  const deadline = Date.now() + 20_000;
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

function holdLock(take: (tx: Prisma.TransactionClient) => Promise<unknown>) {
  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  let ready!: () => void;
  const isReady = new Promise<void>((r) => { ready = r; });
  const done = withRlsBypass(async (tx) => {
    await take(tx);
    ready();
    await released;
  }, { timeout: 60_000 });
  return { isReady, release, done };
}

describe.skipIf(!HAS_DB)("W6 pre-Resend: owner partial refund racing a check-in (real database)", () => {
  let tenantId = "";
  let ownerId = "";
  let classId = "";
  let productId = "";

  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_w6_owner_refund_synthetic_never_used";
    await withRlsBypass(async (tx) => {
      tenantId = (await tx.tenant.create({ data: { name: `W6 owner refund ${STAMP}`, slug: `w6-owner-refund-${STAMP}`, stripeAccountId: `acct_w6or_${STAMP}`, timezone: "UTC" } })).id;
      ownerId = (await tx.user.create({ data: { tenantId, email: `w6-or-owner-${STAMP}@example.test`, name: "Owner", role: "owner", passwordHash: "x" } })).id;
      classId = (await tx.class.create({ data: { tenantId, name: "W6 Owner Race", duration: 60, maxCapacity: 50 } })).id;
      productId = (await tx.classPack.create({ data: { tenantId, name: "Ten", totalCredits: 10, validityDays: 90, pricePence: 10000 } })).id;
    });
    authState.session = { user: { id: ownerId, tenantId, role: "owner", email: `w6-or-owner-${STAMP}@example.test` } };
  });

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.payment.deleteMany({ where: { tenantId } });
      await tx.classPackRedemption.deleteMany({ where: { memberPack: { tenantId } } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.memberClassPack.deleteMany({ where: { tenantId } });
      await tx.classPack.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  it("an owner's £25 refund on a £100 ten-class pack while the member spends a credit leaves 7, never 8", async () => {
    const pi = `pi_w6or_${STAMP}`;
    const { memberId, packId, instanceId, paymentId } = await withRlsBypass(async (tx) => {
      const m = await tx.member.create({ data: { tenantId, name: "W6 Owner Racer", email: `w6-or-${STAMP}@example.test`, waiverAccepted: true, paymentStatus: "pending" } });
      const p = await tx.memberClassPack.create({
        data: { tenantId, memberId: m.id, packId: productId, creditsRemaining: 10, status: "active", expiresAt: null, stripePaymentIntentId: pi },
      });
      const pay = await tx.payment.create({
        data: { tenantId, memberId: m.id, amountPence: 10000, currency: "GBP", status: "succeeded", stripePaymentIntentId: pi, stripeChargeId: `ch_w6or_${STAMP}`, paidAt: new Date() },
      });
      const i = await tx.classInstance.create({ data: { classId, date: new Date(Date.UTC(2031, 3, 7)), startTime: "18:00", endTime: "19:00" } });
      return { memberId: m.id, packId: p.id, instanceId: i.id, paymentId: pay.id };
    });

    const gate = holdLock((tx) => tx.$queryRaw`SELECT "id" FROM "MemberClassPack" WHERE "id" = ${packId} FOR UPDATE`);
    await gate.isReady;
    const checkin = performCheckin({
      tenantId, memberId, classInstanceId: instanceId, method: "self",
      enforceRankGate: false, enforceTimeWindow: false, requireCoverage: true, enforceCapacity: true,
      enforceWaiverGate: true, enforceHoldGate: true, enforceKidsGate: true, enforceVenueGate: true, allowanceGate: "refuse",
    });
    await waitForLockWaiters('%"MemberClassPack"%', 1); // the check-in's decrement, queued behind the GATE
    const refund = refundPost(
      new Request(`https://test.local/api/payments/${paymentId}/refund`, { method: "POST", body: JSON.stringify({ amountPence: 2500 }) }),
      { params: Promise.resolve({ id: paymentId }) },
    ) as unknown as Promise<{ status: number; json: () => Promise<Record<string, unknown>> }>;
    await waitForLockWaiters('%"MemberClassPack"%', 2); // and the refund, queued on the same row
    gate.release();
    await gate.done;
    const [c, r] = await Promise.all([checkin, refund]);
    expect(c.kind).toBe("success");
    expect(r.status, JSON.stringify(await r.json())).toBe(200);

    const pack = await withRlsBypass((tx) => tx.memberClassPack.findUniqueOrThrow({ where: { id: packId } }));
    const redeemed = await withRlsBypass((tx) => tx.classPackRedemption.count({ where: { memberPackId: packId } }));
    const payment = await withRlsBypass((tx) => tx.payment.findUniqueOrThrow({ where: { id: paymentId } }));
    expect(redeemed).toBe(1);
    expect(payment.refundedAmountPence).toBe(2500);
    // 10 sold - 1 attended - 2 refunded (£25 of £100 buys back two whole classes).
    expect(pack.creditsRemaining).toBe(7);
  });
});
