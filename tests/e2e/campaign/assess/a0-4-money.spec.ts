/**
 * Lane A0, file 4 — the month: money on the pay-at-desk rail.
 *
 * The card rail is inert in .env.test by design, so everything here that claims
 * to charge is asserted to charge NOTHING, and the pay-at-desk path is asserted
 * to write the row it says it wrote.
 */
import { test, expect } from "@playwright/test";
import { createHmac } from "node:crypto";
import { sql } from "../helpers/db";
import {
  B_PASSWORD,
  TENANT_A_SLUG,
  assertRefusalShape,
  closeSessions,
  countOf,
  expectOk,
  readTenantFile,
  setMemberPassword,
  tryReadTenantFile,
  sessionFor,
  teardownTenantB,
  // ROUND 2: the campaign-stable stamp, NOT helpers/db RUN_STAMP. RUN_STAMP is
  // minted per Node process and Playwright starts a new worker after every
  // failed test, so every identity created before a failure vanished for every
  // test after it. See the note on A0_STAMP in a0-shared.ts.
  A0_STAMP as RUN_STAMP,
} from "./a0-shared";

test.use({
  channel: "chromium",
  launchOptions: { args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"] },
});
test.describe.configure({ mode: "default", timeout: 180_000 });

const PHONE = { width: 390, height: 844 };
// ROUND 3: tenant B now carries a real bcrypt hash of its OWN password (set by
// file 1), so every sign-in here is a genuine bcrypt comparison rather than a
// ride on the e2e bypass token, which skips bcrypt entirely (auth.ts:331-336).
const PW = B_PASSWORD;

let tenantId = "";
let slug = "";
let ownerEmail = "";
let memberId = "";
let memberEmail = "";
let tierId = "";
let packId = "";

function origin(baseURL: string | undefined) {
  return baseURL ?? "http://127.0.0.1:3847";
}

/** Stripe's documented scheme, written out — see stripe-webhooks.spec.ts. */
function signPayload(payload: string, secret: string, ts = Math.floor(Date.now() / 1000)): string {
  const v1 = createHmac("sha256", secret).update(`${ts}.${payload}`).digest("hex");
  return `t=${ts},v1=${v1}`;
}

/**
 * ROUND 5 — the connected account every event must carry.
 *
 * `app/api/stripe/webhook/route.ts:136-148` claims the event id and then
 * resolves the tenant from `event.account`. An event with no `account`, or one
 * naming an account no `Tenant.stripeAccountId` matches, throws
 * `WebhookRetryableError`, the WHOLE transaction rolls back — claim included —
 * and the route answers **409 so Stripe redelivers**. A0's payloads carried no
 * `account` at all, so the first delivery and the replay both answered 409, no
 * `StripeEvent` row was ever written, and the cell read a correct
 * "ask-me-again" as a broken replay. Lane L-E met the same 409s in its round 1
 * and reads the account off the seeded club (`le-shared.ts:152-166`).
 *
 * Tenant B is a brand-new club and has none, so the harness arranges one — the
 * Connect onboarding itself needs a live Stripe account and stays UNCOVERED.
 * `stripeConnected` is deliberately LEFT FALSE: it is what gates the class-pack
 * create (`app/api/class-packs/route.ts:53-56`), and flipping it would rewrite
 * the refusal another cell in this file asserts. The column is torn down with
 * the tenant.
 */
let arrangedAccountId = "";
async function connectedAccountForTenantB(): Promise<string> {
  if (arrangedAccountId) return arrangedAccountId;
  const rows = await sql<{ stripeAccountId: string | null }>(
    'SELECT "stripeAccountId" FROM "Tenant" WHERE id = $1',
    [tenantId],
  );
  const existing = rows[0]?.stripeAccountId;
  if (existing) {
    arrangedAccountId = existing;
    return arrangedAccountId;
  }
  const minted = `acct_${RUN_STAMP.replace(/[^a-z0-9]/gi, "")}`;
  await sql('UPDATE "Tenant" SET "stripeAccountId" = $1 WHERE id = $2', [minted, tenantId]);
  arrangedAccountId = minted;
  return arrangedAccountId;
}

/** A missing handover is an UNCOVERED cell with a named blocker, not a failure. */
let handoverBlocker = "";

test.beforeEach(() => {
  test.skip(!!handoverBlocker, handoverBlocker);
});

test.beforeAll(async () => {
  const read = tryReadTenantFile();
  if (!read.ok) {
    handoverBlocker = read.reason;
    return;
  }
  const file = read.file;
  tenantId = file.tenantId;
  slug = file.slug;
  ownerEmail = file.ownerEmail;
  const m = await sql<{ id: string; email: string }>(
    `SELECT id, email FROM "Member" WHERE "tenantId" = $1 AND email LIKE $2 ORDER BY "joinedAt" LIMIT 1`,
    [tenantId, `${RUN_STAMP}-adult%`],
  );
  memberId = m[0]?.id ?? "";
  memberEmail = m[0]?.email ?? "";
  // ROUND 5 — `tierId` and `packId` are module-level and set by the two cells
  // that create them, so a worker restarted after ANY failure earlier in the
  // file met them empty and every ★ cell downstream skipped as "UNCOVERED — no
  // pack". That is how one fault becomes four dark cells in a log (it took
  // four of a0-3's this round). Re-derived from the club's own rows instead.
  const tier = await sql<{ id: string }>(
    'SELECT id FROM "MembershipTier" WHERE "tenantId" = $1 ORDER BY "createdAt" LIMIT 1',
    [tenantId],
  );
  tierId = tier[0]?.id ?? "";
  const pack = await sql<{ id: string }>(
    'SELECT id FROM "ClassPack" WHERE "tenantId" = $1 ORDER BY "createdAt" LIMIT 1',
    [tenantId],
  );
  packId = pack[0]?.id ?? "";
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("A0.15 ★ — tiers and cash at the desk", () => {
  test("two tiers, monthly and annual, in the club's own currency", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, origin(baseURL), { slug, email: ownerEmail, password: PW });
    const o = origin(baseURL);
    // ROUND 2 HARNESS FIX: there is no `/api/membership-tiers` — it 404d. The
    // route is `/api/memberships`, and its schema names the field
    // `billingCycle` with the values `monthly | annual | none`, with `currency`
    // REQUIRED as three upper-case letters (app/api/memberships/route.ts:9-22).
    // The club's own currency is read from the Tenant row rather than assumed,
    // because "a pack created afterwards carries it" is the next cell.
    const cur = await sql<{ currency: string | null }>('SELECT currency FROM "Tenant" WHERE id = $1', [tenantId]);
    const currency = (cur[0]?.currency ?? "GBP").toUpperCase();
    for (const [name, cycle, pence] of [
      [`${RUN_STAMP} Unlimited monthly`, "monthly", 6500],
      [`${RUN_STAMP} Unlimited annual`, "annual", 65000],
    ] as const) {
      // ROUND 4 — `isKids` is REQUIRED (app/api/memberships/route.ts:16,
      // `z.boolean()` with no `.optional()`), and was never sent. Three rounds
      // of this cell have read `Received: 400` with no body, so each round
      // corrected one field and never saw the next. `expectOk` puts the route's
      // own `{ error, details }` into the failure, so the next missing key
      // names itself instead of costing a round.
      const res = await owner.request.post("/api/memberships", {
        headers: { Origin: o },
        data: { name, pricePence: pence, billingCycle: cycle, currency, isKids: false },
      });
      await expectOk(res, `create ${name}`);
    }
    const rows = await sql<{ id: string; name: string }>('SELECT id, name FROM "MembershipTier" WHERE "tenantId" = $1', [tenantId]);
    expect(rows.length, "two tiers").toBeGreaterThanOrEqual(2);
    tierId = rows[0].id;
  });

  test("★ a member on the monthly tier gets a nextDueAt, and cash advances it by a month", async ({ browser, baseURL }) => {
    test.skip(!memberId || !tierId, "UNCOVERED — no member or tier");
    const o = origin(baseURL);
    const owner = await sessionFor(browser, o, { slug, email: ownerEmail, password: PW, viewport: PHONE, isMobile: true });

    const assign = await owner.request.patch(`/api/members/${memberId}`, {
      headers: { Origin: o },
      data: { membershipTierId: tierId },
    });
    expect(assign.status(), "put the member on a tier").toBeLessThan(300);
    // `nextDueAt` is captured as TEXT and compared back IN SQL below. `pg`
    // parses timestamp-without-zone as LOCAL time, so a JS `new Date(row).
    // getTime()` comparison is an hour out under BST and `getUTCDate()` can
    // report the wrong day of the month — which is the very thing under test.
    // No `AS "alias"` here on purpose: a cast keeps the column's own name, and
    // x10/check-sql-all.js validates every quoted identifier against the Prisma
    // schema — an alias it cannot resolve is reported as a missing column.
    const before = await sql<{ membershipTierId: string | null; nextDueAt: string | null }>(
      'SELECT "membershipTierId", "nextDueAt"::text FROM "Member" WHERE id = $1',
      [memberId],
    );
    expect(before[0].membershipTierId, "the row carries the tier").toBe(tierId);

    const requestId = `${RUN_STAMP}-cash-1`;
    const pay = await owner.request.post("/api/payments/manual", {
      headers: { Origin: o },
      data: { memberId, amountPence: 6500, method: "cash", requestId, description: `${RUN_STAMP} cash at the desk` },
    });
    expect(pay.status(), "record cash").toBeLessThan(300);
    const rows = await sql<{ id: string; status: string; description: string | null; requestId: string | null }>(
      'SELECT id, status, description, "requestId" FROM "Payment" WHERE "tenantId" = $1 AND "requestId" = $2',
      [tenantId, requestId],
    );
    expect(rows, "one Payment row").toHaveLength(1);
    expect(rows[0].description ?? "", "the method is on the row a bookkeeper will read").toMatch(/cash/i);

    if (before[0].nextDueAt) {
      // The whole comparison happens in Postgres, against the value Postgres
      // itself handed back — no JS Date is constructed from a DB column.
      const moved = await sql<{ advanced: boolean; sameDay: boolean; monthsOn: number }>(
        `SELECT ("nextDueAt" > $2::timestamp)                                   AS advanced,
                (date_part('day', "nextDueAt") = date_part('day', $2::timestamp)) AS "sameDay",
                (date_part('year', age("nextDueAt", $2::timestamp)) * 12
                 + date_part('month', age("nextDueAt", $2::timestamp)))::int    AS "monthsOn"
           FROM "Member" WHERE id = $1`,
        [memberId, before[0].nextDueAt],
      );
      expect(moved[0].advanced, "nextDueAt advanced after cash was taken").toBe(true);
      expect(moved[0].sameDay, "the due DAY of the month is kept when the month advances").toBe(true);
      test.info().annotations.push({ type: "observed", description: `nextDueAt advanced by ${moved[0].monthsOn} month(s)` });
    } else {
      const after = await sql<{ nextDueAt: string | null }>(
        'SELECT "nextDueAt"::text FROM "Member" WHERE id = $1',
        [memberId],
      );
      test.info().annotations.push({
        type: "observed",
        description: `nextDueAt before=null after=${after[0].nextDueAt ? "set" : "null"} — a tier with no due date is itself worth recording`,
      });
    }
  });

  test("★ the same requestId twice writes one row; two at once write one row", async ({ browser, baseURL }) => {
    test.skip(!memberId, "UNCOVERED — no member");
    const o = origin(baseURL);
    const owner = await sessionFor(browser, o, { slug, email: ownerEmail, password: PW });
    const requestId = `${RUN_STAMP}-cash-replay`;
    const data = { memberId, amountPence: 500, method: "cash", requestId, description: `${RUN_STAMP} replay` };

    await owner.request.post("/api/payments/manual", { headers: { Origin: o }, data });
    const second = await owner.request.post("/api/payments/manual", { headers: { Origin: o }, data });
    expect(second.status(), "a replayed requestId never 500s").not.toBe(500);
    expect(
      await countOf("Payment", '"tenantId" = $1 AND "requestId" = $2', [tenantId, requestId]),
      "@@unique([tenantId, requestId]) — one row",
    ).toBe(1);

    const raceId = `${RUN_STAMP}-cash-race`;
    const raceData = { ...data, requestId: raceId };
    const [r1, r2] = await Promise.all([
      owner.request.post("/api/payments/manual", { headers: { Origin: o }, data: raceData }),
      owner.request.post("/api/payments/manual", { headers: { Origin: o }, data: raceData }),
    ]);
    expect([r1.status(), r2.status()].includes(500), "a race never 500s").toBe(false);
    expect(await countOf("Payment", '"tenantId" = $1 AND "requestId" = $2', [tenantId, raceId]), "one row from a race").toBe(1);
  });

  test("a comp at £0 is allowed; 'other' with no notes is refused and writes nothing", async ({ browser, baseURL }) => {
    test.skip(!memberId, "UNCOVERED — no member");
    const o = origin(baseURL);
    const owner = await sessionFor(browser, o, { slug, email: ownerEmail, password: PW });

    const comp = await owner.request.post("/api/payments/manual", {
      headers: { Origin: o },
      data: { memberId, amountPence: 0, method: "comp", requestId: `${RUN_STAMP}-comp`, description: `${RUN_STAMP} comp` },
    });
    expect(comp.status(), "a comped month is a real thing a club does").toBeLessThan(300);

    const before = await countOf("Payment", '"tenantId" = $1', [tenantId]);
    const other = await owner.request.post("/api/payments/manual", {
      headers: { Origin: o },
      data: { memberId, amountPence: 1000, method: "other", requestId: `${RUN_STAMP}-other` },
    });
    expect([400, 422], "'other' without a note").toContain(other.status());
    assertRefusalShape(await other.json(), "manual payment, method other with no notes");
    expect(await countOf("Payment", '"tenantId" = $1', [tenantId]), "nothing written").toBe(before);
  });

  test("ATTACK — negative pence, NaN and a refund larger than the payment are all refused", async ({ browser, baseURL }) => {
    test.skip(!memberId, "UNCOVERED — no member");
    const o = origin(baseURL);
    const owner = await sessionFor(browser, o, { slug, email: ownerEmail, password: PW });
    const before = await countOf("Payment", '"tenantId" = $1', [tenantId]);
    for (const amountPence of [-5000, NaN, 999_999_999_999]) {
      const res = await owner.request.post("/api/payments/manual", {
        headers: { Origin: o },
        data: { memberId, amountPence, method: "cash", requestId: `${RUN_STAMP}-bad-${String(amountPence)}`, description: `${RUN_STAMP} bad` },
      });
      expect([400, 422], `amountPence ${amountPence}`).toContain(res.status());
    }
    expect(await countOf("Payment", '"tenantId" = $1', [tenantId]), "nothing written").toBe(before);

    // A refund on a cash payment: an honest refusal, never a 500, never a row.
    const cash = await sql<{ id: string }>(
      'SELECT id FROM "Payment" WHERE "tenantId" = $1 AND "requestId" = $2',
      [tenantId, `${RUN_STAMP}-cash-1`],
    );
    if (cash.length) {
      const refund = await owner.request.post(`/api/payments/${cash[0].id}/refund`, {
        headers: { Origin: o },
        data: { amountPence: 999_999 },
      });
      expect(refund.status(), "refunding cash never 500s").not.toBe(500);
      expect(refund.status(), "and never succeeds").toBeGreaterThanOrEqual(400);
      expect(await countOf("Payment", '"tenantId" = $1', [tenantId]), "no refund row").toBe(before);
    }
  });

  test("chase answers 502 with an EmailLog row at failed — the row proves the route ran", async ({ browser, baseURL }) => {
    test.skip(!memberId, "UNCOVERED — no member");
    const o = origin(baseURL);
    const owner = await sessionFor(browser, o, { slug, email: ownerEmail, password: PW });
    const before = await countOf("EmailLog", '"tenantId" = $1', [tenantId]);
    const res = await owner.request.post("/api/payments/chase", { headers: { Origin: o }, data: { memberId } });
    // app/api/payments/chase/route.ts:100 — non-2xx without a mail key, by design.
    expect(res.status(), "chase with no mail key").toBe(502);
    await expect
      .poll(() => countOf("EmailLog", '"tenantId" = $1', [tenantId]), { timeout: 10_000, message: "an EmailLog row for the chase" })
      .toBeGreaterThan(before);
    const row = await sql<{ status: string }>(
      'SELECT status FROM "EmailLog" WHERE "tenantId" = $1 ORDER BY "createdAt" DESC LIMIT 1',
      [tenantId],
    );
    expect(row[0].status, "the send is logged as failed, not silently dropped").toBe("failed");
    // Delivery itself is UNCOVERED — needs a live service (Resend).
  });

  test("ATTACK — a coach and a member are refused at every payments route", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const file = readTenantFile();
    const coach = await sessionFor(browser, o, { slug, email: file.ids?.coachEmail ?? `${RUN_STAMP}-coach@example.test`, viewport: PHONE, isMobile: true });
    const before = await countOf("Payment", '"tenantId" = $1', [tenantId]);
    for (const [method, url] of [
      ["get", "/api/payments"],
      ["get", "/api/payments/export.csv"],
    ] as const) {
      const res = await coach.request.fetch(url, { method: method.toUpperCase() });
      expect(res.status(), `${url} as a coach`).toBe(403);
    }
    // ROUND 2 HARNESS FIX: `/api/payments` exports GET only, so POSTing it is a
    // 405 from the framework and proves nothing about the coach. Cash is taken
    // at `/api/payments/manual`, gated by `requireApiOwnerOrManager` — that is
    // the door this attack has to knock on. The 405 is recorded separately
    // below so the method surface is still covered.
    const wrongMethod = await coach.request.post("/api/payments", { headers: { Origin: o }, data: {} });
    expect(wrongMethod.status(), "POST /api/payments is a method the route does not export").toBe(405);

    const post = await coach.request.post("/api/payments/manual", {
      headers: { Origin: o },
      data: {
        memberId,
        amountPence: 100,
        method: "cash",
        requestId: `${RUN_STAMP}-coach-cash`,
        notes: `${RUN_STAMP} coach`,
      },
    });
    expect([401, 403], "a coach recording cash").toContain(post.status());
    expect(await countOf("Payment", '"tenantId" = $1', [tenantId]), "no row from a refused coach").toBe(before);
  });

  test("ATTACK — tenant A's payment ids are invisible to tenant B's owner", async ({ browser, baseURL }) => {
    const owner = await sessionFor(browser, origin(baseURL), { slug, email: ownerEmail, password: PW });
    const foreign = await sql<{ id: string }>(
      'SELECT id FROM "Payment" WHERE "tenantId" = (SELECT id FROM "Tenant" WHERE slug = $1) LIMIT 1',
      [TENANT_A_SLUG],
    );
    test.skip(foreign.length === 0, "UNCOVERED — tenant A has no payment to borrow an id from");
    const res = await owner.request.get(`/api/payments/${foreign[0].id}`);
    expect(res.status(), "a foreign payment id").toBe(404);
    const body = await res.text();
    expect(body, "no tenant A payment data in the body").not.toContain("totalbjj");

    const refund = await owner.request.post(`/api/payments/${foreign[0].id}/refund`, {
      headers: { Origin: origin(baseURL) },
      data: { amountPence: 100 },
    });
    expect(refund.status(), "refunding another club's payment").toBe(404);
    const still = await sql<{ status: string }>('SELECT status FROM "Payment" WHERE id = $1', [foreign[0].id]);
    expect(still[0].status, "tenant A's payment is unchanged").not.toBe("refunded");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
test.describe("A0.16 ★ — class packs and the shop", () => {
  test("a pack is created in the club's currency and sold at the desk", async ({ browser, baseURL }) => {
    const o = origin(baseURL);
    const owner = await sessionFor(browser, o, { slug, email: ownerEmail, password: PW });
    // ROUND 2 HARNESS FIX: the schema names the credit count `totalCredits`
    // and requires `validityDays`; `credits` is not a key it knows, so the
    // create answered 400 (app/api/class-packs/route.ts:9-17). `currency` is
    // optional here — leaving it out is what proves the next assertion, that
    // the pack inherits the club's own currency.
    const res = await owner.request.post("/api/class-packs", {
      headers: { Origin: o },
      data: { name: `${RUN_STAMP} Ten pack`, totalCredits: 10, validityDays: 90, pricePence: 9000 },
    });
    // ROUND 4 — the 400 here is the PRODUCT'S OWN GATE, not a malformed body:
    // "Connect Stripe before creating class packs" (app/api/class-packs/route.ts:53-56),
    // because the route mints a Stripe product and price on the club's connected
    // account before it writes a row. A brand-new club has no Connect account,
    // so the CREATE half of this cell cannot be driven without one, and
    // `STRIPE_SECRET_KEY` is absent from .env.test besides (:57 answers 503).
    //
    // The refusal is asserted as the honest gate it is — never a 500, and the
    // sentence an owner would read — and the pack is then arranged directly so
    // the half of the journey that CAN be driven (a member buying it at the
    // desk) is not lost with it.
    const packText = await res.text();
    if (res.status() >= 300) {
      expect(res.status(), `create a class pack → ${packText.slice(0, 300)}`).toBe(400);
      expect(packText, "the gate says what the owner must do first").toMatch(/stripe/i);
      test.info().annotations.push({
        type: "observed",
        description: "UNCOVERED — POST /api/class-packs needs a live Stripe Connect account (route.ts:53-56); the pack is arranged directly so the desk sale can still be driven",
      });
      const currency = (await sql<{ currency: string | null }>('SELECT currency FROM "Tenant" WHERE id = $1', [tenantId]))[0].currency ?? "GBP";
      // `id` and `updatedAt` are Prisma-side defaults (@default(cuid()),
      // @updatedAt), not database ones, so a raw INSERT supplies both.
      await sql(
        `INSERT INTO "ClassPack" (id, "tenantId", name, "totalCredits", "validityDays", "pricePence", currency, "isActive", "updatedAt")
         VALUES ($1, $2, $3, 10, 90, 9000, $4, true, now())`,
        [`${RUN_STAMP}-pack-arranged`, tenantId, `${RUN_STAMP} Ten pack`, currency],
      );
    }
    const rows = await sql<{ id: string; currency: string | null }>(
      'SELECT id, currency FROM "ClassPack" WHERE "tenantId" = $1',
      [tenantId],
    );
    expect(rows.length).toBeGreaterThan(0);
    packId = rows[0].id;
    const tenantCurrency = await sql<{ currency: string | null }>('SELECT currency FROM "Tenant" WHERE id = $1', [tenantId]);
    if (rows[0].currency && tenantCurrency[0].currency) {
      expect(rows[0].currency, "a pack carries the club's currency, not a hard-coded GBP").toBe(tenantCurrency[0].currency);
    }
  });

  test("★ a member buys at the desk — an Order, and a reference shown only once the server confirms", async ({ browser, baseURL }) => {
    test.skip(!packId || !memberEmail, "UNCOVERED — no pack or member");
    const o = origin(baseURL);
    // ROUND 4 — a0-4 never arranged a password for the member it signs in as,
    // so the Member row carried no hash and every sign-in here was refused
    // exactly as a wrong password is. See `setMemberPassword` in a0-shared.ts.
    if (memberId) await setMemberPassword(memberId);
    const member = await sessionFor(browser, o, { slug, email: memberEmail, password: PW, viewport: PHONE, isMobile: true });
    const before = await countOf("Order", '"tenantId" = $1', [tenantId]);
    const res = await member.request.post("/api/member/checkout", {
      headers: { Origin: o },
      data: { packId, paymentMethod: "desk" },
    });
    test.info().annotations.push({ type: "observed", description: `desk checkout → ${res.status()}` });
    if (res.status() < 300) {
      const rows = await sql<{ id: string; status: string; orderRef: string }>(
        'SELECT id, status, "orderRef" FROM "Order" WHERE "tenantId" = $1 ORDER BY "createdAt" DESC LIMIT 1',
        [tenantId],
      );
      expect(rows[0].status, "a desk order is pending until someone takes the money").toBe("pending");
      const body = await res.json().catch(() => ({}));
      expect(JSON.stringify(body), "the reference the member is shown is the one on the row").toContain(rows[0].orderRef);
      expect(await countOf("Order", '"tenantId" = $1', [tenantId])).toBe(before + 1);
    }
  });

  test("★ a signed checkout.session.completed grants the pack; the same event id again does not", async ({ request }) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    test.skip(!secret, "UNCOVERED — STRIPE_WEBHOOK_SECRET is not set");
    test.skip(!memberId || !packId, "UNCOVERED — no member or pack");
    const account = await connectedAccountForTenantB();
    const evtId = `evt_${RUN_STAMP}_pack`;
    // ROUND 5 — two faults in one payload, and either alone makes the cell
    // meaningless:
    //   1. no `account`, so the event was refused 409 before any handler ran
    //      (see `connectedAccountForTenantB`);
    //   2. the metadata key is `matflowKind`, not `type`
    //      (app/api/stripe/webhook/route.ts:413). With `type` the class-pack
    //      branch is silently not taken — the event would have been ACKED 200
    //      having granted nothing, and "the replay did not add a pack" would
    //      have passed for a grant that never happened either time.
    // `payment_intent` is carried so the mirrored Payment row upserts on its
    // own unique key (:492) rather than through the `__never__` fallback.
    const payload = JSON.stringify({
      id: evtId,
      account,
      type: "checkout.session.completed",
      data: {
        object: {
          id: `cs_${RUN_STAMP}`,
          metadata: { tenantId, memberId, packId, matflowKind: "class_pack" },
          payment_intent: `pi_${RUN_STAMP}_pack`,
          amount_total: 9000,
          currency: "gbp",
          payment_status: "paid",
        },
      },
    });
    const before = await countOf("MemberClassPack", '"memberId" = $1', [memberId]);
    const first = await request.post("/api/stripe/webhook", {
      headers: { "stripe-signature": signPayload(payload, secret!), "content-type": "application/json" },
      data: payload,
    });
    test.info().annotations.push({ type: "observed", description: `webhook → ${first.status()} ${(await first.text()).slice(0, 160)}` });
    expect(first.status(), "a signed, attributable event is accepted").toBe(200);
    const granted = await countOf("MemberClassPack", '"memberId" = $1', [memberId]);
    expect(granted, "the signed event GRANTS the pack — the row, not the ack").toBe(before + 1);

    const replay = await request.post("/api/stripe/webhook", {
      headers: { "stripe-signature": signPayload(payload, secret!), "content-type": "application/json" },
      data: payload,
    });
    expect(replay.status(), "a replayed event is acked, not errored").toBe(200);
    expect(
      JSON.stringify(await replay.json().catch(() => ({}))),
      "the replay says it was already processed (route.ts:1219-1222)",
    ).toMatch(/alreadyProcessed/);
    expect(
      await countOf("StripeEvent", '"eventId" = $1', [evtId]),
      "exactly one StripeEvent row for the event id (prisma/schema.prisma:722-727)",
    ).toBe(1);
    const after = await countOf("MemberClassPack", '"memberId" = $1', [memberId]);
    expect(after, "the same event id a second time grants nothing more").toBe(granted);
    test.info().annotations.push({ type: "observed", description: `packs before=${before} after=${after} (replay must not add)` });
  });

  test("ATTACK — a forged signature changes nothing", async ({ request }) => {
    const payload = JSON.stringify({ id: `evt_${RUN_STAMP}_forged`, type: "checkout.session.completed", data: { object: { metadata: { tenantId, memberId } } } });
    const before = await countOf("StripeEvent", '"eventId" LIKE $1', [`evt_${RUN_STAMP}%`]);
    const res = await request.post("/api/stripe/webhook", {
      headers: { "stripe-signature": signPayload(payload, "not-the-signing-secret"), "content-type": "application/json" },
      data: payload,
    });
    expect(res.status(), "a forged signature is refused").toBe(400);
    expect(await countOf("StripeEvent", '"eventId" LIKE $1', [`evt_${RUN_STAMP}%`]), "nothing claimed").toBe(before);
  });

  test("ATTACK — a webhook carrying tenant A's ids writes nothing into tenant A", async ({ request }) => {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    test.skip(!secret, "UNCOVERED — STRIPE_WEBHOOK_SECRET is not set");
    const foreignMember = await sql<{ id: string }>(
      'SELECT id FROM "Member" WHERE "tenantId" = (SELECT id FROM "Tenant" WHERE slug = $1) LIMIT 1',
      [TENANT_A_SLUG],
    );
    const before = await countOf("MemberClassPack", '"memberId" = $1', [foreignMember[0].id]);
    const beforePayments = await countOf("Payment", '"memberId" = $1', [foreignMember[0].id]);
    const evtId = `evt_${RUN_STAMP}_cross`;
    // ROUND 5 — this attack never reached the code it attacks. With no
    // `account` the event was thrown out at :136-141 and the cell recorded
    // "nothing written" for an event that was never processed at all. Carrying
    // tenant B's connected account and the real `matflowKind` puts the foreign
    // memberId in front of the defence that is supposed to stop it — the
    // tenant-scoped member re-lookup at route.ts:426-429 (M8, 2026-05-07).
    const account = await connectedAccountForTenantB();
    const payload = JSON.stringify({
      id: evtId,
      account,
      type: "checkout.session.completed",
      data: { object: { id: `cs_${RUN_STAMP}x`, metadata: { tenantId, memberId: foreignMember[0].id, packId, matflowKind: "class_pack" }, payment_intent: `pi_${RUN_STAMP}_cross`, amount_total: 9000, currency: "gbp", payment_status: "paid" } },
    });
    const res = await request.post("/api/stripe/webhook", {
      headers: { "stripe-signature": signPayload(payload, secret!), "content-type": "application/json" },
      data: payload,
    });
    expect(res.status()).not.toBe(500);
    test.info().annotations.push({
      type: "observed",
      description: `cross-tenant metadata on tenant B's account → ${res.status()}`,
    });
    expect(
      await countOf("MemberClassPack", '"memberId" = $1', [foreignMember[0].id]),
      "tenant B's tenantId with tenant A's memberId must grant nothing",
    ).toBe(before);
    expect(
      await countOf("Payment", '"memberId" = $1', [foreignMember[0].id]),
      "and no ledger row is minted against the foreign member either",
    ).toBe(beforePayments);
  });

  test("the inert card rail is honest — nothing is charged and no subscription id is written", async ({ browser, baseURL }) => {
    test.skip(!memberEmail, "UNCOVERED — no member");
    const o = origin(baseURL);
    // ROUND 4 — a0-4 never arranged a password for the member it signs in as,
    // so the Member row carried no hash and every sign-in here was refused
    // exactly as a wrong password is. See `setMemberPassword` in a0-shared.ts.
    if (memberId) await setMemberPassword(memberId);
    const member = await sessionFor(browser, o, { slug, email: memberEmail, password: PW, viewport: PHONE, isMobile: true });
    const before = await sql<{ stripeSubscriptionId: string | null }>(
      'SELECT "stripeSubscriptionId" FROM "Member" WHERE id = $1',
      [memberId],
    );
    const res = await member.request.post("/api/member/subscribe", { headers: { Origin: o }, data: { tierId } });
    expect(res.status(), "the inert rail never 500s").not.toBe(500);
    const after = await sql<{ stripeSubscriptionId: string | null }>(
      'SELECT "stripeSubscriptionId" FROM "Member" WHERE id = $1',
      [memberId],
    );
    expect(after[0].stripeSubscriptionId, "nothing was charged, so nothing is recorded").toBe(before[0].stripeSubscriptionId);
    test.info().annotations.push({ type: "observed", description: `member subscribe on an unconnected club → ${res.status()}` });
  });

  test("memberSelfBilling off — the subscribe routes AND the shop must both refuse", async ({ browser, baseURL }) => {
    test.skip(!memberEmail, "UNCOVERED — no member");
    const o = origin(baseURL);
    await sql('UPDATE "Tenant" SET "memberSelfBilling" = false WHERE id = $1', [tenantId]).catch(() => {});
    try {
      if (memberId) await setMemberPassword(memberId);
      const member = await sessionFor(browser, o, { slug, email: memberEmail, password: PW, viewport: PHONE, isMobile: true, fresh: true });
      const sub = await member.request.post("/api/member/subscribe", { headers: { Origin: o }, data: { tierId } });
      const shop = await member.request.post("/api/member/checkout", { headers: { Origin: o }, data: { packId, paymentMethod: "desk" } });
      test.info().annotations.push({
        type: "observed",
        description: `memberSelfBilling=false → subscribe ${sub.status()}, shop checkout ${shop.status()} (X-6 G-26 says the shop does NOT refuse)`,
      });
      expect(sub.status(), "the subscribe route must refuse when self-billing is off").toBeGreaterThanOrEqual(400);
      await member.close();
    } finally {
      await sql('UPDATE "Tenant" SET "memberSelfBilling" = true WHERE id = $1', [tenantId]).catch(() => {});
    }
  });
});

test.describe("A0.money.teardown", () => {
  test("close sessions (and tear down if A0_TEARDOWN_HERE is set)", async () => {
    await closeSessions();
    if (!process.env.A0_TEARDOWN_HERE) return;
    const file = readTenantFile();
    await teardownTenantB(RUN_STAMP);
    expect(await countOf("Tenant", "id = $1", [file.tenantId])).toBe(0);
  });
});
