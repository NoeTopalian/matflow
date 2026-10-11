// Payments lane PA (11 Oct 2026) — races between a checkout and a club's
// disconnection, on the REAL member checkout route, the REAL club-account guard
// and the REAL disconnect route, against the TEST database, with the competing
// write on a SECOND real connection from the pool.
//
// Requirement (Noe): "Missing, stale, disconnected or unverifiable club
// authorisation must refuse checkout. Never fall back to the platform account.
// Cover every payment-creation route, including races with disconnection."
//
// The invariant every cell asserts: a Checkout Session is either refused
// before Stripe, or created with `stripeAccount` equal to the id the guard
// captured for THAT club (which Stripe itself refuses once access is revoked)
// — never `undefined`, i.e. never MatFlow's platform account, and never the
// other club's account.
//
// Cells
//   A1 guard passes, then the in-app disconnect (real route) commits before the
//      Stripe call (interleaved at the Order write that sits between the two)
//   A2 the in-app disconnect commits first -> refused, no Order, no Stripe call
//   B1 guard passes, then a webhook-shaped deauthorisation (flag false, id
//      kept, status stamped "deauthorized") commits before the Stripe call
//   B2 the webhook-shaped deauthorisation commits first -> refused
//   C  true two-connection interleave: connection 1 holds an UNCOMMITTED
//      disconnect while the guard reads on connection 2; connection 1 commits
//      before the Stripe call. Then a fresh checkout is refused.
//   D  a second club checking out at the same time is untouched and uses its
//      own account id
//
// Stripe is a recording fake (no network). Runs only through the guarded
// runners (owner role and matflow_app with RLS), TEST branch. Prefix paypa-;
// count-checked teardown of this file's clubs only.

import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(init?.headers),
    }),
  },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));

type Who = { tenantId: string; userId: string; role: "owner" | "member"; memberId?: string };
const gate = vi.hoisted(() => ({ current: null as null | Who }));
const sessionOf = () =>
  gate.current
    ? { user: { id: gate.current.userId, tenantId: gate.current.tenantId, role: gate.current.role, ...(gate.current.memberId ? { memberId: gate.current.memberId } : {}) } }
    : null;
vi.mock("@/auth", () => ({ auth: vi.fn(async () => sessionOf()), signIn: vi.fn(), signOut: vi.fn(), handlers: {} }));

const stripeRec = vi.hoisted(() => ({
  calls: [] as { method: string; args: unknown[] }[],
  retrieve: null as null | ((id: string) => Promise<unknown>),
}));
vi.mock("stripe", () => {
  const rec = (method: string, result: () => unknown) =>
    async (...args: unknown[]) => { stripeRec.calls.push({ method, args }); return result(); };
  class FakeStripe {
    accounts = {
      retrieve: async (id: string) => {
        stripeRec.calls.push({ method: "accounts.retrieve", args: [id] });
        if (stripeRec.retrieve) return stripeRec.retrieve(id);
        return { id, charges_enabled: true, payouts_enabled: true, requirements: { past_due: [], disabled_reason: null } };
      },
    };
    checkout = { sessions: { create: rec("checkout.sessions.create", () => ({ id: `cs_paypa_${stripeRec.calls.length}`, url: "https://checkout.test/x" })) } };
    oauth = { deauthorize: rec("oauth.deauthorize", () => ({})) };
  }
  return { default: FakeStripe };
});

// One-shot hook: the next tx.<model>.<op> call fires `fire` first.
type Hook = { model: string; op: string; fire: () => Promise<void> } | null;
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
                if (h && h.model === p && h.op === op) {
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

import { Prisma } from "@prisma/client";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as checkoutPOST } from "@/app/api/member/checkout/route";
import { POST as disconnectPOST } from "@/app/api/stripe/disconnect/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `paypa-${Date.now().toString(36)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Club = { tenantId: string; ownerId: string; memberUserId: string; memberId: string; productId: string; acct: string };
const clubs: Club[] = [];

const freshStatus = () => ({
  chargesEnabled: true,
  payoutsEnabled: true,
  requirementsPastDue: [],
  disabledReason: null,
  refreshedAt: new Date().toISOString(),
});

