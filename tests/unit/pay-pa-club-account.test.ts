// Lane PA — unit tests for the single club-account guard
// (lib/stripe/club-account.ts) and the fail-closed account-status refresh
// (lib/stripe-account-status.ts). The route-level matrix lives in
// tests/unit/pay-pa-route-guard-matrix.test.ts; this file pins the guard's own
// contract: one consistent tenant read, fresh-or-refresh, fail closed on any
// refresh error or timeout, purpose-aware charges check, and the refusal
// response shape.

import { vi, describe, it, expect, beforeEach } from "vitest";

const m = vi.hoisted(() => ({
  tenantRow: null as Record<string, unknown> | null,
  findUnique: vi.fn(),
  updateMany: vi.fn(),
  update: vi.fn(),
  retrieve: vi.fn(),
  stripeConfigs: [] as unknown[],
  readThrows: null as Error | null,
}));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }),
  },
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    if (m.readThrows) throw m.readThrows;
    return fn({
      $executeRaw: vi.fn(async () => 0),
      tenant: { findUnique: m.findUnique, updateMany: m.updateMany, update: m.update },
    });
  },
}));

vi.mock("stripe", () => ({
  default: class {
    constructor(_key: string, config: unknown) { m.stripeConfigs.push(config); }
    accounts = { retrieve: (...a: unknown[]) => m.retrieve(...a) };
  },
}));

import {
  requireChargeableClubAccount,
  ClubAccountNotChargeable,
  clubAccountRefusal,
  CLUB_ACCOUNT_STATUS_MAX_AGE_MS,
} from "@/lib/stripe/club-account";
import { refreshStripeAccountStatus } from "@/lib/stripe-account-status";

const HOUR = 60 * 60 * 1000;
const ACCT = "acct_pa_guard_1";
const fresh = (over: Record<string, unknown> = {}, ageMs = HOUR) => ({
  chargesEnabled: true,
  payoutsEnabled: true,
  requirementsPastDue: [],
  disabledReason: null,
  refreshedAt: new Date(Date.now() - ageMs).toISOString(),
  ...over,
});
const healthyAccount = { id: ACCT, charges_enabled: true, payouts_enabled: true, requirements: { past_due: [], disabled_reason: null } };

beforeEach(() => {
  vi.clearAllMocks();
  m.stripeConfigs.length = 0;
  m.readThrows = null;
  process.env.STRIPE_SECRET_KEY = "sk_test_lane_pa_fixture";
  m.tenantRow = { stripeAccountId: ACCT, stripeConnected: true, stripeAccountStatus: fresh() };
  m.findUnique.mockImplementation(async () => (m.tenantRow ? { ...m.tenantRow } : null));
  m.updateMany.mockResolvedValue({ count: 1 });
  m.retrieve.mockResolvedValue(healthyAccount);
});

async function refusalOf(p: Promise<unknown>): Promise<ClubAccountNotChargeable> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(ClubAccountNotChargeable);
    return e as ClubAccountNotChargeable;
  }
  throw new Error("expected the guard to refuse");
}

describe("requireChargeableClubAccount — the one read", () => {
  it("reads id, flag and status in ONE tenant query and returns the id it read", async () => {
    const out = await requireChargeableClubAccount("t1", { purpose: "shop_checkout" });
    expect(out.stripeAccountId).toBe(ACCT);
    expect(m.findUnique).toHaveBeenCalledTimes(1);
    expect(m.findUnique).toHaveBeenCalledWith({
      where: { id: "t1" },
      select: { stripeAccountId: true, stripeConnected: true, stripeAccountStatus: true },
    });
    expect(m.retrieve).not.toHaveBeenCalled();
  });

  it("the 24 h window is the documented one", () => {
    expect(CLUB_ACCOUNT_STATUS_MAX_AGE_MS).toBe(24 * HOUR);
  });
});

