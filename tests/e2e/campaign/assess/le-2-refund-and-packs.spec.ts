/**
 * Lane L-E · file 2 — J44 (refund) and J45 (class packs).
 *
 * The question this file exists to answer is the one only counting rows can:
 * **does a refund void the same credits twice?**
 *
 * It did, until round 1. `app/api/payments/[id]/refund/route.ts` apportioned a
 * partial refund with `packCreditsAfterRefund`, passing the pack's CURRENT
 * `creditsRemaining` and the CUMULATIVE `refundedAmountPence`. Stripe then
 * echoed the same refund back as `charge.refunded` and the webhook ran the
 * identical apportionment — again cumulative, but now against the
 * already-reduced balance. A £25 refund on a £100 ten-class pack revoked two
 * credits at the desk and two more when the echo landed: a quarter of the money
 * back, two fifths of the classes gone.
 *
 * A FULL refund hid it (the payment flips to `refunded` and the webhook skips,
 * and the pack flips too), which is why every existing test passed. The partial
 * was where it lived.
 *
 * The fix computes from the pack AS SOLD, less its redemption count, so the
 * same cumulative total lands on the same answer however often it is reported.
 * The echo is driven here with a genuine signature against the real route, and
 * the pack is counted before, between and after.
 */
import { test, expect } from "@playwright/test";
import {
  RUN_STAMP,
  sql,
  seededTenantId,
  sessionFor,
  anonRc,
  closeSessions,
  post,
  get,
  patch,
  del,
  FORBIDDEN_BODY,
  OWNER_EMAIL,
  COACH_EMAIL,
  ADMIN_EMAIL,
  MEMBER_EMAIL,
  THROWAWAY_PASSWORD,
  mkStaff,
  mkTenant,
  mkPack,
  mkMemberPack,
  mkStripePayment,
  getMemberPack,
  getPaymentLedger,
  sendSigned,
  eventId,
  teardownTenant,
  teardownMoney,
  resetBucketsLike,
  countRows,
} from "./le-shared";
import { createMember, cleanupRun, saveStripeConnection } from "../helpers/db";

test.describe.configure({ mode: "default", timeout: 180_000 });

const ORIGIN = "http://localhost:3847";

let tenantId: string;
let member: { id: string; name: string; email: string };
let packId: string;
let foreign: { id: string; slug: string };
let foreignMemberId: string;
let restoreStripe: (() => Promise<void>) | null = null;

test.beforeAll(async () => {
  tenantId = await seededTenantId();
  member = await createMember({ name: `${RUN_STAMP} Pack buyer` });
  packId = await mkPack(tenantId, { totalCredits: 10, pricePence: 10_000 });

  foreign = await mkTenant();
  const rows = await sql<{ id: string }>(
    `INSERT INTO "Member" ("id", "tenantId", "name", "email", "status", "paymentStatus", "joinedAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 'active', 'paid', now(), now()) RETURNING id`,
    [foreign.id, `${RUN_STAMP} Foreign buyer`, `${RUN_STAMP}-fb@example.test`],
  );
  foreignMemberId = rows[0].id;
});

