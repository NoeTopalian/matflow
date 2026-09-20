import { test, expect, type APIRequestContext, type Browser } from "@playwright/test";
import { createHmac } from "node:crypto";
import {
  RUN_STAMP,
  cleanupRun,
  createMember,
  createPayment,
  getTenantStripe,
  seededTenantId,
  sql,
} from "./helpers/db";

/**
 * L-D — the money a club takes back.
 *
 * The cash desk (`cash-money.spec.ts`) and the webhook door
 * (`stripe-webhooks.spec.ts`) are proven. Refunds and class packs — the two
 * ways a club takes the wrong amount, or destroys credits a member has paid
 * for — had unit tests and no journey at all. This file is that journey:
 * credits are redeemed at check-in, money is given back in stages, and the
 * pack is asserted in Postgres after every stage.
 *
 * ## Why the refund arrives as a webhook and not through the owner's Refund button
 *
 * `app/api/payments/[id]/refund/route.ts:108-112` refuses any payment with no
 * `stripeChargeId`/`stripePaymentIntentId` and any club with no
 * `stripeAccountId`, then calls `stripe.charges.retrieve` and
 * `stripe.refunds.create` against the live Stripe test API (lines 153, 189).
 * Driving it from here would mean creating a REAL PaymentIntent on the
 * connected account and confirming it with a test card — a different lane's
 * worth of work, and one that cannot run offline. The apportionment itself is
 * shared: both the owner route (line 327) and the `charge.refunded` branch of
 * the webhook (`app/api/stripe/webhook/route.ts:657`) call the same
 * `packCreditsAfterRefund`, on the same pack, keyed the same way. So the
 * webhook exercises the identical arithmetic through a real HTTP route with a
 * real signature. What is NOT proven here is the owner route's own wiring; see
 * the report for that gap.
 *
 * ## Why the pack is funded by a Stripe payment and not a cash one
 *
 * The brief asked for a cash-funded pack. There is no such thing in this
 * product: `MemberClassPack` is created in exactly one place in the codebase
 * (`app/api/stripe/webhook/route.ts:438`, `checkout.session.completed`) and is
 * linked to its funding payment ONLY by `stripePaymentIntentId`
 * (`prisma/schema.prisma:856`). A pack paid for at the desk cannot be sold,
 * cannot be linked, and cannot have its credits revoked by any refund path.
 * Recorded in the report as a product gap rather than faked here.
 */

test.describe.configure({ mode: "serial" });

const SCOPE = `LD-${RUN_STAMP}`;
const PACK_CREDITS = 10;
const PACK_PRICE_PENCE = 5000; // £50 — £5 per class.
const WEBHOOK_PATH = "/api/stripe/webhook";
const MEMBER_PASSWORD = process.env.TEST_PASSWORD ?? "password123";

// ── Stripe event plumbing (same scheme as stripe-webhooks.spec.ts) ────────────

function signPayload(payload: string, signingSecret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", signingSecret).update(`${timestamp}.${payload}`).digest("hex");
  return `t=${timestamp},v1=${v1}`;
}

function secret(): string {
  const s = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s) throw new Error("STRIPE_WEBHOOK_SECRET is not set — see .env.test.");
  return s;
}

function eventId(): string {
  return `evt_${RUN_STAMP}_${Math.random().toString(36).slice(2, 10)}`;
}