describe("requireChargeableClubAccount — refusals", () => {
  it("no tenant row -> no_account", async () => {
    m.tenantRow = null;
    const e = await refusalOf(requireChargeableClubAccount("t1", { purpose: "shop_checkout" }));
    expect(e.reason).toBe("no_account");
  });

  it("no account id -> no_account (even if the flag says connected)", async () => {
    m.tenantRow = { stripeAccountId: null, stripeConnected: true, stripeAccountStatus: fresh() };
    const e = await refusalOf(requireChargeableClubAccount("t1", { purpose: "refund" }));
    expect(e.reason).toBe("no_account");
  });

  it("id kept, flag false -> not_connected, with no Stripe call", async () => {
    m.tenantRow = { stripeAccountId: ACCT, stripeConnected: false, stripeAccountStatus: fresh({}, 30 * HOUR) };
    const e = await refusalOf(requireChargeableClubAccount("t1", { purpose: "shop_checkout" }));
    expect(e.reason).toBe("not_connected");
    expect(m.retrieve).not.toHaveBeenCalled();
  });

  it("flag false with a deauthorized stamp -> deauthorized", async () => {
    m.tenantRow = { stripeAccountId: ACCT, stripeConnected: false, stripeAccountStatus: fresh({ chargesEnabled: false, disabledReason: "deauthorized" }) };
    const e = await refusalOf(requireChargeableClubAccount("t1", { purpose: "subscription_cancel" }));
    expect(e.reason).toBe("deauthorized");
  });

  it("deauthorized stamp within 24 h refuses even with the flag true, for every purpose", async () => {
    m.tenantRow = { stripeAccountId: ACCT, stripeConnected: true, stripeAccountStatus: fresh({ chargesEnabled: false, disabledReason: "deauthorized" }) };
    for (const purpose of ["shop_checkout", "refund", "billing_portal", "collection_pause"] as const) {
      const e = await refusalOf(requireChargeableClubAccount("t1", { purpose }));
      expect(e.reason).toBe("deauthorized");
    }
    expect(m.retrieve).not.toHaveBeenCalled();
  });

  it("no platform key -> stripe_not_configured, no Stripe call", async () => {
    delete process.env.STRIPE_SECRET_KEY;
    const e = await refusalOf(requireChargeableClubAccount("t1", { purpose: "shop_checkout" }));
    expect(e.reason).toBe("stripe_not_configured");
    expect(m.retrieve).not.toHaveBeenCalled();
  });

  it("a database failure reading the tenant refuses (503 tenant_unreadable), never proceeds", async () => {
    m.readThrows = new Error("connection terminated");
    const e = await refusalOf(requireChargeableClubAccount("t1", { purpose: "shop_checkout" }));
    expect(e.reason).toBe("tenant_unreadable");
  });

  it("fresh status with chargesEnabled false refuses money-in purposes", async () => {
    m.tenantRow = { stripeAccountId: ACCT, stripeConnected: true, stripeAccountStatus: fresh({ chargesEnabled: false, disabledReason: "requirements.past_due" }) };
    for (const purpose of ["shop_checkout", "class_pack_checkout", "adhoc_charge", "subscription_start", "collection_resume"] as const) {
      const e = await refusalOf(requireChargeableClubAccount("t1", { purpose }));
      expect(e.reason).toBe("charges_disabled");
    }
  });

  it("fresh status with chargesEnabled false still allows money-out / manage purposes ON THE CLUB ACCOUNT", async () => {
    m.tenantRow = { stripeAccountId: ACCT, stripeConnected: true, stripeAccountStatus: fresh({ chargesEnabled: false, disabledReason: "requirements.past_due" }) };
    for (const purpose of ["refund", "subscription_cancel", "collection_pause", "billing_portal", "catalogue"] as const) {
      const out = await requireChargeableClubAccount("t1", { purpose });
      expect(out.stripeAccountId).toBe(ACCT);
    }
  });
});

describe("requireChargeableClubAccount — stale cache", () => {
  it("a status older than 24 h is refreshed for the id that was read, and a healthy answer passes", async () => {
    m.tenantRow = { stripeAccountId: ACCT, stripeConnected: true, stripeAccountStatus: fresh({}, 25 * HOUR) };
    const out = await requireChargeableClubAccount("t1", { purpose: "shop_checkout" });
    expect(out.stripeAccountId).toBe(ACCT);
    expect(m.retrieve).toHaveBeenCalledWith(ACCT);
  });

  it("null, garbage, undated and future-dated statuses are all treated as stale", async () => {
    for (const s of [null, "active", { chargesEnabled: true }, fresh({}, -2 * HOUR)]) {
      m.retrieve.mockClear();
      m.tenantRow = { stripeAccountId: ACCT, stripeConnected: true, stripeAccountStatus: s };
      await requireChargeableClubAccount("t1", { purpose: "shop_checkout" });
      expect(m.retrieve).toHaveBeenCalledTimes(1);
    }
  });

  it("stale + permission error -> status_unreadable (the old fail-open is gone)", async () => {
    m.tenantRow = { stripeAccountId: ACCT, stripeConnected: true, stripeAccountStatus: fresh({}, 25 * HOUR) };
    m.retrieve.mockRejectedValue(Object.assign(new Error("does not have the required permissions"), { type: "StripePermissionError" }));
    const e = await refusalOf(requireChargeableClubAccount("t1", { purpose: "refund" }));
    expect(e.reason).toBe("status_unreadable");
  });

  it("stale + generic error -> status_unreadable", async () => {
    m.tenantRow = { stripeAccountId: ACCT, stripeConnected: true, stripeAccountStatus: fresh({}, 25 * HOUR) };
    m.retrieve.mockRejectedValue(new Error("socket hang up"));
    const e = await refusalOf(requireChargeableClubAccount("t1", { purpose: "shop_checkout" }));
    expect(e.reason).toBe("status_unreadable");
  });

  it("a cached status_unreadable (or legacy refresh_error) is re-verified, and passes once Stripe answers", async () => {
    for (const reason of ["status_unreadable", "refresh_error"]) {
      m.retrieve.mockClear();
      m.tenantRow = { stripeAccountId: ACCT, stripeConnected: true, stripeAccountStatus: fresh({ chargesEnabled: true, disabledReason: reason }) };
      const out = await requireChargeableClubAccount("t1", { purpose: "shop_checkout" });
      expect(out.stripeAccountId).toBe(ACCT);
      expect(m.retrieve).toHaveBeenCalledTimes(1);
    }
  });

  it("a legacy fail-open snapshot (chargesEnabled TRUE + status_unreadable, written by the old code) is never trusted", async () => {
    m.tenantRow = { stripeAccountId: ACCT, stripeConnected: true, stripeAccountStatus: fresh({ chargesEnabled: true, disabledReason: "status_unreadable" }) };
    m.retrieve.mockRejectedValue(Object.assign(new Error("does not have the required permissions"), { type: "StripePermissionError" }));
    const e = await refusalOf(requireChargeableClubAccount("t1", { purpose: "shop_checkout" }));
    expect(e.reason).toBe("status_unreadable");
  });

  it("a refresh whose answer is charges_enabled false refuses a money-in purpose", async () => {
    m.tenantRow = { stripeAccountId: ACCT, stripeConnected: true, stripeAccountStatus: fresh({}, 25 * HOUR) };
    m.retrieve.mockResolvedValue({ ...healthyAccount, charges_enabled: false, requirements: { past_due: [], disabled_reason: "rejected.other" } });
    const e = await refusalOf(requireChargeableClubAccount("t1", { purpose: "adhoc_charge" }));
    expect(e.reason).toBe("charges_disabled");
  });
});

