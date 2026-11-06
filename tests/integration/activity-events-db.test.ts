// The new activity events against Postgres (run as the owner role and as
// matflow_app by .claude/skills/matflow-verify-local/scripts/db-tests.mjs).
//
// What only the database can prove:
//  - each event is written once: a repeated booking, a retried membership
//    start, two membership starts at the same moment, a replayed Stripe event
//    and the completed + async-succeeded pair leave exactly one row;
//  - the purchase rows are written inside the webhook's own transaction, as
//    the restricted role, under row-level security: a failure after the row
//    takes the row and the purchase back together, and the retry writes one;
//  - the rows are filed under the member, which is how the member's History
//    and their subject-access export both read the log;
//  - the timeline finds them by plan (a cancellation included), by class
//    (check-ins included) and by member, for the owner and for a manager, and
//    nothing is written about an erased member.
//
// Stripe events are signed locally with a synthetic secret (no network). Email,
// Sentry and the account-status refresh are stubbed; the audit log is REAL.
// Synthetic club only (slug mfv-evt-…), created here and torn down to nothing.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/rate-limit", async (original) => ({ ...(await original<typeof import("@/lib/rate-limit")>()), checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/stripe-account-status", () => ({ refreshStripeAccountStatus: vi.fn(async () => {}) }));
// The real writer, with one switch: fail once AFTER the row has been written, to prove the row and the purchase
// share a transaction. (logMembershipStarted calls the real function directly and is not affected.)
const fail = vi.hoisted(() => ({ afterNextWrite: false }));
vi.mock("@/lib/activity-events", async (original) => {
  const real = await original<typeof import("@/lib/activity-events")>();
  const logActivityEvent: typeof real.logActivityEvent = async (action, metadata, base) => {
    const wrote = await real.logActivityEvent(action, metadata, base);
    if (wrote && fail.afterNextWrite) {
      fail.afterNextWrite = false;
      throw new Error("synthetic failure after the activity row was written");
    }
    return wrote;
  };
  return { ...real, logActivityEvent };
});

import Stripe from "stripe";
import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { GET as activityGET } from "@/app/api/activity/route";
import { POST as bookingPOST, DELETE as bookingDELETE } from "@/app/api/member/class-subscriptions/[classId]/route";
import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";
import { POST as checkinPOST } from "@/app/api/checkin/route";
import { PATCH as memberPATCH } from "@/app/api/members/[id]/route";
import { logActivityEvent, logMembershipStarted } from "@/lib/activity-events";
import type { ActivityResponse } from "@/lib/activity-types";