/** POST a genuinely-signed `charge.refunded` carrying Stripe's CUMULATIVE total. */
async function postRefund(
  request: APIRequestContext,
  opts: { account: string; chargeId: string; paymentIntentId: string; amountRefunded: number },
) {
  const event = {
    id: eventId(),
    object: "event",
    api_version: "2026-03-25.dahlia",
    created: Math.floor(Date.now() / 1000),
    type: "charge.refunded",
    livemode: false,
    pending_webhooks: 0,
    request: { id: null, idempotency_key: null },
    account: opts.account,
    data: {
      object: {
        id: opts.chargeId,
        payment_intent: opts.paymentIntentId,
        amount_refunded: opts.amountRefunded,
      },
    },
  };
  const payload = JSON.stringify(event);
  const res = await request.post(WEBHOOK_PATH, {
    headers: { "content-type": "application/json", "stripe-signature": signPayload(payload, secret()) },
    data: payload,
  });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

// ── Pack / attendance readers ────────────────────────────────────────────────

async function readPack(id: string) {
  const rows = await sql<{ id: string; creditsRemaining: number; status: string }>(
    'SELECT id, "creditsRemaining", status FROM "MemberClassPack" WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

async function redemptionsFor(packId: string) {
  return sql<{ id: string; attendanceRecordId: string }>(
    'SELECT id, "attendanceRecordId" FROM "ClassPackRedemption" WHERE "memberPackId" = $1 ORDER BY "redeemedAt" ASC',
    [packId],
  );
}

async function readPayment(id: string) {
  const rows = await sql<{ status: string; refundedAmountPence: number | null }>(
    'SELECT status, "refundedAmountPence" FROM "Payment" WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

async function attendanceFor(memberId: string) {
  return sql<{ id: string; classInstanceId: string }>(
    'SELECT id, "classInstanceId" FROM "AttendanceRecord" WHERE "memberId" = $1',
    [memberId],
  );
}

// ── Arrangement ──────────────────────────────────────────────────────────────

/**
 * "Today" as the CLUB reckons it. `lib/checkin.ts` resolves the check-in window
 * with `parseTime(startTime, instance.date, tenant.timezone)`, so an instance
 * dated by the test machine's calendar (UTC+8 here) can sit on a different day
 * from the club's and fail the window gate for a reason that has nothing to do
 * with packs.
 */
function todayInZone(zone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return parts; // en-CA formats as YYYY-MM-DD
}

interface PackFixture {
  memberId: string;
  memberEmail: string;
  packId: string;
  memberPackId: string;
  paymentId: string;
  chargeId: string;
  paymentIntentId: string;
}

let tenantId: string;
let tenantZone: string;
let account: string;
let ownerUserId: string;
let classId: string;
const instanceIds: string[] = [];
let borrowedHash: string;
let packId: string;
let packA: PackFixture;
let packB: PackFixture;
const contexts: Array<{ close: () => Promise<void> }> = [];

/** A member who can log in, plus the pack that funds them. */
async function arrangeMemberWithPack(label: string): Promise<PackFixture> {
  const member = await createMember({ name: `${SCOPE} ${label}` });
  // A Member signs in with `Member.passwordHash` (auth.ts:418). Borrowing the
  // seeded member's hash means this account uses exactly the credential the
  // rest of the suite uses, and it is deleted again by cleanupRun().
  await sql('UPDATE "Member" SET "passwordHash" = $1 WHERE id = $2', [borrowedHash, member.id]);
  // The waiver gate is enforced server-side for self check-in now; a fixture
  // member who never signed would be a 403 where these cells assert 201/402.
  await sql('UPDATE "Member" SET "waiverAccepted" = true WHERE id = $1', [member.id]);

  const chargeId = `ch_${RUN_STAMP}_${label}`;
  const paymentIntentId = `pi_${RUN_STAMP}_${label}`;
  const payment = await createPayment({
    memberId: member.id,
    amountPence: PACK_PRICE_PENCE,
    status: "succeeded",
    stripeChargeId: chargeId,
    stripePaymentIntentId: paymentIntentId,
    description: `${RUN_STAMP} ${label} ten-class pack`,
  });

  const packRows = await sql<{ id: string }>(
    `INSERT INTO "MemberClassPack" ("id", "tenantId", "memberId", "packId", "creditsRemaining",
                                    "purchasedAt", "expiresAt", "stripePaymentIntentId", "status")
     VALUES (gen_random_uuid()::text, $1, $2, $3, $4, now(), now() + interval '90 days', $5, 'active')
     RETURNING id`,
    [tenantId, member.id, packId, PACK_CREDITS, paymentIntentId],
  );

  return {
    memberId: member.id,
    memberEmail: member.email,
    packId,
    memberPackId: packRows[0].id,
    paymentId: payment.id,
    chargeId,
    paymentIntentId,
  };
}

test.beforeAll(async () => {
  tenantId = await seededTenantId();

  const tenantRows = await sql<{ timezone: string | null }>(
    'SELECT timezone FROM "Tenant" WHERE id = $1',
    [tenantId],
  );
  tenantZone = tenantRows[0]?.timezone || "Europe/London";

  const stripe = await getTenantStripe();
  if (!stripe?.stripeAccountId) {
    throw new Error(
      "The seeded club has no stripeAccountId, so no charge.refunded event can be attributed to it. " +
        "Run scripts/stripe-test-connect.mjs, or set one on the test branch.",
    );
  }
  account = stripe.stripeAccountId;

  const owner = await sql<{ id: string }>(
    `SELECT id FROM "User" WHERE "tenantId" = $1 AND role = 'owner' ORDER BY "createdAt" ASC LIMIT 1`,
    [tenantId],
  );
  if (owner.length === 0) throw new Error("Seeded owner user is missing — re-seed the test branch.");
  ownerUserId = owner[0].id;

  const hashRow = await sql<{ passwordHash: string }>(
    `SELECT "passwordHash" FROM "Member"
     WHERE "tenantId" = $1 AND "passwordHash" IS NOT NULL AND email NOT LIKE $2
     ORDER BY "joinedAt" ASC LIMIT 1`,
    [tenantId, `${RUN_STAMP}-%`],
  );
  if (hashRow.length === 0) {
    throw new Error(
      "No seeded Member carries a passwordHash, so no member can sign in to self-check-in. Re-seed the test branch.",
    );
  }
  borrowedHash = hashRow[0].passwordHash;

  // One class, instructed by the owner, with four instances across today so a
  // member can check in more than once without tripping the per-instance
  // duplicate guard. 00:00–23:59 in the CLUB's zone, so the window gate is
  // open for the whole of the club's today whatever the runner's clock says.
  const classRows = await sql<{ id: string }>(
    `INSERT INTO "Class" ("id", "tenantId", "name", "duration", "instructorId", "isActive", "createdAt")
     VALUES (gen_random_uuid()::text, $1, $2, 60, $3, true, now())
     RETURNING id`,
    [tenantId, `${SCOPE} pack classes`, ownerUserId],
  );
  classId = classRows[0].id;

  const day = todayInZone(tenantZone);
  for (let i = 0; i < 6; i += 1) {
    const rows = await sql<{ id: string }>(
      `INSERT INTO "ClassInstance" ("id", "classId", "date", "startTime", "endTime", "isCancelled")
       VALUES (gen_random_uuid()::text, $1, $2::timestamp, $3, '23:59', false)
       RETURNING id`,
      // ClassInstance is unique on (classId, date, startTime), so the six
      // instances differ by a minute. All of them run to 23:59, so the window
      // [start - 30min, end + 30min] is open for the whole of the club's day
      // whatever the runner's clock says.
      [classId, `${day} 12:00:00`, `00:0${i}`],
    );
    instanceIds.push(rows[0].id);
  }

  const packRows = await sql<{ id: string }>(
    `INSERT INTO "ClassPack" ("id", "tenantId", "name", "totalCredits", "validityDays", "pricePence",
                              currency, "isActive", "createdAt", "updatedAt")
     VALUES (gen_random_uuid()::text, $1, $2, $3, 90, $4, 'GBP', true, now(), now())
     RETURNING id`,
    [tenantId, `${SCOPE} ten-class`, PACK_CREDITS, PACK_PRICE_PENCE],
  );
  packId = packRows[0].id;

  packA = await arrangeMemberWithPack("a");
  packB = await arrangeMemberWithPack("b");
});

test.afterAll(async () => {
  for (const c of contexts) await c.close().catch(() => {});
  if (instanceIds.length) {
    await sql('DELETE FROM "AttendanceRecord" WHERE "classInstanceId" = ANY($1)', [instanceIds]).catch(() => {});
  }
  await cleanupRun();
  if (classId) {
    await sql('DELETE FROM "ClassInstance" WHERE "classId" = $1', [classId]).catch(() => {});
    await sql('DELETE FROM "ClassRoster" WHERE "classId" = $1', [classId]).catch(() => {});
    await sql('DELETE FROM "ClassSubscription" WHERE "classId" = $1', [classId]).catch(() => {});
    await sql('DELETE FROM "Class" WHERE id = $1', [classId]).catch(() => {});
  }
  if (packId) await sql('DELETE FROM "ClassPack" WHERE id = $1', [packId]).catch(() => {});
});

/**
 * A signed-in member's API context. The self branch of POST /api/checkin
 * (`app/api/checkin/route.ts:129-141`) resolves the member from the SESSION
 * email and forces `checkInMethod: "self"`, which is the only caller that asks
 * `performCheckin` for coverage — i.e. the only caller that redeems a pack
 * credit and the only one that can answer "no coverage".
 */
async function memberRequest(browser: Browser, email: string): Promise<APIRequestContext> {
  const context = await browser.newContext({ storageState: undefined });
  // Belt and braces, copied from authorisation.spec.ts:88-93 — whether
  // browser.newContext() inherits the project's use.storageState has changed
  // across Playwright versions, and inheriting the OWNER session here would
  // send the self check-in down the staff branch, which never redeems a credit.
  await context.clearCookies();
  contexts.push(context);
  const page = await context.newPage();
  await page.goto("/login?club=totalbjj");
  await page.waitForSelector("input[type='email']", { timeout: 45_000 });
  await page.fill("input[type='email']", email);
  await page.fill("input[type='password']", MEMBER_PASSWORD);
  await page.click("button[type='submit']");
  await page.waitForURL(/member|dashboard/, { timeout: 45_000 });
  await page.close();
  return context.request;
}

async function selfCheckin(rc: APIRequestContext, baseURL: string, classInstanceId: string) {
  const res = await rc.post("/api/checkin", {
    headers: { Origin: baseURL },
    data: { classInstanceId },
  });
  return { status: res.status(), body: await res.json().catch(() => ({})) };
}

// ── Case 1-3: redeem, then give the money back in stages ─────────────────────

test.describe("a ten-class pack, redeemed and then refunded in stages", () => {
  let memberApi: APIRequestContext;

  test("two self check-ins redeem two credits and leave two redemption rows", async ({ browser, baseURL }) => {
    memberApi = await memberRequest(browser, packA.memberEmail);

    const first = await selfCheckin(memberApi, baseURL!, instanceIds[0]);
    expect(first.status, `first check-in answered ${first.status}: ${JSON.stringify(first.body)}`).toBe(201);
    expect(first.body.coverage).toMatchObject({ kind: "pack", creditsRemaining: PACK_CREDITS - 1 });

    const second = await selfCheckin(memberApi, baseURL!, instanceIds[1]);
    expect(second.status, `second check-in answered ${second.status}: ${JSON.stringify(second.body)}`).toBe(201);

    // The consequence, in Postgres, not the response body.
    expect((await readPack(packA.memberPackId))?.creditsRemaining).toBe(8);
    expect((await redemptionsFor(packA.memberPackId)).length).toBe(2);
  });

  test("£5 back off a £50 ten-class pack revokes exactly one class, not ten", async ({ request }) => {
    // The defect `lib/pack-refund.ts` exists to remove voided the WHOLE pack on
    // any refund. The rule that replaced it is line 83:
    //   `Math.floor((refundedPence * totalCredits) / paidPence)`
    // £5 of a £50 ten-class pack is exactly one class at £5 each, so one credit
    // goes. (The brief called this "less than one class" and expected 8 — that
    // is £50/10 = £5 arithmetic, and £5 buys a whole class. Asserted against
    // the helper, which is the product.)
    const res = await postRefund(request, {
      account,
      chargeId: packA.chargeId,
      paymentIntentId: packA.paymentIntentId,
      amountRefunded: 500,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const payment = await readPayment(packA.paymentId);
    expect(payment?.refundedAmountPence, "the partial refund must be on the ledger").toBe(500);
    expect(payment?.status, "a partial refund leaves the remainder refundable").toBe("succeeded");

    const pack = await readPack(packA.memberPackId);
    expect(pack?.creditsRemaining, "one class refunded, one class revoked — the other seven stand").toBe(7);
    expect(pack?.status, "a partial refund must not void the pack").toBe("active");
  });

  test("a second partial refund revokes the classes it paid for, and no more", async ({ request }) => {
    // Was a KNOWN RED, fixed in round 1: lib/pack-refund.ts double-counted
    // successive partials and the webhook echo.
    //
    // `refundedPence` is Stripe's CUMULATIVE total (the field doc says so, and
    // both call sites pass `newRefundedTotal` / `amount_refunded`), but the
    // helper used to subtract the credits it computed from the CURRENT
    // `creditsRemaining` — which already had the previous refund's revocation
    // taken out of it. £5 then £25 is £30 back on a £50 pack = six classes; the
    // member used two, so ten minus two attended minus six revoked is TWO. The
    // old helper took one for the £5, then six more for the cumulative £30, and
    // left ONE — destroying a class the member was never refunded for.
    //
    // The sum now runs against the pack AS SOLD, less the redemption count, in
    // the helper and at both call sites (the owner refund route and
    // app/api/stripe/webhook/route.ts), so the same cumulative total lands on
    // the same answer wherever and however often it is reported.
    const res = await postRefund(request, {
      account,
      chargeId: packA.chargeId,
      paymentIntentId: packA.paymentIntentId,
      amountRefunded: 3000, // cumulative: the first £5 plus a further £25
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect((await readPayment(packA.paymentId))?.refundedAmountPence).toBe(3000);
    expect(
      (await readPack(packA.memberPackId))?.creditsRemaining,
      "£30 back on a £50 ten-class pack is six classes; eight remaining minus six is two",
    ).toBe(2);
  });

  test("the full refund voids the pack, and the next check-in is refused", async ({ request, baseURL }) => {
    const res = await postRefund(request, {
      account,
      chargeId: packA.chargeId,
      paymentIntentId: packA.paymentIntentId,
      amountRefunded: PACK_PRICE_PENCE,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const payment = await readPayment(packA.paymentId);
    expect(payment?.status, "an exhausted charge is refunded").toBe("refunded");
    expect(payment?.refundedAmountPence).toBe(PACK_PRICE_PENCE);

    const pack = await readPack(packA.memberPackId);
    expect(pack?.status).toBe("refunded");
    expect(pack?.creditsRemaining).toBe(0);

    const before = (await redemptionsFor(packA.memberPackId)).length;
    const refused = await selfCheckin(memberApi, baseURL!, instanceIds[2]);
    expect(refused.status, "a refunded pack is not coverage").toBe(402);
    expect(refused.body.error).toContain("No active membership or class pack credits");
    expect(
      (await redemptionsFor(packA.memberPackId)).length,
      "a refused check-in must not mint a redemption row",
    ).toBe(before);
    const attended = await attendanceFor(packA.memberId);
    expect(
      attended.some((a) => a.classInstanceId === instanceIds[2]),
      "a refused check-in must not record attendance either",
    ).toBe(false);
  });
});

// ── Case 4: undoing an attendance gives the credit back — unless it was refunded ──

test.describe("undoing an attendance", () => {
  let memberApi: APIRequestContext;

  test("restores the credit it consumed and clears the redemption row", async ({ browser, request, baseURL }) => {
    memberApi = await memberRequest(browser, packB.memberEmail);

    const a = await selfCheckin(memberApi, baseURL!, instanceIds[3]);
    expect(a.status, JSON.stringify(a.body)).toBe(201);
    const b = await selfCheckin(memberApi, baseURL!, instanceIds[4]);
    expect(b.status, JSON.stringify(b.body)).toBe(201);
    expect((await readPack(packB.memberPackId))?.creditsRemaining).toBe(8);

    const undo = await request.post(`/api/coach/instances/${instanceIds[3]}/attendance`, {
      headers: { Origin: baseURL! },
      data: { memberId: packB.memberId, attended: false },
    });
    expect(undo.status(), await undo.text()).toBe(200);

    expect(
      (await readPack(packB.memberPackId))?.creditsRemaining,
      "the credit the deleted attendance consumed must come back (lib/checkin.ts:113)",
    ).toBe(9);
    const rows = await redemptionsFor(packB.memberPackId);
    expect(rows.length, "the orphaned redemption row must go with it").toBe(1);
    expect(
      (await attendanceFor(packB.memberId)).some((r) => r.classInstanceId === instanceIds[3]),
      "the attendance itself must be gone",
    ).toBe(false);
  });

  test("on a refunded pack the restore is skipped — the member is not paid twice", async ({ request, baseURL }) => {
    // lib/checkin.ts:112 — `if (r.memberPack?.status === "refunded") continue;`
    // The row still goes (line 93, unconditional); only the credit is withheld.
    await postRefund(request, {
      account,
      chargeId: packB.chargeId,
      paymentIntentId: packB.paymentIntentId,
      amountRefunded: PACK_PRICE_PENCE,
    });
    const refunded = await readPack(packB.memberPackId);
    expect(refunded?.status).toBe("refunded");
    expect(refunded?.creditsRemaining).toBe(0);
    expect((await redemptionsFor(packB.memberPackId)).length, "the second attendance still holds its row").toBe(1);

    const undo = await request.post(`/api/coach/instances/${instanceIds[4]}/attendance`, {
      headers: { Origin: baseURL! },
      data: { memberId: packB.memberId, attended: false },
    });
    expect(undo.status(), await undo.text()).toBe(200);

    expect(
      (await readPack(packB.memberPackId))?.creditsRemaining,
      "money already returned — handing back a spendable credit would pay the member twice",
    ).toBe(0);
    expect(
      (await redemptionsFor(packB.memberPackId)).length,
      "the orphaned redemption row goes regardless, refunded or not",
    ).toBe(0);
  });
});
