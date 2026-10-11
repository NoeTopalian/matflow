// Payments lane PD (11 Oct 2026) — the operator routes for Stripe sync against
// a REAL database (Neon TEST branch, both guarded runners).
//
// Real: GET /api/admin/stripe/events and POST /api/admin/stripe/events/[id]/
// replay, the operator MFA-session resolver (signed cookie + Operator row), the
// step-up grant (issueStepUpGrant → requireStepUp → consumeStepUpGrant inside
// the route's transaction, bound to the event's status and the force flag),
// the audit writer, the event store and the replay module. Stubbed: the cookie
// jar, rate limits, email, the NextAuth session (to drive the support-session
// refusal), the Stripe SDK (events.retrieve serves the event fresh), and the
// webhook's processor (lane PC has not exposed it yet — a stand-in that writes
// a real Payment row through the upsert the real handler uses; the REAL
// webhook processor is driven end to end in pay-pd-replay-e2e-db.test.ts).
//
// Pinned: no operator → 403 and nothing read; a support session → 403; the
// overview lists the failed event with no personal data; replay without a
// grant → 403 with nothing written; with a grant → processed once, requested +
// replayed audit rows carrying the grant's request id; the same grant again →
// the recorded outcome echoed, nothing re-run; a settled event without force →
// 409 before any grant is needed; a grant for an ordinary replay cannot be
// spent on a forced one; a forced replay creates no second Payment and no
// second handler audit.

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";

const h = vi.hoisted(() => {
  process.env.AUTH_SECRET ??= "pay-pd-admin-replay-db-test-secret-0123456789abcdef";
  return {
    jar: new Map<string, string>(),
    session: null as unknown,
    retrieved: [] as Array<{ id: string; acct: string }>,
    fresh: null as null | ((id: string) => unknown),
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
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true, logId: "mail-test" })) }));
vi.mock("@/auth", () => ({ auth: async () => h.session }));
vi.mock("stripe", () => ({
  default: class {
    events = {
      retrieve: async (id: string, _p: unknown, o: { stripeAccount: string }) => {
        h.retrieved.push({ id, acct: o.stripeAccount });
        return h.fresh!(id);
      },
    };
  },
}));
vi.mock("@/lib/stripe/replay", async (orig) => {
  const real = await orig<typeof import("@/lib/stripe/replay")>();
  return { ...real, loadWebhookPrepare: async () => standInPrepare };
});

import { prisma } from "@/lib/prisma";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { issueOperatorSession, OP_SESSION_COOKIE } from "@/lib/operator-auth";
import { STEP_UP_HEADER, issueStepUpGrant, stepUpTarget } from "@/lib/operator-step-up";
import { runStripeEvent, type StripeEventProcessor } from "@/lib/stripe/event-store";
import type { FreshStripeEvent } from "@/lib/stripe/replay";
import { GET as overviewRoute } from "@/app/api/admin/stripe/events/route";
import { POST as replayRoute } from "@/app/api/admin/stripe/events/[id]/replay/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `paypdad-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const S = STAMP.replace(/-/g, "");
const OP_ID = `${STAMP}-op`;
const TENANT = `${STAMP}-t`;
const ACCT = `acct_${S}`;
const MEMBER = `${STAMP}-m`;
const MEMBER_EMAIL = `${STAMP}-member@example.test`;
const EVENT = `evt_${S}_failed`;
const INVOICE = `in_${S}`;
const ORIGIN = "http://localhost:3847";

const freshEvent = (id: string): FreshStripeEvent => ({
  id,
  type: "invoice.payment_succeeded",
  livemode: false,
  created: Math.floor(Date.now() / 1000) - 60,
  data: { object: { id: INVOICE, object: "invoice", amount_paid: 4500, currency: "gbp" } },
});

const standInProcessor: StripeEventProcessor<FreshStripeEvent> = async (event, { tx }) => {
  await tx.payment.upsert({
    where: { stripeInvoiceId: event.data.object.id as string },
    create: { tenantId: TENANT, memberId: MEMBER, stripeInvoiceId: event.data.object.id as string, amountPence: 4500, currency: "GBP", status: "succeeded", paidAt: new Date() },
    update: { status: "succeeded" },
  });
  return {
    outcome: "processed",
    tenantId: TENANT,
    audits: [{ tenantId: TENANT, userId: null, action: "member.payment.succeeded", entityType: "Member", entityId: MEMBER, metadata: { stripeEventId: event.id } }],
  };
};
async function standInPrepare() {
  return standInProcessor;
}