const STAMP = randomUUID().slice(0, 8);
const id = (name: string) => `mfv${STAMP}${name}`;
const SECRET = "whsec_activity_events_synthetic_local_only";
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!process.env.TEST_DATABASE_URL)("Activity events — written once, found by the timeline", () => {
  const T = id("club");
  const OWNER = id("owner");
  const MANAGER = id("manager");
  const mel = id("mel");
  const erased = id("erased");
  const cls = id("class");
  const tier = id("tier");
  const pack = id("pack");
  const order = id("order");
  const ORDER_REF = `ORD-${STAMP.toUpperCase()}`;
  const PRICE = `price_${STAMP}`;
  const account = `acct_evt_${STAMP}`;
  let seq = 0;

  const asMember = (memberId: string) => vi.mocked(auth).mockResolvedValue({ user: { id: memberId, role: "member", tenantId: T, memberId } } as never);
  const asStaff = (role: "owner" | "manager") => vi.mocked(auth).mockResolvedValue({ user: { id: role === "owner" ? OWNER : MANAGER, role, tenantId: T } } as never);
  const rowsOf = (action: string) => withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId: T, action }, orderBy: { createdAt: "asc" } }));
  const meta = (row: { metadata: unknown }) => row.metadata as Record<string, unknown>;

  async function feed(query: string): Promise<ActivityResponse> {
    const res = await activityGET(new Request(`https://test.local/api/activity${query}`));
    expect(res.status, query).toBe(200);
    return (await res.json()) as ActivityResponse;
  }

  /** `eventId`: pass the same one twice to deliver the same event again, as Stripe's retry does. */
  async function deliver(type: string, object: Record<string, unknown>, eventId = `evt_evt_${STAMP}_${++seq}`) {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-03-25.dahlia" as never });
    const payload = JSON.stringify({ id: eventId, object: "event", type, account, livemode: false, created: Math.floor(Date.now() / 1000), data: { object } });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp: Math.floor(Date.now() / 1000) } as Parameters<typeof stripe.webhooks.generateTestHeaderString>[0]);
    const res = (await stripeWebhook(new Request("http://localhost/api/stripe/webhook", { method: "POST", headers: new Headers({ "content-type": "application/json", "stripe-signature": signature }), body: payload }) as never)) as unknown as { status: number };
    return res.status;
  }
  const packSession = (name: string, memberId: string, paymentStatus: "paid" | "unpaid" = "paid") => ({
    id: `cs_evt_${STAMP}_${name}`,
    object: "checkout.session",
    mode: "payment",
    payment_status: paymentStatus,
    payment_intent: `pi_evt_${STAMP}_${name}`,
    amount_total: 8000,
    currency: "gbp",
    metadata: { matflowKind: "class_pack", tenantId: T, memberId, packId: pack },
  });

  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_activity_events_synthetic_never_used";
    await withRlsBypass(async (tx) => {
      await tx.tenant.create({ data: { id: T, name: `Events ${STAMP}`, slug: `mfv-evt-${STAMP}`, stripeAccountId: account } });
      await tx.user.createMany({
        data: [
          { id: OWNER, tenantId: T, email: `owner-${STAMP}@example.test`, passwordHash: "x", name: "Olive Owner", role: "owner" },
          { id: MANAGER, tenantId: T, email: `manager-${STAMP}@example.test`, passwordHash: "x", name: "Mo Manager", role: "manager" },
        ],
      });
      await tx.membershipTier.create({ data: { id: tier, tenantId: T, name: "Adult Unlimited", stripePriceId: PRICE } });
      await tx.member.createMany({
        data: [
          { id: mel, tenantId: T, name: "Melody Orekoya", email: `mel-${STAMP}@example.test`, membershipTierId: tier },
          { id: erased, tenantId: T, name: "Deleted member", email: `deleted-${erased}@deleted.invalid` },
        ],
      });
      await tx.class.create({ data: { id: cls, tenantId: T, name: "Advanced No-Gi" } });
      await tx.classPack.create({ data: { id: pack, tenantId: T, name: "Ten classes", totalCredits: 10, validityDays: 90, pricePence: 8000 } });
      await tx.order.create({ data: { id: order, tenantId: T, memberId: mel, orderRef: ORDER_REF, items: [], totalPence: 2500, paymentMethod: "stripe" } });
    });
  });

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.auditLog.deleteMany({ where: { tenantId: T } });
      await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_evt_${STAMP}` } } });
      await tx.payment.deleteMany({ where: { tenantId: T } });
      await tx.memberClassPack.deleteMany({ where: { tenantId: T } });
      await tx.classPack.deleteMany({ where: { tenantId: T } });
      await tx.order.deleteMany({ where: { tenantId: T } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId: T } });
      await tx.classInstance.deleteMany({ where: { classId: cls } });
      await tx.classSubscription.deleteMany({ where: { classId: cls } });
      await tx.class.deleteMany({ where: { tenantId: T } });
      await tx.member.deleteMany({ where: { tenantId: T } });
      await tx.membershipTier.deleteMany({ where: { tenantId: T } });
      await tx.user.deleteMany({ where: { tenantId: T } });
      await tx.tenant.deleteMany({ where: { id: T } });
    });
    const left = await withRlsBypass((tx) => Promise.all([tx.tenant.count({ where: { id: T } }), tx.auditLog.count({ where: { tenantId: T } }), tx.member.count({ where: { tenantId: T } })]));
    expect(left).toEqual([0, 0, 0]);
  });

  it("a booking is recorded when it is made and when it is given up — and not when either is repeated", async () => {
    asMember(mel);
    const book = () => bookingPOST(new Request("http://test", { method: "POST" }), { params: Promise.resolve({ classId: cls }) });
    const unbook = () => bookingDELETE(new Request("http://test", { method: "DELETE" }), { params: Promise.resolve({ classId: cls }) });
    expect((await book())!.status).toBe(201);
    expect((await book())!.status).toBe(201); // already booked: the idempotent answer, no second row
    const made = await rowsOf("class.booking.created");
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ entityType: "Member", entityId: mel, userId: null });
    expect(meta(made[0])).toMatchObject({ memberId: mel, classId: cls, actorId: mel });
    expect((await unbook())!.status).toBe(200);
    expect((await unbook())!.status).toBe(200);
    expect(await rowsOf("class.booking.cancelled")).toHaveLength(1);
    // Another club's class (an id that is not a class here) books nothing and records nothing.
    expect((await bookingPOST(new Request("http://test", { method: "POST" }), { params: Promise.resolve({ classId: id("nosuchclass") }) }))!.status).toBe(404);
    expect(await rowsOf("class.booking.created")).toHaveLength(1);
  });

  it("a membership start is one row per Stripe subscription, however many times the request is retried", async () => {
    const start = (sub: string, price = PRICE) => logMembershipStarted({ tenantId: T, memberId: mel, stripePriceId: price, stripeSubscriptionId: sub, userId: mel, memberEmail: `mel-${STAMP}@example.test` });
    expect(await start(`sub_${STAMP}a`)).toBe(true);
    expect(await start(`sub_${STAMP}a`)).toBe(false);
    expect(await start(`sub_${STAMP}b`, "price_unmapped")).toBe(true);
    const rows = await rowsOf("member.subscription.purchased");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ entityType: "Member", entityId: mel, userId: null, requestId: `sub-purchased:sub_${STAMP}a` });
    // The plan is found from the price; a price that maps to no plan is still a start. No amount on either.
    expect(meta(rows[0])).toMatchObject({ memberId: mel, tierId: tier, stripeSubscriptionId: `sub_${STAMP}a`, actorId: mel });
    expect(meta(rows[1])).toMatchObject({ tierId: null });
    expect(JSON.stringify(rows.map(meta))).not.toMatch(/amount|pence/i);
    // A staff member starting it is the row's user.
    expect(await logMembershipStarted({ tenantId: T, memberId: mel, stripePriceId: PRICE, stripeSubscriptionId: `sub_${STAMP}c`, userId: OWNER })).toBe(true);
    expect((await rowsOf("member.subscription.purchased"))[2]).toMatchObject({ userId: OWNER });
  });

  it("a class pack purchase is one row, in the webhook's transaction: a replay and the async twin add none", async () => {
    expect(await deliver("checkout.session.completed", packSession("a", mel, "unpaid"))).toBe(200);
    expect(await rowsOf("class_pack.purchased")).toHaveLength(0); // nothing paid, nothing minted, nothing said
    expect(await deliver("checkout.session.async_payment_succeeded", packSession("a", mel))).toBe(200);
    expect(await deliver("checkout.session.async_payment_succeeded", packSession("a", mel))).toBe(200);
    expect(await deliver("checkout.session.completed", packSession("a", mel))).toBe(200);
    const rows = await rowsOf("class_pack.purchased");
    expect(rows).toHaveLength(1);
    const minted = await withRlsBypass((tx) => tx.memberClassPack.findMany({ where: { tenantId: T, memberId: mel } }));
    expect(minted).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "Member", entityId: mel, userId: null });
    // (A row written inside a transaction also carries the audit writer's own bookkeeping: actor, outcome, request id.)
    expect(meta(rows[0])).toMatchObject({ memberId: mel, classPackId: pack, memberClassPackId: minted[0].id, credits: 10, amountPence: 8000, currency: "GBP", actorType: "system", outcome: "succeeded" });
    expect(Object.keys(meta(rows[0])).sort()).toEqual(["actor", "actorType", "amountPence", "classPackId", "credits", "currency", "memberClassPackId", "memberId", "outcome", "requestId"]);
  });

  it("nothing is written about an erased member, though the purchase itself is honoured", async () => {
    expect(await deliver("checkout.session.completed", packSession("erased", erased))).toBe(200);
    expect(await withRlsBypass((tx) => tx.memberClassPack.count({ where: { tenantId: T, memberId: erased } }))).toBe(1);
    expect(await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: T, entityId: erased } }))).toBe(0);
    expect(await logActivityEvent("class.booking.created", { memberId: erased, classId: cls }, { tenantId: T, durable: true, memberEmail: `deleted-${erased}@deleted.invalid` })).toBe(false);
    expect(await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: T, entityId: erased } }))).toBe(0);
  });

  it("a shop order paid through Stripe is one row, written by the event that settled it", async () => {
    const session = { id: `cs_evt_${STAMP}_order`, object: "checkout.session", mode: "payment", payment_status: "paid", payment_intent: `pi_evt_${STAMP}_order`, amount_total: 2500, currency: "gbp", metadata: { matflowKind: "shop_order", tenantId: T, orderRef: ORDER_REF } };
    expect(await deliver("checkout.session.completed", session)).toBe(200);
    expect(await deliver("checkout.session.completed", session)).toBe(200);
    const rows = await rowsOf("order.paid");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ entityType: "Member", entityId: mel, userId: null });
    expect(meta(rows[0])).toMatchObject({ memberId: mel, orderId: order, orderRef: ORDER_REF, amountPence: 2500, currency: "GBP" });
    expect(Object.keys(meta(rows[0])).sort()).toEqual(["actor", "actorType", "amountPence", "currency", "memberId", "orderId", "orderRef", "outcome", "requestId"]);
    expect((await withRlsBypass((tx) => tx.order.findFirst({ where: { id: order } })))?.status).toBe("paid");
  });

  // The member's History and the subject-access export (app/api/admin/dsar/export) both read the log with this
  // where clause. The export route itself is not called here: it needs an operator session.
  it("every one of them is filed under the member: found by entity, as their History and their export read the log", async () => {
    const mine = await withRlsBypass((tx) => tx.auditLog.findMany({ where: { tenantId: T, entityType: "Member", entityId: mel }, select: { action: true } }));
    const actions = new Set(mine.map((r) => r.action));
    for (const action of ["class.booking.created", "class.booking.cancelled", "member.subscription.purchased", "class_pack.purchased", "order.paid"]) expect(actions, action).toContain(action);
  });

  it("the timeline tells them as sentences, to the owner and to a manager alike", async () => {
    for (const role of ["owner", "manager"] as const) {
      asStaff(role);
      const page = await feed("?types=all&take=50");
      const said = page.entries.map((e) => `${e.type}: ${e.plain}${e.detailPlain ? ` · ${e.detailPlain}` : ""}`);
      expect(said, role).toContain("booking: Melody Orekoya booked Advanced No-Gi");
      expect(said, role).toContain("booking: Melody Orekoya cancelled their booking for Advanced No-Gi");
      expect(said, role).toContain("membership_started: Melody Orekoya started Adult Unlimited — awaiting first payment");
      expect(said, role).toContain("membership_started: Melody Orekoya started a membership — awaiting first payment");
      expect(said, role).toContain("membership_started: Olive Owner started Adult Unlimited for Melody Orekoya — awaiting first payment");
      expect(said, role).toContain("pack_purchased: Melody Orekoya bought the Ten classes · 10 classes · £80.00");
      expect(said, role).toContain(`payment: Melody Orekoya paid £25.00 for shop order ${ORDER_REF}`);
      // None of it can be undone from here, and a manager is offered no undo at all.
      for (const e of page.entries) {
        if (role === "manager") expect("undo" in e, e.plain).toBe(false);
        else expect(e.undo?.ok, e.plain).toBe(false);
      }
      // Provider ids and internal ids stay out of what is sent.
      expect(JSON.stringify(page)).not.toMatch(new RegExp(`sub_${STAMP}|pi_evt_|${account}`));
    }
  });

  it("the timeline finds them by plan, by class, by member and in the views they belong to", async () => {
    asStaff("owner");
    const plain = async (query: string) => (await feed(query)).entries.map((e) => e.plain);
    // "What happened to this plan": the two starts on it, not the start on an unmapped price.
    const byPlan = await plain(`?types=all&tierId=${tier}`);
    expect(byPlan.filter((p) => p.includes("started Adult Unlimited"))).toHaveLength(2);
    expect(byPlan.some((p) => p.includes("started a membership"))).toBe(false);
    // One class's history: its bookings.
    const byClass = await plain(`?types=all&classId=${cls}`);
    expect(byClass).toEqual(expect.arrayContaining(["Melody Orekoya booked Advanced No-Gi", "Melody Orekoya cancelled their booking for Advanced No-Gi"]));
    expect(byClass.some((p) => p.includes("bought"))).toBe(false);
    // One member's history: all seven rows about her.
    expect(await plain(`?types=all&memberId=${mel}`)).toHaveLength(7);
    // Attendance has the bookings; Money has the starts, the pack and the order; neither has the other's.
    const attendance = await plain("?types=attendance");
    expect(attendance.every((p) => /booked|booking/.test(p))).toBe(true);
    expect(attendance).toHaveLength(2);
    const money = await plain("?types=money");
    expect(money).toHaveLength(5);
    expect(money.some((p) => /booked|booking/.test(p))).toBe(false);
  });

  // ── Added after review. These write further rows, so they come after the counts above. ──────────────────────────

  it("membership starts arriving at the same moment for one subscription write one row between them", async () => {
    for (const n of [1, 2, 3, 4]) {
      const sub = `sub_${STAMP}race${n}`;
      const start = () => logMembershipStarted({ tenantId: T, memberId: mel, tierId: tier, stripePriceId: PRICE, stripeSubscriptionId: sub, userId: mel, memberEmail: `mel-${STAMP}@example.test` });
      const wrote = await Promise.all([start(), start(), start()]);
      expect(wrote.filter(Boolean), sub).toHaveLength(1);
      expect(await withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: T, requestId: `sub-purchased:${sub}` } })), sub).toBe(1);
    }
    // The plan the caller resolved is the plan on the row, whatever the price would have found.
    const resolved = `sub_${STAMP}resolved`;
    expect(await logMembershipStarted({ tenantId: T, memberId: mel, tierId: tier, stripePriceId: "price_unmapped", stripeSubscriptionId: resolved, userId: mel })).toBe(true);
    const row = await withRlsBypass((tx) => tx.auditLog.findFirst({ where: { tenantId: T, requestId: `sub-purchased:${resolved}` } }));
    expect(meta(row!)).toMatchObject({ tierId: tier });
  });

  it("two plans on one price: the one on sale is the one that was started, not the archived one", async () => {
    const SHARED = `price_${STAMP}shared`;
    const archived = id("tierold");
    const onSale = id("tiernew");
    await withRlsBypass(async (tx) => {
      // The archived plan is edited last, so "newest" alone would pick it.
      await tx.membershipTier.create({ data: { id: onSale, tenantId: T, name: "Twice a week", stripePriceId: SHARED } });
      await tx.membershipTier.create({ data: { id: archived, tenantId: T, name: "Twice a week (OLD)", stripePriceId: SHARED, isActive: false } });
    });
    const sub = `sub_${STAMP}shared`;
    expect(await logMembershipStarted({ tenantId: T, memberId: mel, stripePriceId: SHARED, stripeSubscriptionId: sub, userId: OWNER })).toBe(true);
    const row = await withRlsBypass((tx) => tx.auditLog.findFirst({ where: { tenantId: T, requestId: `sub-purchased:${sub}` } }));
    expect(meta(row!)).toMatchObject({ tierId: onSale });
  });

  it("a failure after the pack's row is written takes the row and the credits back together; Stripe's retry then writes one of each", async () => {
    const count = () =>
      withRlsBypass(async (tx) => ({
        rows: await tx.auditLog.count({ where: { tenantId: T, action: "class_pack.purchased" } }),
        packs: await tx.memberClassPack.count({ where: { tenantId: T, memberId: mel } }),
      }));
    const before = await count();
    const eventId = `evt_evt_${STAMP}_rollback_pack`;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    fail.afterNextWrite = true;
    expect(await deliver("checkout.session.completed", packSession("rollback", mel), eventId)).toBe(500);
    quiet.mockRestore();
    // The switch was used: the row really was written inside the transaction before the failure.
    expect(fail.afterNextWrite).toBe(false);
    expect(await count()).toEqual(before);
    expect(await deliver("checkout.session.completed", packSession("rollback", mel), eventId)).toBe(200);
    expect(await count()).toEqual({ rows: before.rows + 1, packs: before.packs + 1 });
    expect(await deliver("checkout.session.completed", packSession("rollback", mel), eventId)).toBe(200);
    expect(await count()).toEqual({ rows: before.rows + 1, packs: before.packs + 1 });
  });

  it("the same for a shop order: no row without the order paid, no paid order without the row", async () => {
    const order2 = id("order2");
    const REF2 = `ORD-${STAMP.toUpperCase()}B`;
    await withRlsBypass((tx) => tx.order.create({ data: { id: order2, tenantId: T, memberId: mel, orderRef: REF2, items: [], totalPence: 1200, paymentMethod: "stripe" } }));
    const state = () =>
      withRlsBypass(async (tx) => ({
        rows: await tx.auditLog.count({ where: { tenantId: T, action: "order.paid", metadata: { path: ["orderId"], equals: order2 } } }),
        status: (await tx.order.findFirst({ where: { id: order2 } }))?.status,
      }));
    const before = await state();
    expect(before.rows).toBe(0);
    expect(before.status).not.toBe("paid");
    const session = { id: `cs_evt_${STAMP}_order2`, object: "checkout.session", mode: "payment", payment_status: "paid", payment_intent: `pi_evt_${STAMP}_order2`, amount_total: 1200, currency: "gbp", metadata: { matflowKind: "shop_order", tenantId: T, orderRef: REF2 } };
    const eventId = `evt_evt_${STAMP}_rollback_order`;
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {});
    fail.afterNextWrite = true;
    expect(await deliver("checkout.session.completed", session, eventId)).toBe(500);
    quiet.mockRestore();
    expect(fail.afterNextWrite).toBe(false);
    expect(await state()).toEqual(before);
    expect(await deliver("checkout.session.completed", session, eventId)).toBe(200);
    expect(await state()).toEqual({ rows: 1, status: "paid" });
  });

  it("a class's history has its check-ins as well as its bookings: a check-in written now names its class", async () => {
    const guest = id("checkedin");
    const instance = id("session");
    const now = new Date();
    const hhmm = (d: Date) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
    await withRlsBypass(async (tx) => {
      await tx.member.create({ data: { id: guest, tenantId: T, name: "Casey Checkin", email: `casey-${STAMP}@example.test`, waiverAccepted: true, paymentStatus: "paid", membershipTierId: tier } });
      await tx.classInstance.create({
        data: { id: instance, classId: cls, date: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())), startTime: hhmm(now), endTime: hhmm(new Date(now.getTime() + 60 * 60_000)) },
      });
    });
    asStaff("owner");
    const res = await checkinPOST(new Request("https://test.local/api/checkin", { method: "POST", body: JSON.stringify({ classInstanceId: instance, memberId: guest }) }));
    expect([200, 201], JSON.stringify(await res.clone().json())).toContain(res.status);
    const written = await rowsOf("attendance.mark");
    expect(written).toHaveLength(1);
    expect(meta(written[0])).toMatchObject({ memberId: guest, classId: cls, classInstanceId: instance });
    const byClass = (await feed(`?types=all&classId=${cls}`)).entries;
    const checkin = byClass.find((e) => e.type === "checkin");
    expect(checkin?.plain.startsWith("Olive Owner checked Casey Checkin in to Advanced No-Gi")).toBe(true);
    // Its bookings are still there beside it, and another class's filter finds none of this.
    expect(byClass.map((e) => e.plain)).toEqual(expect.arrayContaining(["Melody Orekoya booked Advanced No-Gi"]));
    expect((await feed(`?types=all&classId=${id("nosuchclass")}`)).entries).toEqual([]);
  });

  it("what happened to a plan includes who left it: cancelled on one plan, then moved to another", async () => {
    const pat = id("pat");
    const other = id("tierother");
    await withRlsBypass(async (tx) => {
      await tx.membershipTier.create({ data: { id: other, tenantId: T, name: "Mornings only" } });
      await tx.member.create({ data: { id: pat, tenantId: T, name: "Pat Planmover", email: `pat-${STAMP}@example.test`, membershipTierId: tier } });
    });
    asStaff("owner");
    const patch = (body: object) =>
      memberPATCH(new Request(`http://localhost/api/members/${pat}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: pat }) });
    const cancelled = await patch({ status: "cancelled" });
    expect(cancelled.status, JSON.stringify(await cancelled.clone().json())).toBe(200);
    const moved = await patch({ status: "active", membershipTierId: other });
    expect(moved.status, JSON.stringify(await moved.clone().json())).toBe(200);
    // The cancellation row names the plan she held when she was cancelled.
    const row = (await rowsOf("member.update")).find((r) => r.entityId === pat && (meta(r).changes as { status?: { to?: string } } | undefined)?.status?.to === "cancelled");
    expect(meta(row!)).toMatchObject({ tierId: tier });
    const plain = async (query: string) => (await feed(query)).entries.map((e) => e.plain);
    const onFirst = await plain(`?types=all&tierId=${tier}`);
    expect(onFirst).toContain("Olive Owner cancelled Pat Planmover's Adult Unlimited membership");
    expect(onFirst).toContain("Olive Owner moved Pat Planmover from Adult Unlimited to Mornings only");
    // The plan she moved to has the move, and not the cancellation that happened on the other plan.
    const onSecond = await plain(`?types=all&tierId=${other}`);
    expect(onSecond).toEqual(["Olive Owner moved Pat Planmover from Adult Unlimited to Mornings only"]);
  });
});