describe("refreshStripeAccountStatus — fail closed", () => {
  it("permission error -> chargesEnabled false, status_unreadable, error-level log with the key-scope hint", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.retrieve.mockRejectedValue(Object.assign(new Error("does not have the required permissions"), { type: "StripePermissionError" }));
    const s = await refreshStripeAccountStatus("t1", ACCT);
    expect(s.chargesEnabled).toBe(false);
    expect(s.payoutsEnabled).toBe(false);
    expect(s.disabledReason).toBe("status_unreadable");
    const logged = spy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toMatch(/accounts read scope/);
    expect(logged).not.toMatch(/Treating as chargeable/);
    spy.mockRestore();
  });

  it("a hung accounts.retrieve is cut off by the timeout and fails closed", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    m.retrieve.mockImplementation(() => new Promise(() => {}));
    const started = Date.now();
    const s = await refreshStripeAccountStatus("t1", ACCT, { timeoutMs: 40 });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(s.chargesEnabled).toBe(false);
    expect(s.disabledReason).toBe("status_unreadable");
    spy.mockRestore();
  });

  it("builds its client with a short timeout and no automatic retries", async () => {
    await refreshStripeAccountStatus("t1", ACCT);
    expect(m.stripeConfigs[0]).toEqual(expect.objectContaining({ timeout: expect.any(Number), maxNetworkRetries: 0 }));
    expect((m.stripeConfigs[0] as { timeout: number }).timeout).toBeLessThanOrEqual(10_000);
  });

  it("persists only onto the SAME, still-connected account (a racing disconnect or deauthorisation is not overwritten)", async () => {
    await refreshStripeAccountStatus("t1", ACCT);
    expect(m.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "t1", stripeAccountId: ACCT, stripeConnected: true },
        data: expect.objectContaining({ stripeAccountStatus: expect.objectContaining({ chargesEnabled: true }) }),
      }),
    );
    expect(m.update).not.toHaveBeenCalled();
  });
});

describe("clubAccountRefusal — the HTTP answer", () => {
  it.each([
    ["no_account", 409],
    ["not_connected", 409],
    ["deauthorized", 409],
    ["status_unreadable", 503],
    ["charges_disabled", 503],
    ["stripe_not_configured", 503],
    ["tenant_unreadable", 503],
  ] as const)("%s -> %i with a structured reason and no account id", async (reason, code) => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new ClubAccountNotChargeable(reason, { tenantId: "t1", purpose: "shop_checkout" });
    const res = clubAccountRefusal(err, { audience: "member" }) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
    expect(res.status).toBe(code);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.reason).toBe(reason);
    expect(typeof body.error).toBe("string");
    expect(JSON.stringify(body)).not.toContain("acct_");
    spy.mockRestore();
  });

  it("member wording never mentions Stripe internals; staff wording tells the owner what to do", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new ClubAccountNotChargeable("not_connected", { tenantId: "t1", purpose: "shop_checkout" });
    const member = await (clubAccountRefusal(err, { audience: "member" }) as unknown as { json: () => Promise<{ error: string }> }).json();
    const staff = await (clubAccountRefusal(err, { audience: "staff" }) as unknown as { json: () => Promise<{ error: string }> }).json();
    expect(member.error).not.toMatch(/stripe|acct_|scope/i);
    expect(staff.error).toMatch(/Settings/);
    spy.mockRestore();
  });

  it("extra fields are carried (the charge drawer needs outcomeUnknown:false)", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new ClubAccountNotChargeable("status_unreadable", { tenantId: "t1", purpose: "adhoc_charge" });
    const body = await (clubAccountRefusal(err, { audience: "staff", extra: { outcomeUnknown: false } }) as unknown as { json: () => Promise<Record<string, unknown>> }).json();
    expect(body.outcomeUnknown).toBe(false);
    spy.mockRestore();
  });
});