const payments = () => withRlsBypass((tx) => tx.payment.count({ where: { tenantId: TENANT, stripeInvoiceId: INVOICE } }));
const auditCount = (action: string) => withRlsBypass((tx) => tx.auditLog.count({ where: { tenantId: TENANT, action } }));
const status = async () => (await withRlsBypass((tx) => tx.stripeEvent.findUnique({ where: { eventId: EVENT }, select: { status: true } })))?.status;

function replayReq(body: unknown, grant?: string) {
  return new Request(`${ORIGIN}/api/admin/stripe/events/${EVENT}/replay`, {
    method: "POST",
    headers: { origin: ORIGIN, host: "localhost:3847", "content-type": "application/json", ...(grant ? { [STEP_UP_HEADER]: grant } : {}) },
    body: JSON.stringify(body),
  });
}
async function replay(body: unknown, grant?: string) {
  const res = await replayRoute(replayReq(body, grant), { params: Promise.resolve({ id: EVENT }) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
async function overview() {
  const res = await overviewRoute(new Request(`${ORIGIN}/api/admin/stripe/events`, { headers: { origin: ORIGIN, host: "localhost:3847" } }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown>, text: "" };
}
const grantFor = async (force: boolean) =>
  (await issueStepUpGrant({ operatorId: OP_ID, action: "stripe.event_replay", targetId: stepUpTarget(TENANT, EVENT), change: { force } })).grant;

describe.skipIf(!HAS_DB)("pay-pd: operator Stripe sync routes on Postgres", () => {
  beforeAll(async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_paypd_synthetic_never_used";
    h.fresh = freshEvent;
    await prisma.operator.create({
      data: {
        id: OP_ID,
        email: `${STAMP}@operator.test`,
        name: "payPD synthetic operator",
        passwordHash: "$2a$04$abcdefghijklmnopqrstuuJ1Q8m0Wq6r5pJ8dYpT0J3yq0QeQe9a",
        totpEnabled: true,
        totpSecret: "SYNTHETICSECRETNOTUSED",
      },
    });
    await withRlsBypass(async (tx) => {
      await tx.tenant.create({ data: { id: TENANT, name: `${STAMP} club`, slug: TENANT, stripeAccountId: ACCT, stripeConnected: true } });
      await tx.member.create({ data: { id: MEMBER, tenantId: TENANT, email: MEMBER_EMAIL, name: "PD Admin Member" } });
    });
    // The event failed on delivery (its handler threw).
    const failing: StripeEventProcessor<FreshStripeEvent> = async () => {
      throw new Error(`price lookup failed for ${MEMBER_EMAIL}`);
    };
    expect((await runStripeEvent({ ...freshEvent(EVENT), account: ACCT }, failing)).kind).toBe("failed");
    h.jar.set(OP_SESSION_COOKIE, issueOperatorSession(OP_ID, 0));
  }, 180_000);

  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 750)); // best-effort refusal rows land first
    await withRlsBypass(async (tx) => {
      await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_${S}` } } });
      await tx.auditLog.deleteMany({ where: { tenantId: TENANT } });
      await tx.payment.deleteMany({ where: { tenantId: TENANT } });
      await tx.member.deleteMany({ where: { tenantId: TENANT } });
      await tx.tenant.deleteMany({ where: { id: TENANT } });
      await tx.auditLog.deleteMany({ where: { tenantId: null, OR: [{ entityId: OP_ID }, { operatorId: OP_ID }] } });
    }, { timeout: 60_000 });
    await prisma.operator.deleteMany({ where: { id: OP_ID } });
    expect(await prisma.operator.count({ where: { id: OP_ID } })).toBe(0);
  }, 180_000);

  it("the overview needs operator authority and refuses a support session", async () => {
    const saved = h.jar.get(OP_SESSION_COOKIE)!;
    h.jar.delete(OP_SESSION_COOKIE);
    try {
      expect((await overview()).status).toBe(403);
    } finally {
      h.jar.set(OP_SESSION_COOKIE, saved);
    }
    h.session = { user: { id: "u1", tenantId: TENANT, role: "owner", impersonatedBy: OP_ID } };
    try {
      const r = await overview();
      expect(r.status).toBe(403);
      expect(r.body.supportReadOnly).toBe(true);
    } finally {
      h.session = null;
    }
  });

  it("the overview lists the club, its failed event and counts, with no personal data", async () => {
    const r = await overview();
    expect(r.status).toBe(200);
    const club = (r.body.clubs as Array<Record<string, unknown>>).find((c) => c.tenantId === TENANT)!;
    expect(club).toMatchObject({ stripeAccountId: ACCT, stripeConnected: true, counts: { last24h: { failed: 1 }, last7d: { failed: 1 } } });
    const attention = club.attention as Array<Record<string, unknown>>;
    expect(attention).toHaveLength(1);
    expect(attention[0]).toMatchObject({ eventId: EVENT, type: "invoice.payment_succeeded", status: "failed", attempts: 1 });
    const text = JSON.stringify(r.body);
    expect(text).not.toContain(MEMBER_EMAIL);
    expect(text).not.toContain("PD Admin Member");
    expect(text).toContain("[email]"); // the error that quoted an address is masked
    expect(text).not.toMatch(/sk_(test|live)_/);
  });

  it("replay refuses without a fresh grant and writes nothing", async () => {
    const r = await replay({ reason: "price table fixed, replaying" });
    expect(r.status).toBe(403);
    expect(await payments()).toBe(0);
    expect(await auditCount("stripe.event.replay.requested")).toBe(0);
    expect(h.retrieved).toEqual([]);
  });

  it("with a grant: fetched fresh as the club, processed once, requested + replayed audit rows on the grant's request id; the same grant echoes", async () => {
    const grant = await grantFor(false);
    const r = await replay({ reason: "price table fixed, replaying" }, grant);
    expect(r).toMatchObject({ status: 200, body: { ok: true, result: "processed", status: "replayed", forced: false } });
    expect(h.retrieved).toEqual([{ id: EVENT, acct: ACCT }]);
    expect(await payments()).toBe(1);
    expect(await status()).toBe("replayed");
    const rows = await withRlsBypass((tx) =>
      tx.auditLog.findMany({
        where: { tenantId: TENANT, action: { in: ["stripe.event.replay.requested", "stripe.event.replayed"] } },
        select: { action: true, requestId: true, operatorId: true, metadata: true },
        orderBy: { createdAt: "asc" },
      }),
    );
    expect(rows.map((x) => x.action)).toEqual(["stripe.event.replay.requested", "stripe.event.replayed"]);
    expect(rows[0].requestId).toBeTruthy();
    expect(rows[1].requestId).toBe(rows[0].requestId);
    expect(rows.every((x) => x.operatorId === OP_ID)).toBe(true);
    expect(rows[1].metadata).toMatchObject({ eventId: EVENT, previousStatus: "failed", forced: false, result: "processed" });

    const again = await replay({ reason: "price table fixed, replaying" }, grant);
    expect(again.status).toBe(200);
    expect(again.body.alreadyApplied).toBe(true);
    expect(h.retrieved).toHaveLength(1);
    expect(await payments()).toBe(1);
  });

  it("a settled event without force is refused 409 before any grant; a non-force grant cannot be spent on a forced replay", async () => {
    const plain = await replay({ reason: "second look at the ledger" });
    expect(plain.status).toBe(409);
    // A fresh grant does not change that, and is not spent; nothing is recorded.
    const requestedBefore = await auditCount("stripe.event.replay.requested");
    const unspent = await grantFor(false);
    const withGrant = await replay({ reason: "second look at the ledger" }, unspent);
    expect(withGrant.status).toBe(409);
    expect(await auditCount("stripe.event.replay.requested")).toBe(requestedBefore);
    const op = await prisma.operator.findUnique({ where: { id: OP_ID }, select: { stepUpNonceHash: true } });
    expect(op?.stepUpNonceHash).not.toBeNull();
    const wrongGrant = await grantFor(false);
    const r = await replay({ reason: "forced convergence check", force: true }, wrongGrant);
    expect(r.status).toBe(403);
    expect(h.retrieved).toHaveLength(1);
  });

  it("a forced replay creates no second Payment and no second handler audit row", async () => {
    const handlerAudits = await auditCount("member.payment.succeeded");
    expect(handlerAudits).toBe(1);
    const grant = await grantFor(true);
    const r = await replay({ reason: "forced convergence check", force: true }, grant);
    // Compare-only (review RP-8): reported, rolled back, the row stays replayed.
    expect(r).toMatchObject({ status: 200, body: { ok: true, result: "compared", status: "replayed", forced: true, wouldBe: "processed", writesRolledBack: ["payment.upsert"] } });
    expect(await payments()).toBe(1);
    expect(await auditCount("member.payment.succeeded")).toBe(1);
    expect(await auditCount("stripe.event.replayed")).toBe(2);
  });

  it("a short reason is refused 400 before anything", async () => {
    const r = await replay({ reason: "x", force: true });
    expect(r.status).toBe(400);
  });
});
