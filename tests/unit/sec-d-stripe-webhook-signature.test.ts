/**
 * Security lane D (9 Oct 2026) — SEC-089 forged / replayed Stripe webhooks.
 *
 * Unlike tests/unit/stripe-webhook-handlers.test.ts (which mocks
 * constructEvent), this file runs the REAL stripe library's verification
 * (stripe.webhooks.constructEvent, default tolerance 300 s) against
 * app/api/stripe/webhook/route.ts with a local, synthetic signing secret.
 * Nothing leaves the machine: unhandled types never reach the network and the
 * handled-type positive control uses an event that needs no Stripe API call.
 * The database is replaced by a recorder so the test can assert that nothing
 * is written for a refused request.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class extends Request {},
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
const db = vi.hoisted(() => ({ txCalls: 0, claimed: [] as string[], duplicate: false }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    db.txCalls += 1;
    const tx = {
      stripeEvent: {
        create: async ({ data }: { data: { eventId: string } }) => {
          if (db.duplicate || db.claimed.includes(data.eventId)) throw Object.assign(new Error("dup"), { code: "P2002" });
          db.claimed.push(data.eventId);
          return {};
        },
      },
      tenant: { findFirst: async () => ({ id: "t_secd" }), findUnique: async () => null, updateMany: async () => ({ count: 0 }) },
      user: { findMany: async () => [] },
    };
    return fn(tx);
  },
  withTenantContext: async () => { throw new Error("not used"); },
}));
const sendEmail = vi.hoisted(() => vi.fn(async () => ({ ok: true })));
vi.mock("@/lib/email", () => ({ sendEmail }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/stripe-account-status", () => ({ refreshStripeAccountStatus: vi.fn(async () => {}) }));

import Stripe from "stripe";
import { POST } from "@/app/api/stripe/webhook/route";

const SECRET = "whsec_secd_synthetic_local_only_0123456789";
process.env.STRIPE_WEBHOOK_SECRET = SECRET;
process.env.STRIPE_SECRET_KEY = "sk_test_secd_synthetic_never_used";
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: "2026-03-25.dahlia" as never });

const eventBody = (id: string, type: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ id, object: "event", type, account: "acct_secd", livemode: false, created: Math.floor(Date.now() / 1000), data: { object: { id: "obj_secd", object: "account", ...extra } } });
const sign = (payload: string, opts: { secret?: string; timestamp?: number } = {}) =>
  stripe.webhooks.generateTestHeaderString({
    payload,
    secret: opts.secret ?? SECRET,
    timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000),
  } as Parameters<typeof stripe.webhooks.generateTestHeaderString>[0]);
async function post(payload: string, signature: string | null) {
  const headers = new Headers({ "content-type": "application/json" });
  if (signature !== null) headers.set("stripe-signature", signature);
  const res = (await POST(new Request("http://localhost/api/stripe/webhook", { method: "POST", headers, body: payload }) as never)) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: res.status, body: await res.json() };
}

beforeEach(() => { db.txCalls = 0; db.claimed = []; db.duplicate = false; sendEmail.mockClear(); });

describe("SEC-089 Stripe webhook verification (real stripe library)", () => {
  it("POSITIVE CONTROL: a correctly signed handled event is processed (claimed once)", async () => {
    const body = eventBody("evt_secd_ok", "account.updated");
    const r = await post(body, sign(body));
    expect(r.status).toBe(200);
    expect(db.claimed).toEqual(["evt_secd_ok"]);
  });

  it("no signature header → 400, nothing written", async () => {
    const body = eventBody("evt_secd_nosig", "account.updated");
    expect((await post(body, null)).status).toBe(400);
    expect(db.txCalls).toBe(0);
  });

  it("signed with another secret → 400, nothing written", async () => {
    const body = eventBody("evt_secd_wrong", "account.updated");
    expect((await post(body, sign(body, { secret: "whsec_attacker_secret" }))).status).toBe(400);
    expect(db.txCalls).toBe(0);
  });

  it("a valid signature on a STALE timestamp (10 minutes old, tolerance 5) → 400 (replay window)", async () => {
    const body = eventBody("evt_secd_stale", "account.updated");
    expect((await post(body, sign(body, { timestamp: Math.floor(Date.now() / 1000) - 600 }))).status).toBe(400);
    expect(db.txCalls).toBe(0);
  });

  it("raw body is what is verified: re-serialised JSON (same object, different bytes) → 400", async () => {
    const body = eventBody("evt_secd_raw", "account.updated");
    const sig = sign(body);
    const reserialised = JSON.stringify(JSON.parse(body), null, 1);
    expect(reserialised).not.toBe(body);
    expect((await post(reserialised, sig)).status).toBe(400);
    expect(db.txCalls).toBe(0);
  });

  it("tampered field (account switched to another club's acct_) under the original signature → 400", async () => {
    const body = eventBody("evt_secd_tamper", "account.updated");
    const sig = sign(body);
    expect((await post(body.replace("acct_secd", "acct_other"), sig)).status).toBe(400);
    expect(db.txCalls).toBe(0);
  });

  it("REPLAY within the tolerance: the second delivery of one event id is acknowledged and not processed again", async () => {
    const body = eventBody("evt_secd_replay", "account.updated");
    const first = await post(body, sign(body));
    const second = await post(body, sign(body));
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body).toMatchObject({ received: true });
    expect(db.claimed).toEqual(["evt_secd_replay"]);
  });

  it("an unhandled event type is acknowledged without touching the database", async () => {
    const body = eventBody("evt_secd_unhandled", "balance.available");
    const r = await post(body, sign(body));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ignored: true });
    expect(db.txCalls).toBe(0);
  });

  it("no webhook secret configured → 400 for every request (fails closed, not open)", async () => {
    const saved = process.env.STRIPE_WEBHOOK_SECRET;
    delete process.env.STRIPE_WEBHOOK_SECRET;
    try {
      const body = eventBody("evt_secd_nosecret", "account.updated");
      expect((await post(body, sign(body))).status).toBe(400);
      expect(db.txCalls).toBe(0);
    } finally {
      process.env.STRIPE_WEBHOOK_SECRET = saved;
    }
  });
});