async function mkClub(label: string): Promise<Club> {
  const acct = `acct_${STAMP.replace(/-/g, "_")}_${label}`;
  const club = await withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({
      data: {
        name: `${STAMP} ${label}`,
        slug: `${STAMP}-${label}`,
        timezone: "Europe/London",
        onboardingCompleted: true,
        memberSelfBilling: true,
        currency: "GBP",
        stripeAccountId: acct,
        stripeConnected: true,
        stripeAccountStatus: freshStatus(),
      },
    });
    const owner = await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-${label}-owner@example.test`, name: "payPA Owner", role: "owner", passwordHash: "x" } });
    const m = await tx.member.create({ data: { tenantId: t.id, name: "payPA Member", email: `${STAMP}-${label}-member@example.test` }, select: { id: true } });
    const p = await tx.product.create({ data: { tenantId: t.id, name: "Club tee", pricePence: 1500 }, select: { id: true } });
    // A member signs in as a Member, not a User; the session's user id is the member's.
    return { tenantId: t.id, ownerId: owner.id, memberUserId: m.id, memberId: m.id, productId: p.id, acct };
  });
  clubs.push(club);
  return club;
}

async function resetClub(club: Club) {
  await withRlsBypass((tx) =>
    tx.tenant.update({
      where: { id: club.tenantId },
      data: { stripeAccountId: club.acct, stripeConnected: true, stripeAccountStatus: freshStatus() },
    }),
  );
}

const asMember = (c: Club): Who => ({ tenantId: c.tenantId, userId: c.memberUserId, role: "member", memberId: c.memberId });
const asOwner = (c: Club): Who => ({ tenantId: c.tenantId, userId: c.ownerId, role: "owner" });

function checkoutReq(c: Club): Request {
  return {
    method: "POST",
    url: "https://test.local/api/member/checkout",
    nextUrl: { origin: "https://test.local" },
    headers: new Headers({ origin: "https://test.local", host: "test.local" }),
    json: async () => ({ items: [{ id: c.productId, name: "Club tee", price: 15, quantity: 1 }] }),
  } as unknown as Request;
}
const disconnectReq = () =>
  new Request("https://test.local/api/stripe/disconnect", { method: "POST", headers: { origin: "https://test.local", host: "test.local" } });

async function runCheckout(c: Club) {
  gate.current = asMember(c);
  const res = (await checkoutPOST(checkoutReq(c) as never)) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
  return { status: res.status, body: await res.json() };
}

/** Disconnect through the REAL owner route (DB cleared first, then Stripe told). Restores the caller's session after. */
async function runDisconnect(c: Club) {
  const prev = gate.current;
  gate.current = asOwner(c);
  try {
    const res = (await disconnectPOST(disconnectReq())) as unknown as { status: number };
    expect(res.status).toBe(200);
  } finally {
    gate.current = prev;
  }
}

/** The shape app/api/stripe/webhook writes on account.application.deauthorized: flag cleared, id KEPT, status stamped. */
async function webhookDeauthorise(c: Club) {
  await withRlsBypass((tx) =>
    tx.tenant.updateMany({
      where: { id: c.tenantId },
      data: {
        stripeConnected: false,
        stripeAccountStatus: { chargesEnabled: false, payoutsEnabled: false, requirementsPastDue: [], disabledReason: "deauthorized", refreshedAt: new Date().toISOString() },
      },
    }),
  );
}

const sessionCalls = () => stripeRec.calls.filter((c) => c.method === "checkout.sessions.create");
const optsOf = (c: { args: unknown[] }) => c.args[c.args.length - 1] as { stripeAccount?: unknown } | undefined;
const orderCount = (c: Club) => withRlsBypass((tx) => tx.order.count({ where: { tenantId: c.tenantId } }));
const tenantNow = (c: Club) =>
  withRlsBypass((tx) => tx.tenant.findUnique({ where: { id: c.tenantId }, select: { stripeAccountId: true, stripeConnected: true } }));

let A: Club;
let B: Club;

beforeEach(async () => {
  stripeRec.calls.length = 0;
  stripeRec.retrieve = null;
  HOOK.current = null;
  process.env.STRIPE_SECRET_KEY = "sk_test_paypa_fixture_only";
  process.env.STRIPE_CLIENT_ID = "ca_paypa_fixture_only";
  if (HAS_DB && A) {
    await resetClub(A);
    await resetClub(B);
  }
});

afterAll(async () => {
  if (!HAS_DB) return;
  HOOK.current = null;
  const ids = clubs.map((c) => c.tenantId);
  for (const tenantId of ids) {
    await withRlsBypass(async (tx) => {
      await tx.order.deleteMany({ where: { tenantId } });
      await tx.product.deleteMany({ where: { tenantId } });
      await tx.auditLog.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.delete({ where: { id: tenantId } });
    }, { timeout: 60_000 });
  }
  const left = await withRlsBypass(async (tx) => ({
    tenants: await tx.tenant.count({ where: { slug: { startsWith: STAMP } } }),
    orders: await tx.order.count({ where: { tenantId: { in: ids } } }),
    members: await tx.member.count({ where: { OR: [{ tenantId: { in: ids } }, { email: { startsWith: STAMP } }] } }),
    users: await tx.user.count({ where: { OR: [{ tenantId: { in: ids } }, { email: { startsWith: STAMP } }] } }),
    audit: await tx.auditLog.count({ where: { tenantId: { in: ids } } }),
  }));
  expect(left).toEqual({ tenants: 0, orders: 0, members: 0, users: 0, audit: 0 });
  process.stderr.write(`[paypa] teardown: ${ids.length} clubs removed, 0 rows left\n`);
}, 240_000);

describe.skipIf(!HAS_DB)("PA — checkout vs disconnection races (REAL routes, two connections, TEST DB)", () => {
  beforeAll(async () => {
    const who = await withRlsBypass((tx) => tx.$queryRaw<{ current_user: string }[]>`SELECT current_user`);
    process.stderr.write(`[paypa] database role: ${who[0]?.current_user}; RLS_ENFORCED=${process.env.RLS_ENFORCED ?? "unset"}\n`);
    A = await mkClub("a");
    B = await mkClub("b");
  }, 120_000);

  it("A0 baseline: a healthy club's checkout is created on its own account", async () => {
    const r = await runCheckout(A);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(sessionCalls()).toHaveLength(1);
    expect(optsOf(sessionCalls()[0])?.stripeAccount).toBe(A.acct);
  });

  it("A1 in-app disconnect commits after the guard and before the Stripe call -> the captured club id is used, never undefined", async () => {
    let fired = false;
    HOOK.current = { model: "order", op: "create", fire: async () => { fired = true; await runDisconnect(A); } };
    const r = await runCheckout(A);
    expect(fired).toBe(true);
    // The disconnect really committed in the window.
    expect(await tenantNow(A)).toEqual({ stripeAccountId: null, stripeConnected: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = sessionCalls();
    expect(s).toHaveLength(1);
    expect(optsOf(s[0])?.stripeAccount).toBe(A.acct);
    // The disconnect route told Stripe about the same captured account.
    const deauth = stripeRec.calls.find((c) => c.method === "oauth.deauthorize");
    expect((deauth?.args[0] as { stripe_user_id?: string })?.stripe_user_id).toBe(A.acct);
  });

  it("A2 in-app disconnect commits first -> checkout refused 409 no_account, no Order, no Stripe call", async () => {
    await runDisconnect(A);
    stripeRec.calls.length = 0;
    const before = await orderCount(A);
    const r = await runCheckout(A);
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("no_account");
    expect(stripeRec.calls).toEqual([]);
    expect(await orderCount(A)).toBe(before);
  });

  it("B1 webhook deauthorisation (flag false, id kept) lands after the guard and before the Stripe call -> the captured club id is used", async () => {
    let fired = false;
    HOOK.current = { model: "order", op: "create", fire: async () => { fired = true; await webhookDeauthorise(A); } };
    const r = await runCheckout(A);
    expect(fired).toBe(true);
    expect(await tenantNow(A)).toEqual({ stripeAccountId: A.acct, stripeConnected: false });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const s = sessionCalls();
    expect(s).toHaveLength(1);
    expect(optsOf(s[0])?.stripeAccount).toBe(A.acct);
  });

  it("B2 webhook deauthorisation commits first -> refused 409 deauthorized, no Stripe call", async () => {
    await webhookDeauthorise(A);
    const before = await orderCount(A);
    const r = await runCheckout(A);
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("deauthorized");
    expect(stripeRec.calls).toEqual([]);
    expect(await orderCount(A)).toBe(before);
  });

  it("B3 webhook deauthorisation with the status cache EXPIRED and the refresh refused for permissions (the audit's exact path) -> refused, nothing on the platform", async () => {
    await withRlsBypass((tx) =>
      tx.tenant.update({
        where: { id: A.tenantId },
        data: {
          stripeConnected: false,
          stripeAccountStatus: {
            chargesEnabled: false, payoutsEnabled: false, requirementsPastDue: [], disabledReason: "deauthorized",
            refreshedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
          },
        },
      }),
    );
    stripeRec.retrieve = async () => {
      throw Object.assign(new Error("does not have the required permissions"), { type: "StripePermissionError" });
    };
    const r = await runCheckout(A);
    expect(r.status).toBe(409);
    expect(r.body.reason).toBe("deauthorized");
    expect(sessionCalls()).toEqual([]);
  });

  it("C two connections: an UNCOMMITTED disconnect holds the row while the guard reads; it commits before the Stripe call -> captured id; then a fresh checkout is refused", async () => {
    let release!: () => void;
    const released = new Promise<void>((r) => { release = r; });
    let updated!: () => void;
    const didUpdate = new Promise<void>((r) => { updated = r; });
    // Connection 1: the disconnect write, held open (uncommitted) until released.
    const conn1 = withRlsBypass(async (tx) => {
      // The same three columns the disconnect route clears.
      await tx.tenant.update({
        where: { id: A.tenantId },
        data: { stripeAccountId: null, stripeConnected: false, stripeAccountStatus: Prisma.DbNull },
      });
      updated();
      await released;
    }, { timeout: 60_000 });
    conn1.catch(() => {});
    await didUpdate;

    // Connection 2: the checkout. Its guard reads the last COMMITTED row (still connected).
    let commitSeenBeforeStripe = false;
    HOOK.current = {
      model: "order", op: "create",
      fire: async () => {
        release();
        await conn1;
        commitSeenBeforeStripe = (await tenantNow(A))?.stripeConnected === false;
      },
    };
    const r = await runCheckout(A);
    expect(commitSeenBeforeStripe).toBe(true);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(sessionCalls()).toHaveLength(1);
    expect(optsOf(sessionCalls()[0])?.stripeAccount).toBe(A.acct);

    // Mirror: after the commit, a new checkout is refused before Stripe.
    stripeRec.calls.length = 0;
    const r2 = await runCheckout(A);
    expect(r2.status).toBe(409);
    expect(r2.body.reason).toBe("no_account");
    expect(stripeRec.calls).toEqual([]);
  });

  it("D club B checks out while club A is being disconnected -> B uses B's account, A's call never carries undefined or B's id", async () => {
    HOOK.current = { model: "order", op: "create", fire: async () => { await runDisconnect(A); } };
    const ra = await runCheckout(A);
    await sleep(5); // the shop's order reference is millisecond-based (see report); keep the two refs distinct
    const rb = await runCheckout(B);
    expect(ra.status).toBe(200);
    expect(rb.status).toBe(200);
    const accounts = sessionCalls().map((c) => optsOf(c)?.stripeAccount);
    expect(accounts).toEqual([A.acct, B.acct]);
    expect(await tenantNow(B)).toEqual({ stripeAccountId: B.acct, stripeConnected: true });
  });

  it("E repeated interleavings never produce a platform-account call", async () => {
    const seen: unknown[] = [];
    for (let i = 0; i < 4; i++) {
      await resetClub(A);
      stripeRec.calls.length = 0;
      const delay = i * 3;
      // Disconnect races the checkout from the outside, with no hook: whichever wins, the invariant must hold.
      const [r] = await Promise.all([runCheckout(A), sleep(delay).then(() => runDisconnect(A))]);
      for (const c of sessionCalls()) seen.push(optsOf(c)?.stripeAccount);
      if (r.status !== 200) {
        expect([409]).toContain(r.status);
        expect(sessionCalls()).toEqual([]);
      }
      await sleep(5);
    }
    for (const acct of seen) expect(acct).toBe(A.acct);
  });
});
