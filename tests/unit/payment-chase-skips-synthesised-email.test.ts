import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * POST /api/payments/chase must not "remind" a member who cannot receive mail.
 *
 * Found by lane L-C. `Member.email` is NOT NULL, so the `!email` guard only
 * ever caught the empty string — and a member with no address of their own does
 * not carry one. They carry a SYNTHESISED placeholder at
 * `@no-login.matflow.local` (lib/synthesise-kid-email.ts): a kid, a walk-in, an
 * older member who shares a family inbox. That looks like a real address, so
 * the guard waved it through, `sendEmail` queued a message into an RFC-2606
 * reserved domain, and the club believed it had chased someone it had not.
 *
 * The mail service is stubbed here, so the only thing under test is whether the
 * route decides to send at all.
 */

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { memberFindFirstMock, paymentFindFirstMock, sendEmailMock, logAuditMock } = vi.hoisted(() => ({
  memberFindFirstMock: vi.fn(),
  paymentFindFirstMock: vi.fn(),
  sendEmailMock: vi.fn(async () => ({ ok: true })),
  logAuditMock: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { findFirst: memberFindFirstMock },
      payment: { findFirst: paymentFindFirstMock },
    }),
}));

vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: vi.fn(async () => ({
    ok: true,
    tenantId: "tenant-A",
    userId: "user-owner-A",
    role: "owner",
  })),
}));

vi.mock("@/lib/email", () => ({ sendEmail: sendEmailMock }));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
vi.mock("@/lib/env-url", () => ({ getBaseUrl: () => "http://localhost:3000" }));
vi.mock("@/lib/api-error", () => ({
  apiError: (msg: string, status: number) => ({
    status,
    json: async () => ({ ok: false, error: msg }),
  }),
}));

import { POST } from "@/app/api/payments/chase/route";

function makeReq(body: unknown = { memberId: "member-1" }) {
  return new Request("http://localhost/api/payments/chase", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function member(email: string) {
  return { id: "member-1", name: "Jordan Example", email, tenant: { name: "Total BJJ" } };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendEmailMock.mockResolvedValue({ ok: true });
  paymentFindFirstMock.mockResolvedValue({ amountPence: 4000, currency: "GBP" });
});

describe("POST /api/payments/chase — a member who cannot receive mail", () => {
  it("skips the send for a synthesised kid address and says why", async () => {
    memberFindFirstMock.mockResolvedValueOnce(member("kid-0123456789abcdef@no-login.matflow.local"));

    const res = await POST(makeReq());
    const body = (await res.json()) as { error?: string };

    expect(res.status).toBe(422);
    expect(sendEmailMock).not.toHaveBeenCalled();
    expect(body.error).toMatch(/no email address/i);
  });

  it("skips it for an adult placeholder too — the DOMAIN is what decides", async () => {
    memberFindFirstMock.mockResolvedValueOnce(member("ADULT-FEEDFACE@No-Login.MatFlow.Local"));

    const res = await POST(makeReq());

    expect(res.status).toBe(422);
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it("still sends to a real address", async () => {
    memberFindFirstMock.mockResolvedValueOnce(member("jordan@example.com"));

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: "jordan@example.com", templateId: "payment_failed" }),
    );
  });

  it("does not mistake a lookalike domain for a placeholder", async () => {
    // `@no-login.matflow.local.example.com` is a real, deliverable address that
    // merely CONTAINS the reserved domain. Matching on `endsWith` is what keeps
    // this a send rather than a silent skip.
    memberFindFirstMock.mockResolvedValueOnce(member("bob@no-login.matflow.local.example.com"));

    const res = await POST(makeReq());

    expect(res.status).toBe(200);
    expect(sendEmailMock).toHaveBeenCalled();
  });
});