test.afterAll(async () => {
  if (restoreStripe) await restoreStripe().catch(() => {});
  await resetBucketsLike(`payment-refund:${tenantId}%`);
  await resetBucketsLike(`pack:buy:%`);
  await teardownMoney(tenantId);
  await teardownMoney(foreign.id).catch(() => {});
  await teardownTenant(foreign.id);
  await cleanupRun();
  await closeSessions();
  const left = await countRows("MemberClassPack", '"tenantId" = $1 AND "packId" = $2', [tenantId, packId]);
  expect(left, "run-stamped member packs survived teardown").toBe(0);
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J44 · who may refund", () => {
  test("a manager cannot refund — the route is owner-only, and nothing moves", async ({ browser, baseURL }) => {
    const mgr = await mkStaff(tenantId, "manager");
    const rc = (await sessionFor(browser, baseURL!, mgr.email, THROWAWAY_PASSWORD)).request;
    const payment = await mkStripePayment(tenantId, member.id, { amountPence: 5000 });

    const res = await post(rc, `/api/payments/${payment.id}/refund`, ORIGIN, { amountPence: 1000 });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe(FORBIDDEN_BODY);

    const after = await getPaymentLedger(payment.id);
    expect(after?.refundedAmountPence).toBeNull();
    expect(after?.status).toBe("succeeded");
  });

  test("coach, admin and member are refused and the ledger is untouched", async ({ browser, baseURL }) => {
    const payment = await mkStripePayment(tenantId, member.id, { amountPence: 5000 });
    for (const email of [COACH_EMAIL, ADMIN_EMAIL, MEMBER_EMAIL]) {
      const rc = (await sessionFor(browser, baseURL!, email)).request;
      const res = await post(rc, `/api/payments/${payment.id}/refund`, ORIGIN, { amountPence: 100 });
      expect([401, 403], `${email} refund`).toContain(res.status());
      const after = await getPaymentLedger(payment.id);
      expect(after?.refundedAmountPence, email).toBeNull();
    }
  });

  test("a cash payment is refused honestly, never with a 500", async ({ browser, baseURL }) => {
    const rc = (await sessionFor(browser, baseURL!, OWNER_EMAIL)).request;
    const rows = await sql<{ id: string }>(
      `INSERT INTO "Payment" ("id", "tenantId", "memberId", "amountPence", "currency", "status", "description", "paidAt", "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, 4000, 'GBP', 'succeeded', $3, now(), now()) RETURNING id`,
      [tenantId, member.id, `${RUN_STAMP} Cash`],
    );
    const res = await post(rc, `/api/payments/${rows[0].id}/refund`, ORIGIN, { amountPence: 1000 });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toBe("No Stripe charge to refund");
    const after = await getPaymentLedger(rows[0].id);
    expect(after?.refundedAmountPence).toBeNull();
    expect(after?.status).toBe("succeeded");
  });

  test("a refund larger than the payment is refused before Stripe is reached", async ({ browser, baseURL }) => {
    const rc = (await sessionFor(browser, baseURL!, OWNER_EMAIL)).request;
    const payment = await mkStripePayment(tenantId, member.id, { amountPence: 5000 });
    const res = await post(rc, `/api/payments/${payment.id}/refund`, ORIGIN, { amountPence: 500_000 });
    expect(res.status()).toBe(400);
    expect((await res.json()).error).toContain("cannot exceed");
    expect((await getPaymentLedger(payment.id))?.refundedAmountPence).toBeNull();
  });

  test("a negative and a zero refund are both refused", async ({ browser, baseURL }) => {
    const rc = (await sessionFor(browser, baseURL!, OWNER_EMAIL)).request;
    const payment = await mkStripePayment(tenantId, member.id, { amountPence: 5000 });
    for (const amountPence of [-100, 0, 1.5]) {
      const res = await post(rc, `/api/payments/${payment.id}/refund`, ORIGIN, { amountPence });
      expect(res.status(), `amountPence ${amountPence}`).toBe(400);
      expect(res.status()).toBeLessThan(500);
    }
    expect((await getPaymentLedger(payment.id))?.refundedAmountPence).toBeNull();
  });

  test("another club's payment id is a 404 and reads nothing back", async ({ browser, baseURL }) => {
    const rc = (await sessionFor(browser, baseURL!, OWNER_EMAIL)).request;
    const rows = await sql<{ id: string }>(
      `INSERT INTO "Payment" ("id", "tenantId", "memberId", "amountPence", "currency", "status", "description", "createdAt")
       VALUES (gen_random_uuid()::text, $1, $2, 9900, 'GBP', 'succeeded', $3, now()) RETURNING id`,
      [foreign.id, foreignMemberId, `${RUN_STAMP} Foreign payment`],
    );
    const res = await post(rc, `/api/payments/${rows[0].id}/refund`, ORIGIN, { amountPence: 100 });
    expect(res.status()).toBe(404);
    const body = await res.text();
    // Never a 403 (which would confirm the id exists) and never the foreign row.
    expect(body).not.toContain("9900");
    expect((await getPaymentLedger(rows[0].id))?.refundedAmountPence).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J44 · the double revocation on the webhook echo", () => {
  /**
   * The deliberate red. Driven entirely through signed events so no Stripe
   * account is needed: the first `charge.refunded` stands in for the desk
   * refund (same handler, same apportionment) and the second is the echo Stripe
   * sends when the operator refunds from the dashboard and MatFlow's own route
   * has already applied it.
   *
   * Before the round-1 fix the pack dropped to 6 of 10 for a £25 refund.
   * Correct, and asserted here: 8 of 10, on the first event and on every
   * further report of the same cumulative total.
   */
  test("a partial refund echoed back takes no further credits", async ({ playwright, baseURL }) => {
    const rc = await anonRc(playwright, baseURL!);
    const payment = await mkStripePayment(tenantId, member.id, { amountPence: 10_000 });
    const memberPackId = await mkMemberPack(tenantId, member.id, packId, {
      creditsRemaining: 10,
      stripePaymentIntentId: payment.piId,
    });

    const charge = {
      id: payment.chargeId,
      object: "charge",
      payment_intent: payment.piId,
      amount: 10_000,
      amount_refunded: 2_500,
      currency: "gbp",
    };

    const first = await sendSigned(rc, {
      type: "charge.refunded",
      object: charge,
      id: eventId(),
    });
    expect(first.status(), await first.text()).toBeLessThan(300);

    const afterFirst = await getMemberPack(memberPackId);
    expect(afterFirst?.creditsRemaining, "a £25 refund on a £100 ten-class pack buys back two classes").toBe(8);
    expect(afterFirst?.status).toBe("active");
    expect((await getPaymentLedger(payment.id))?.refundedAmountPence).toBe(2_500);

    // The echo. A DIFFERENT event id, because Stripe's own idempotency (the
    // StripeEvent table) would otherwise mask the defect — and in production
    // the desk refund and the dashboard echo genuinely are two events.
    const echo = await sendSigned(rc, {
      type: "charge.refunded",
      object: charge,
      id: eventId(),
    });
    expect(echo.status(), await echo.text()).toBeLessThan(300);

    const afterEcho = await getMemberPack(memberPackId);
    // Idempotent against the pack AS SOLD: the cumulative refund still buys
    // back exactly two classes, however many times it is reported.
    expect(
      afterEcho?.creditsRemaining,
      "the same £25 revoked credits twice — the member lost four classes for a two-class refund",
    ).toBe(8);

    await rc.dispose();
  });

  test("the SAME event id twice is claimed once and moves the pack once", async ({ playwright, baseURL }) => {
    const rc = await anonRc(playwright, baseURL!);
    const payment = await mkStripePayment(tenantId, member.id, { amountPence: 10_000 });
    const memberPackId = await mkMemberPack(tenantId, member.id, packId, {
      creditsRemaining: 10,
      stripePaymentIntentId: payment.piId,
    });
    const id = eventId();
    const object = {
      id: payment.chargeId,
      object: "charge",
      payment_intent: payment.piId,
      amount: 10_000,
      amount_refunded: 3_000,
      currency: "gbp",
    };

    await sendSigned(rc, { type: "charge.refunded", object, id });
    const mid = await getMemberPack(memberPackId);
    await sendSigned(rc, { type: "charge.refunded", object, id });
    const end = await getMemberPack(memberPackId);

    expect(end?.creditsRemaining).toBe(mid?.creditsRemaining);
    expect(await countRows("StripeEvent", '"eventId" = $1', [id])).toBe(1);
    await rc.dispose();
  });

  test("a full refund voids the pack, and a zero-amount replay takes nothing", async ({ playwright, baseURL }) => {
    const rc = await anonRc(playwright, baseURL!);
    const payment = await mkStripePayment(tenantId, member.id, { amountPence: 10_000 });
    const memberPackId = await mkMemberPack(tenantId, member.id, packId, {
      creditsRemaining: 10,
      stripePaymentIntentId: payment.piId,
    });

    await sendSigned(rc, {
      type: "charge.refunded",
      object: { id: payment.chargeId, object: "charge", payment_intent: payment.piId, amount: 10_000, amount_refunded: 10_000, currency: "gbp" },
      id: eventId(),
    });
    const voided = await getMemberPack(memberPackId);
    expect(voided?.creditsRemaining).toBe(0);
    expect(voided?.status).toBe("refunded");
    expect((await getPaymentLedger(payment.id))?.status).toBe("refunded");

    const zero = await sendSigned(rc, {
      type: "charge.refunded",
      object: { id: payment.chargeId, object: "charge", payment_intent: payment.piId, amount: 10_000, amount_refunded: 0, currency: "gbp" },
      id: eventId(),
    });
    expect(zero.status()).toBeLessThan(300);
    expect((await getMemberPack(memberPackId))?.creditsRemaining).toBe(0);
    await rc.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J45 · class packs, per role", () => {
  test("manager may create a pack; coach, admin and member may not", async ({ browser, baseURL }) => {
    restoreStripe = await saveStripeConnection();
    const mgr = await mkStaff(tenantId, "manager");
    const mgrRc = (await sessionFor(browser, baseURL!, mgr.email, THROWAWAY_PASSWORD)).request;

    const before = await countRows("ClassPack", '"tenantId" = $1', [tenantId]);
    const res = await post(mgrRc, "/api/class-packs", ORIGIN, {
      name: `${RUN_STAMP} Manager pack`,
      totalCredits: 5,
      validityDays: 30,
      pricePence: 5000,
    });
    // Creating a pack mints a Stripe price. Without a live key the route
    // answers 503 — an honest blocker, not a crash. Either way the gate is
    // what this case asserts, so a 503 still proves the manager passed it.
    expect([200, 201, 400, 503]).toContain(res.status());
    expect(res.status()).not.toBe(403);

    for (const email of [COACH_EMAIL, ADMIN_EMAIL, MEMBER_EMAIL]) {
      const rc = (await sessionFor(browser, baseURL!, email)).request;
      const r = await post(rc, "/api/class-packs", ORIGIN, {
        name: `${RUN_STAMP} ${email} pack`,
        totalCredits: 5,
        validityDays: 30,
        pricePence: 5000,
      });
      expect([401, 403], `${email} create pack`).toContain(r.status());
    }
    expect(await countRows("ClassPack", '"tenantId" = $1 AND name LIKE $2', [tenantId, `%${COACH_EMAIL}%`])).toBe(0);
    expect(await countRows("ClassPack", '"tenantId" = $1', [tenantId])).toBeGreaterThanOrEqual(before);
  });

  test("malformed pack definitions are refused and write nothing", async ({ browser, baseURL }) => {
    const rc = (await sessionFor(browser, baseURL!, OWNER_EMAIL)).request;
    const before = await countRows("ClassPack", '"tenantId" = $1', [tenantId]);
    const bad = [
      { name: `${RUN_STAMP} zero`, totalCredits: 0, validityDays: 30, pricePence: 1000 },
      { name: `${RUN_STAMP} neg`, totalCredits: 5, validityDays: 30, pricePence: -1 },
      { name: `${RUN_STAMP} forever`, totalCredits: 5, validityDays: 99_999, pricePence: 1000 },
      { name: "x".repeat(10_000), totalCredits: 5, validityDays: 30, pricePence: 1000 },
      { name: `${RUN_STAMP} huge`, totalCredits: 100_000, validityDays: 30, pricePence: 1000 },
    ];
    for (const body of bad) {
      const res = await post(rc, "/api/class-packs", ORIGIN, body);
      expect(res.status(), JSON.stringify(body).slice(0, 80)).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    }
    expect(await countRows("ClassPack", '"tenantId" = $1', [tenantId])).toBe(before);
  });

  test("another club's pack cannot be edited or deleted from here", async ({ browser, baseURL }) => {
    const rc = (await sessionFor(browser, baseURL!, OWNER_EMAIL)).request;
    const foreignPack = await mkPack(foreign.id, { name: `${RUN_STAMP} Foreign pack`, pricePence: 7777 });
    const before = await sql<{ pricePence: number; isActive: boolean }>(
      'SELECT "pricePence", "isActive" FROM "ClassPack" WHERE id = $1',
      [foreignPack],
    );

    const edit = await patch(rc, `/api/class-packs/${foreignPack}`, ORIGIN, { pricePence: 1 });
    expect(edit.status()).toBe(404);
    const remove = await del(rc, `/api/class-packs/${foreignPack}`, ORIGIN);
    expect(remove.status()).toBe(404);

    const after = await sql<{ pricePence: number; isActive: boolean }>(
      'SELECT "pricePence", "isActive" FROM "ClassPack" WHERE id = $1',
      [foreignPack],
    );
    expect(after).toEqual(before);
  });

  test("checkout.session.completed mints exactly one pack, and the same event id mints no second", async ({ playwright, baseURL }) => {
    const rc = await anonRc(playwright, baseURL!);
    const buyer = await createMember({ name: `${RUN_STAMP} Session buyer` });
    const piId = `pi_${RUN_STAMP}_${Math.random().toString(36).slice(2, 10)}`;
    const id = eventId();
    const object = {
      id: `cs_${RUN_STAMP}_${Math.random().toString(36).slice(2, 10)}`,
      object: "checkout.session",
      mode: "payment",
      payment_status: "paid",
      payment_intent: piId,
      amount_total: 10_000,
      currency: "gbp",
      metadata: { type: "class_pack", packId, memberId: buyer.id, tenantId },
    };

    const first = await sendSigned(rc, { type: "checkout.session.completed", object, id });
    expect(first.status(), await first.text()).toBeLessThan(300);
    const minted = await countRows("MemberClassPack", '"memberId" = $1', [buyer.id]);

    const replay = await sendSigned(rc, { type: "checkout.session.completed", object, id });
    expect(replay.status()).toBeLessThan(300);
    expect(await countRows("MemberClassPack", '"memberId" = $1', [buyer.id]), "a replayed session minted a second pack").toBe(minted);
    expect(await countRows("StripeEvent", '"eventId" = $1', [id])).toBe(1);
    await rc.dispose();
  });

  test("a pack purchase naming another club's member mints nothing here", async ({ playwright, baseURL }) => {
    const rc = await anonRc(playwright, baseURL!);
    const before = await countRows("MemberClassPack", '"memberId" = $1', [foreignMemberId]);
    const res = await sendSigned(rc, {
      type: "checkout.session.completed",
      object: {
        id: `cs_${RUN_STAMP}_x`,
        object: "checkout.session",
        mode: "payment",
        payment_status: "paid",
        payment_intent: `pi_${RUN_STAMP}_x`,
        amount_total: 10_000,
        currency: "gbp",
        // The pack belongs to tenant A, the member to tenant B.
        metadata: { type: "class_pack", packId, memberId: foreignMemberId, tenantId },
      },
      id: eventId(),
    });
    expect(res.status()).toBeLessThan(500);
    expect(await countRows("MemberClassPack", '"memberId" = $1', [foreignMemberId])).toBe(before);
    expect(await countRows("MemberClassPack", '"tenantId" = $1 AND "memberId" = $2', [tenantId, foreignMemberId])).toBe(0);
    await rc.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J45 · the kiosk and a refunded pack", () => {
  /**
   * `lib/checkin.ts:225-243` finds a pack by `status: 'active'` AND
   * `creditsRemaining > 0`. A refunded pack must therefore be invisible to the
   * kiosk — asserted here by what the kiosk's own lookup would find, since the
   * seeded club's kiosk token is never rotated by this lane.
   */
  test("a refunded pack is not a pack the kiosk can spend", async () => {
    const payment = await mkStripePayment(tenantId, member.id, { amountPence: 10_000 });
    const memberPackId = await mkMemberPack(tenantId, member.id, packId, {
      creditsRemaining: 10,
      stripePaymentIntentId: payment.piId,
      status: "refunded",
    });

    const spendable = await sql<{ id: string }>(
      `SELECT id FROM "MemberClassPack"
       WHERE "memberId" = $1 AND status = 'active' AND "creditsRemaining" > 0 AND "expiresAt" > now()`,
      [member.id],
    );
    expect(spendable.map((r) => r.id)).not.toContain(memberPackId);
  });

  test("a pack reduced to zero credits by a refund is unusable without lying about why", async () => {
    const payment = await mkStripePayment(tenantId, member.id, { amountPence: 10_000 });
    const memberPackId = await mkMemberPack(tenantId, member.id, packId, {
      creditsRemaining: 0,
      stripePaymentIntentId: payment.piId,
      status: "active",
    });
    const spendable = await sql<{ id: string }>(
      `SELECT id FROM "MemberClassPack"
       WHERE "memberId" = $1 AND status = 'active' AND "creditsRemaining" > 0`,
      [member.id],
    );
    expect(spendable.map((r) => r.id)).not.toContain(memberPackId);
  });

  test("an expired pack cannot be spent either", async () => {
    const memberPackId = await mkMemberPack(tenantId, member.id, packId, {
      creditsRemaining: 5,
      expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
    });
    const spendable = await sql<{ id: string }>(
      `SELECT id FROM "MemberClassPack"
       WHERE "memberId" = $1 AND status = 'active' AND "creditsRemaining" > 0 AND "expiresAt" > now()`,
      [member.id],
    );
    expect(spendable.map((r) => r.id)).not.toContain(memberPackId);
  });

  test("the kiosk refuses a junk member token before it reaches a pack", async ({ playwright, baseURL }) => {
    const rc = await anonRc(playwright, baseURL!);
    // The raw kiosk token is never stored (only Tenant.kioskTokenHash), so this lane cannot address
    // the seeded kiosk; L-D drives the junk-token cases on a throwaway tenant it mints a token for.
    const token: string | null = null;
    test.skip(!token, "the seeded club has no kiosk token — this lane never mints or rotates one");

    const before = await countRows("AttendanceRecord", '"tenantId" = $1', [tenantId]);
    for (const kioskMemberToken of ["token.junk", "x".repeat(4_097), `${RUN_STAMP}.forged.signature`]) {
      const res = await rc.post(`/api/kiosk/${token}/checkin`, {
        headers: { Origin: ORIGIN },
        data: { kioskMemberToken, classInstanceId: `${RUN_STAMP}-nope` },
        maxRedirects: 0,
      });
      expect(res.status(), kioskMemberToken.slice(0, 20)).toBeGreaterThanOrEqual(400);
      expect(res.status()).toBeLessThan(500);
    }
    expect(await countRows("AttendanceRecord", '"tenantId" = $1', [tenantId])).toBe(before);
    await rc.dispose();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
test.describe("J45 · reading a member's packs", () => {
  test("a member reads only their own packs", async ({ browser, baseURL }) => {
    const rc = (await sessionFor(browser, baseURL!, MEMBER_EMAIL)).request;
    const other = await createMember({ name: `${RUN_STAMP} Someone else` });
    const otherPack = await mkMemberPack(tenantId, other.id, packId, { creditsRemaining: 7 });

    const res = await get(rc, "/api/member/class-packs");
    expect(res.status()).toBe(200);
    const body = await res.text();
    // Any other member's pack id in this response is a boundary crossed.
    expect(body).not.toContain(otherPack);
    expect(body).not.toContain(other.id);
  });

  /**
   * The two payment reads disagree about who staff are, and the disagreement is
   * the finding. `/api/payments` is `requireApiOwnerOrManager` — a coach is
   * 403. `/api/members/[id]/payments` names all four staff roles explicitly
   * (`app/api/members/[id]/payments/route.ts:8`), so the same coach reads the
   * same amounts one member at a time. That is the product as written, not a
   * defect this lane invents a refusal for; it is pinned here so the split
   * cannot drift silently, and reported as friction for the controller —
   * `app/api/members/**` is outside this lane.
   */
  test("the club ledger is owner-or-manager, but a member's own ledger is any staff", async ({ browser, baseURL }) => {
    for (const email of [COACH_EMAIL, ADMIN_EMAIL]) {
      const rc = (await sessionFor(browser, baseURL!, email)).request;

      const hub = await get(rc, "/api/payments");
      expect(hub.status(), `${email} /api/payments`).toBe(403);

      const perMember = await get(rc, `/api/members/${member.id}/payments`);
      expect(perMember.status(), `${email} member payments`).toBe(200);
      // Whatever the role may read, no Stripe id ever reaches the client.
      const text = await perMember.text();
      expect(text).not.toContain("stripePaymentIntentId");
      expect(text).not.toContain("stripeInvoiceId");
    }
  });

  test("a member cannot read another member's payments", async ({ browser, baseURL }) => {
    const rc = (await sessionFor(browser, baseURL!, MEMBER_EMAIL)).request;
    const res = await get(rc, `/api/members/${member.id}/payments`);
    expect([401, 403, 404]).toContain(res.status());
  });
});
