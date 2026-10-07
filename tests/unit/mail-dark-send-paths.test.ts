/**
 * Mail-dark across the send paths (handover story US-003, 7 Oct 2026).
 *
 * With EMAIL_DELIVERY=off and a Resend key PRESENT (production today), every
 * route here runs against the REAL lib/email.ts with the Resend client mocked:
 *
 *   - zero Resend client constructions and zero sends, across all of them;
 *   - routes that would mint a credential only to email it (bulk invite, kiosk
 *     waiver link) refuse BEFORE touching a token, and say email is off;
 *     owner activation (approve) creates the club but mints no activation
 *     token, and says so;
 *   - routes that do send (chase, test email) surface
 *     "not sent" rather than success, and leave a "suppressed" EmailLog row;
 *   - the public club lookup tells the login screen that delivery is off.
 *
 * The database is a recording proxy: every `tx.<model>.<method>` call is
 * logged, answered by a per-test handler or a neutral default.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => {
  const calls: { op: string; args: unknown }[] = [];
  const handlers: Record<string, (args: unknown) => unknown> = {};
  const tx: unknown = new Proxy({}, {
    get: (_t, model) => new Proxy({}, {
      get: (_m, method) => async (args: unknown) => {
        const op = `${String(model)}.${String(method)}`;
        calls.push({ op, args });
        if (handlers[op]) return handlers[op](args);
        if (method === "create") return { id: `${String(model)}-1`, ...((args as { data?: object })?.data ?? {}) };
        if (method === "updateMany") return { count: 0 };
        if (method === "findMany") return [];
        return null;
      },
    }),
  });
  return {
    calls,
    handlers,
    tx,
    resendCtor: vi.fn(),
    resendSend: vi.fn<(args: unknown) => Promise<{ data: { id: string }; error: null }>>(async () => ({ data: { id: "re_1" }, error: null })),
    logAudit: vi.fn(async () => undefined),
  };
});

vi.mock("resend", () => ({
  Resend: class MockResend {
    constructor(key: string) { h.resendCtor(key); }
    emails = { send: (args: unknown) => h.resendSend(args) };
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: h.tx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) => Promise.resolve(fn(h.tx)),
  withRlsBypass: (fn: (tx: unknown) => unknown) => Promise.resolve(fn(h.tx)),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: vi.fn(async () => ({ ok: true, tenantId: "t-md", userId: "u-md", role: "owner", session: {} })),
  requireApiOwner: vi.fn(async () => ({ ok: true, tenantId: "t-md", userId: "u-md", role: "owner", session: {} })),
}));
vi.mock("@/lib/support-session", () => ({ refuseSupportSession: () => null }));
vi.mock("@/lib/review-lock", () => ({ refuseIfReviewLocked: async () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: () => "203.0.113.7",
}));
vi.mock("@/lib/token-hash", () => ({ hashToken: (s: string) => `hash:${s.length}` }));
vi.mock("@/lib/kiosk-token", () => ({ verifyKioskMemberToken: () => ({ ok: true, memberId: "m-md" }) }));
vi.mock("@/lib/operator-context", () => ({
  getOperatorContext: vi.fn(async () => ({ authed: true, operatorId: "op-md", operatorEmail: "op@example.com" })),
}));
vi.mock("@/lib/env-url", () => ({ getBaseUrl: () => "https://app.example.test" }));
vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => new Response(JSON.stringify({ ok: false, error: msg }), { status }),
}));

import { POST as bulkInvite } from "@/app/api/members/bulk-invite/route";
import { POST as kioskRequest } from "@/app/api/waiver/kiosk-request/route";
import { POST as chase } from "@/app/api/payments/chase/route";
import { POST as testEmail } from "@/app/api/admin/email/test/route";
import { POST as approve } from "@/app/api/admin/applications/[id]/approve/route";
import { GET as tenantLookup } from "@/app/api/tenant/[slug]/route";
import { EMAIL_OFF_MESSAGE } from "@/lib/email-delivery";

function post(url: string, body: unknown): Request {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}
const ops = () => h.calls.map((c) => c.op);
const emailLogRows = () =>
  h.calls.filter((c) => c.op === "emailLog.create").map((c) => (c.args as { data: Record<string, unknown> }).data);

beforeEach(() => {
  h.calls.length = 0;
  for (const k of Object.keys(h.handlers)) delete h.handlers[k];
  h.resendCtor.mockClear();
  h.resendSend.mockClear();
  h.logAudit.mockClear();
  process.env.RESEND_API_KEY = "re_present_in_production";
  process.env.EMAIL_DELIVERY = "off";
});

afterEach(() => {
  delete process.env.EMAIL_DELIVERY;
  // Across every test in this file the Resend client is never built or used.
  expect(h.resendCtor).not.toHaveBeenCalled();
  expect(h.resendSend).not.toHaveBeenCalled();
});

describe("EMAIL_DELIVERY=off — routes that only exist to email a credential refuse before minting it", () => {
  it("bulk invite: 409, says email is off, points at the invite link, touches no token or member", async () => {
    const res = await bulkInvite(post("http://localhost/api/members/bulk-invite", {}));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error).toContain(EMAIL_OFF_MESSAGE);
    expect(body.error).toMatch(/Show invite link/);
    expect(body.invited).toBe(0);
    expect(ops().filter((o) => o.startsWith("magicLinkToken.") || o.startsWith("member."))).toEqual([]);
  });

  it("kiosk waiver link: 503 with the email-off reason, no token minted or retired", async () => {
    h.handlers["tenant.findFirst"] = () => ({ id: "t-md", name: "Mail Dark Gym" });
    const res = await kioskRequest(post("http://localhost/api/waiver/kiosk-request", {
      kioskDeviceToken: "d".repeat(32),
      kioskMemberToken: "m".repeat(16),
    }));
    const body = await res.json();
    expect(res.status).toBe(503);
    expect(body.error).toMatch(/Email is turned off for this club, so no waiver link was sent/);
    expect(body.maskedEmail).toBeUndefined();
    expect(ops().filter((o) => o.startsWith("magicLinkToken."))).toEqual([]);
  });
});

describe("EMAIL_DELIVERY=off — routes that send surface 'not sent', never success", () => {
  it("payment chase: 409 with the email-off sentence; audit records emailSent:false; suppressed log row", async () => {
    h.handlers["member.findFirst"] = () => ({ id: "m-md", name: "Jordan", email: "jordan@example.com", billedBy: null, tenant: { name: "Mail Dark Gym" } });
    h.handlers["payment.findFirst"] = () => ({ amountPence: 4000, currency: "GBP" });
    const res = await chase(post("http://localhost/api/payments/chase", { memberId: "m-md" }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toContain(EMAIL_OFF_MESSAGE);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "payment.chase",
      metadata: expect.objectContaining({ emailSent: false, suppressed: "delivery_off" }),
    }));
    expect(emailLogRows()).toEqual([expect.objectContaining({ status: "suppressed", templateId: "payment_failed" })]);
  });

  it("owner test email: 409 with the email-off sentence, not a 500 and not ok", async () => {
    const res = await testEmail(post("http://localhost/api/admin/email/test", { to: "owner@example.com" }));
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.ok).toBe(false);
    expect(body.error).toBe(EMAIL_OFF_MESSAGE);
    expect(h.logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "email.test_sent" }));
  });

  // Review defect 5 (7 Oct 2026): with email off, approval mints NO activation
  // token (a live sign-in credential nobody can receive is only a liability)
  // and says so. History: this case used to expect a suppressed owner_activation
  // EmailLog row after the token had been minted.
  it("operator approval: the club is created, no activation token is minted, and the answer says so", async () => {
    h.handlers["gymApplication.findUnique"] = () => ({
      id: "app-md", status: "pending", gymName: "Mail Dark Gym", email: "Applicant@Example.com", contactName: "Ann",
    });
    h.handlers["tenant.create"] = () => ({ id: "t-new", users: [{ id: "u-new" }] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await approve(
      new Request("http://localhost/api/admin/applications/app-md/approve", { method: "POST" }),
      { params: Promise.resolve({ id: "app-md" }) },
    );
    const logged = warn.mock.calls.map((c) => String(c[0]));
    warn.mockRestore();
    const body = await res.json();
    expect(res.status).toBe(201);
    expect(body.activationEmailSent).toBe(false);
    expect(body.activationLinkCreated).toBe(false);
    expect(body.activationLink).toBeUndefined();
    expect(body.emailDelivery).toBe("off");
    expect(h.calls.filter((c) => c.op === "magicLinkToken.create")).toEqual([]);
    expect(emailLogRows()).toEqual([]);
    // Logged plainly, and never with a sign-in link.
    expect(logged.some((l) => l.includes("no activation link"))).toBe(true);
    expect(logged.some((l) => l.includes("magic-link/verify"))).toBe(false);
  });
});

describe("the login screen learns that email is off", () => {
  it("GET /api/tenant/[slug] carries emailDelivery: off (and on when the switch is unset)", async () => {
    h.handlers["tenant.findUnique"] = () => ({
      name: "Mail Dark Gym", slug: "maildark", logoUrl: null, primaryColor: "#000000", secondaryColor: "#000000",
      textColor: "#ffffff", bgColor: null, fontFamily: null, subscriptionStatus: "active", deletedAt: null,
    });
    const off = await tenantLookup(new Request("http://localhost/api/tenant/maildark"), { params: Promise.resolve({ slug: "maildark" }) });
    expect((await off.json()).emailDelivery).toBe("off");
    delete process.env.EMAIL_DELIVERY;
    const on = await tenantLookup(new Request("http://localhost/api/tenant/maildark"), { params: Promise.resolve({ slug: "maildark" }) });
    expect((await on.json()).emailDelivery).toBe("on");
  });
});
