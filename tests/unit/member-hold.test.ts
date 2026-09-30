/**
 * Membership holds (lib/member-hold.ts + the two routes).
 *
 * A hold is paymentStatus "paused" with a date, and — when the member has a
 * Stripe subscription — Stripe's pause_collection with behavior "void". Two
 * facts pinned here because both were got wrong once in design: pausing
 * collection leaves subscription.status "active" (so the webhook reads the
 * field, not the status), and `behavior` is explicit ("keep_as_draft", the
 * dashboard default, would pile up invoices for the member to face on
 * return). The routes update Stripe FIRST so a Stripe refusal changes nothing
 * locally.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  parseHoldUntil,
  pauseCollectionParams,
  RESUME_COLLECTION_PARAMS,
  readPauseCollection,
  isOnHold,
  HOLD_MAX_DAYS,
} from "@/lib/member-hold";

const NOW = new Date("2026-09-24T09:00:00Z");

describe("parseHoldUntil", () => {
  it("absent, null or empty means open-ended", () => {
    expect(parseHoldUntil(undefined, NOW)).toEqual({ ok: true, until: null });
    expect(parseHoldUntil(null, NOW)).toEqual({ ok: true, until: null });
    expect(parseHoldUntil("", NOW)).toEqual({ ok: true, until: null });
  });
  it("accepts an ISO date a day or more ahead, within the cap", () => {
    const r = parseHoldUntil("2026-10-20T00:00:00.000Z", NOW);
    expect(r).toEqual({ ok: true, until: new Date("2026-10-20T00:00:00.000Z") });
  });
  it("refuses garbage, the past, today, and anything past the cap", () => {
    expect(parseHoldUntil(42, NOW).ok).toBe(false);
    expect(parseHoldUntil("not a date", NOW).ok).toBe(false);
    expect(parseHoldUntil("2026-09-01T00:00:00Z", NOW).ok).toBe(false);
    expect(parseHoldUntil("2026-09-24T20:00:00Z", NOW).ok).toBe(false);
    const tooFar = new Date(NOW.getTime() + (HOLD_MAX_DAYS + 1) * 86_400_000).toISOString();
    const r = parseHoldUntil(tooFar, NOW);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/cancel the membership/);
  });
});

describe("Stripe params", () => {
  it("a dated hold voids invoices and resumes on the date", () => {
    expect(pauseCollectionParams(new Date("2026-10-20T00:00:00Z"))).toEqual({
      pause_collection: { behavior: "void", resumes_at: Math.floor(new Date("2026-10-20T00:00:00Z").getTime() / 1000) },
    });
  });
  it("an open-ended hold voids invoices with no resume date", () => {
    expect(pauseCollectionParams(null)).toEqual({ pause_collection: { behavior: "void" } });
  });
  it("resume clears the field with an empty string, as Stripe requires", () => {
    expect(RESUME_COLLECTION_PARAMS).toEqual({ pause_collection: "" });
  });
});

describe("readPauseCollection (what the webhook sees)", () => {
  it("null or absent means collection is running", () => {
    expect(readPauseCollection({ status: "active", pause_collection: null })).toEqual({ paused: false, resumesAt: null });
    expect(readPauseCollection({ status: "active" })).toEqual({ paused: false, resumesAt: null });
  });
  it("an object means paused, with the resume date when Stripe has one — status is NOT consulted", () => {
    expect(readPauseCollection({ status: "active", pause_collection: { behavior: "void", resumes_at: 1_790_000_000 } })).toEqual({
      paused: true,
      resumesAt: new Date(1_790_000_000 * 1000),
    });
    expect(readPauseCollection({ status: "active", pause_collection: { behavior: "void" } })).toEqual({ paused: true, resumesAt: null });
  });
});

describe("isOnHold", () => {
  it("paused with no date, or a future date, is on hold; a passed date is not; other statuses never are", () => {
    expect(isOnHold({ paymentStatus: "paused", holdUntil: null }, NOW)).toBe(true);
    expect(isOnHold({ paymentStatus: "paused", holdUntil: new Date("2026-10-01T00:00:00Z") }, NOW)).toBe(true);
    expect(isOnHold({ paymentStatus: "paused", holdUntil: new Date("2026-09-01T00:00:00Z") }, NOW)).toBe(false);
    expect(isOnHold({ paymentStatus: "paid", holdUntil: new Date("2026-10-01T00:00:00Z") }, NOW)).toBe(false);
    expect(isOnHold({ paymentStatus: "overdue" }, NOW)).toBe(false);
  });
});

// ── The routes ───────────────────────────────────────────────────────────────

const { memberFindFirstMock, memberUpdateMock, memberUpdateManyMock, tenantFindUniqueMock, subscriptionsUpdateMock, logAuditMock, gateMock, csrfMock, paymentCountMock } = vi.hoisted(() => ({
  memberFindFirstMock: vi.fn(),
  memberUpdateMock: vi.fn(),
  memberUpdateManyMock: vi.fn(),
  tenantFindUniqueMock: vi.fn(),
  subscriptionsUpdateMock: vi.fn(),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
  gateMock: vi.fn(),
  csrfMock: vi.fn(),
  paymentCountMock: vi.fn(async () => 1),
}));

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body }) },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: (req: Request) => csrfMock(req) }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwnerOrManager: () => gateMock() }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) =>
    // payment.count: resume reads whether the member has ever paid (30 Sep 2026).
    Promise.resolve(fn({ member: { findFirst: memberFindFirstMock, update: memberUpdateMock, updateMany: memberUpdateManyMock }, tenant: { findUnique: tenantFindUniqueMock }, payment: { count: paymentCountMock } })),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: (...a: unknown[]) => logAuditMock(...a) }));
vi.mock("@/lib/api-error", () => ({
  apiError: (message: string, status: number) => ({ status, json: async () => ({ error: message }) }),
}));
vi.mock("stripe", () => ({
  default: class {
    subscriptions = { update: subscriptionsUpdateMock };
  },
}));

const OWNER = { ok: true as const, tenantId: "tenant-A", userId: "user-owner", role: "owner" };
const req = (body?: unknown) => new Request("http://localhost/api/members/mem-1/hold", { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) });
const params = { params: Promise.resolve({ id: "mem-1" }) };

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_x";
  csrfMock.mockReturnValue(null);
  gateMock.mockResolvedValue(OWNER);
  tenantFindUniqueMock.mockResolvedValue({ stripeAccountId: "acct_gym", stripeConnected: true });
  memberUpdateMock.mockResolvedValue({});
  memberUpdateManyMock.mockResolvedValue({ count: 1 });
  subscriptionsUpdateMock.mockResolvedValue({ id: "sub_1", status: "active" });
});

describe("POST /api/members/[id]/hold", () => {
  it("pauses Stripe (void, resumes_at) FIRST, then writes paused + holdUntil, and audits", async () => {
    memberFindFirstMock.mockResolvedValue({ id: "mem-1", name: "Sam", paymentStatus: "paid", stripeSubscriptionId: "sub_1", status: "active" });
    const { POST } = await import("@/app/api/members/[id]/hold/route");
    const res = await POST(req({ until: "2026-10-20T00:00:00.000Z" }), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, paymentStatus: "paused", holdUntil: "2026-10-20T00:00:00.000Z", stripePaused: true });
    expect(subscriptionsUpdateMock).toHaveBeenCalledWith(
      "sub_1",
      { pause_collection: { behavior: "void", resumes_at: Math.floor(Date.parse("2026-10-20T00:00:00Z") / 1000) } },
      { stripeAccount: "acct_gym" },
    );
    expect(memberUpdateManyMock).toHaveBeenCalledWith({ where: { id: "mem-1", tenantId: "tenant-A", paymentStatus: { not: "paused" } }, data: { paymentStatus: "paused", holdUntil: new Date("2026-10-20T00:00:00Z") } });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "member.hold.start", entityId: "mem-1", metadata: expect.objectContaining({ stripePaused: true, priorPaymentStatus: "paid" }) }));
  });

  it("a cash member (no subscription) is held locally with no Stripe call", async () => {
    memberFindFirstMock.mockResolvedValue({ id: "mem-1", name: "Sam", paymentStatus: "paid", stripeSubscriptionId: null, status: "active" });
    const { POST } = await import("@/app/api/members/[id]/hold/route");
    const res = await POST(req({}), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ holdUntil: null, stripePaused: false });
    expect(subscriptionsUpdateMock).not.toHaveBeenCalled();
    expect(memberUpdateManyMock).toHaveBeenCalledWith({ where: { id: "mem-1", tenantId: "tenant-A", paymentStatus: { not: "paused" } }, data: { paymentStatus: "paused", holdUntil: null } });
  });

  it("when Stripe refuses, nothing local changes and the owner is told", async () => {
    memberFindFirstMock.mockResolvedValue({ id: "mem-1", name: "Sam", paymentStatus: "paid", stripeSubscriptionId: "sub_1", status: "active" });
    subscriptionsUpdateMock.mockRejectedValue(new Error("No such subscription"));
    const { POST } = await import("@/app/api/members/[id]/hold/route");
    const res = await POST(req({}), params);
    expect(res.status).toBe(502);
    expect(memberUpdateMock).not.toHaveBeenCalled();
    expect(logAuditMock).not.toHaveBeenCalled();
  });

  it("two clicks at once: the second writer finds the row already paused, answers 409 and writes no audit row", async () => {
    // lh-4 C13.02 (25 Sep 2026): both requests read paymentStatus before either
    // wrote, so both succeeded and two hold audit rows appeared. The write is
    // now a compare-and-set on paymentStatus; count 0 is the losing click.
    memberFindFirstMock.mockResolvedValue({ id: "mem-1", name: "Sam", paymentStatus: "paid", stripeSubscriptionId: null, status: "active" });
    memberUpdateManyMock.mockResolvedValueOnce({ count: 0 });
    const { POST } = await import("@/app/api/members/[id]/hold/route");
    const res = await POST(req({}), params);
    expect(res.status).toBe(409);
    expect(logAuditMock).not.toHaveBeenCalled();
  });
  it("refuses a bad date, an already-held member, a cancelled member, and a member of another club", async () => {
    memberFindFirstMock.mockResolvedValue({ id: "mem-1", name: "Sam", paymentStatus: "paid", stripeSubscriptionId: null, status: "active" });
    const { POST } = await import("@/app/api/members/[id]/hold/route");
    expect((await POST(req({ until: "yesterday" }), params)).status).toBe(400);

    memberFindFirstMock.mockResolvedValue({ id: "mem-1", name: "Sam", paymentStatus: "paused", stripeSubscriptionId: null, status: "active" });
    expect((await POST(req({}), params)).status).toBe(409);

    memberFindFirstMock.mockResolvedValue({ id: "mem-1", name: "Sam", paymentStatus: "paid", stripeSubscriptionId: null, status: "cancelled" });
    expect((await POST(req({}), params)).status).toBe(409);

    memberFindFirstMock.mockResolvedValue(null);
    expect((await POST(req({}), params)).status).toBe(404);
    expect(memberUpdateMock).not.toHaveBeenCalled();
  });

  it("is owner/manager gated and CSRF checked", async () => {
    gateMock.mockResolvedValue({ ok: false, response: { status: 403, json: async () => ({}) } });
    const { POST } = await import("@/app/api/members/[id]/hold/route");
    expect((await POST(req({}), params)).status).toBe(403);
    gateMock.mockResolvedValue(OWNER);
    csrfMock.mockReturnValue({ status: 403, json: async () => ({}) });
    expect((await POST(req({}), params)).status).toBe(403);
    expect(memberFindFirstMock).not.toHaveBeenCalled();
  });
});

describe("POST /api/members/[id]/resume", () => {
  it("clears Stripe's pause first, then writes paid + no date, and audits", async () => {
    memberFindFirstMock.mockResolvedValue({ id: "mem-1", paymentStatus: "paused", holdUntil: new Date("2026-10-20T00:00:00Z"), stripeSubscriptionId: "sub_1" });
    const { POST } = await import("@/app/api/members/[id]/resume/route");
    const res = await POST(req(), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, paymentStatus: "paid", holdUntil: null, stripeResumed: true });
    expect(subscriptionsUpdateMock).toHaveBeenCalledWith("sub_1", { pause_collection: "" }, { stripeAccount: "acct_gym" });
    expect(memberUpdateMock).toHaveBeenCalledWith({ where: { id: "mem-1" }, data: { paymentStatus: "paid", holdUntil: null } });
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "member.hold.end", metadata: expect.objectContaining({ stripeResumed: true, holdUntil: "2026-10-20T00:00:00.000Z" }) }));
  });

  it("a member not on hold is a 409, and a Stripe refusal changes nothing", async () => {
    memberFindFirstMock.mockResolvedValue({ id: "mem-1", paymentStatus: "paid", holdUntil: null, stripeSubscriptionId: "sub_1" });
    const { POST } = await import("@/app/api/members/[id]/resume/route");
    expect((await POST(req(), params)).status).toBe(409);

    memberFindFirstMock.mockResolvedValue({ id: "mem-1", paymentStatus: "paused", holdUntil: null, stripeSubscriptionId: "sub_1" });
    subscriptionsUpdateMock.mockRejectedValue(new Error("boom"));
    expect((await POST(req(), params)).status).toBe(502);
    expect(memberUpdateMock).not.toHaveBeenCalled();
  });

  // Decision 1 (30 Sep 2026): a member who joined with "No payment yet" and was
  // held must not come back as "Paid".
  it("a MatFlow-billed member who has never paid comes back as No payment yet; one who has paid comes back paid", async () => {
    const { POST } = await import("@/app/api/members/[id]/resume/route");
    memberFindFirstMock.mockResolvedValue({ id: "mem-1", paymentStatus: "paused", holdUntil: null, stripeSubscriptionId: null, billedBy: "matflow" });
    paymentCountMock.mockResolvedValueOnce(0);
    expect(await (await POST(req(), params)).json()).toMatchObject({ paymentStatus: "pending" });
    expect(memberUpdateMock).toHaveBeenLastCalledWith({ where: { id: "mem-1" }, data: { paymentStatus: "pending", holdUntil: null } });
    paymentCountMock.mockResolvedValueOnce(2);
    expect(await (await POST(req(), params)).json()).toMatchObject({ paymentStatus: "paid" });
  });
});
