/**
 * Resend webhook handler — unit guard.
 *
 * Asserts the signature verification + status-rank guard logic. Mocks Prisma
 * + the svix Webhook so the test runs without a DB and without spinning up
 * the actual Svix verifier.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const { svixVerifyMock, findUniqueMock, updateMock } = vi.hoisted(() => ({
  svixVerifyMock: vi.fn(),
  findUniqueMock: vi.fn(),
  updateMock: vi.fn().mockResolvedValue({}),
}));

// Mock svix.Webhook as a class whose instances expose svixVerifyMock as
// `verify`. Defined as a real class (not vi.fn().mockImplementation) so the
// `new Webhook(secret)` invocation in the route reliably gets a usable
// instance regardless of vitest mock-reset behaviour.
vi.mock("svix", () => ({
  Webhook: class MockWebhook {
    verify(...args: unknown[]) {
      return svixVerifyMock(...args);
    }
  },
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: (fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({
      emailLog: {
        findUnique: findUniqueMock,
        update: updateMock,
      },
    })),
}));

beforeEach(() => {
  // mockReset (not just clearAllMocks) flushes the .mockResolvedValueOnce
  // queue too — otherwise unused queued values from one test bleed into the
  // next when an early-return path skips findUnique.
  findUniqueMock.mockReset();
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
  svixVerifyMock.mockReset();
  process.env.RESEND_WEBHOOK_SECRET = "whsec_test";
  // NODE_ENV is typed read-only by @types/node; cast to widen so we can flip
  // it for the "503 in production when secret unset" assertion.
  (process.env as Record<string, string>).NODE_ENV = "production";
});

function makeReq(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/webhooks/resend", {
    method: "POST",
    headers: {
      "svix-id": "msg_test_1",
      "svix-timestamp": String(Math.floor(Date.now() / 1000)),
      "svix-signature": "v1,test-signature",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/webhooks/resend — signature verification", () => {
  it("returns 401 when svix.verify throws", async () => {
    svixVerifyMock.mockImplementationOnce(() => { throw new Error("bad sig"); });
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const res = await POST(makeReq({ type: "email.delivered", data: { email_id: "x" } }));
    expect(res.status).toBe(401);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns 503 in production when RESEND_WEBHOOK_SECRET is unset", async () => {
    delete process.env.RESEND_WEBHOOK_SECRET;
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const res = await POST(makeReq({ type: "email.delivered", data: { email_id: "x" } }));
    expect(res.status).toBe(503);
  });
});

describe("POST /api/webhooks/resend — event mapping", () => {
  beforeEach(() => {
    svixVerifyMock.mockReturnValue(undefined); // pass verification
  });

  it("updates EmailLog status=delivered for email.delivered", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "log-1", status: "sent" });
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const res = await POST(makeReq({ type: "email.delivered", data: { email_id: "resend-abc" } }));
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "log-1" },
      data: { status: "delivered" },
    });
  });

  it("updates EmailLog status=bounced + captures bounce reason", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "log-2", status: "sent" });
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const res = await POST(makeReq({
      type: "email.bounced",
      data: {
        email_id: "resend-xyz",
        bounce: { type: "Permanent", subType: "MailboxDoesNotExist", message: "550 5.1.1" },
      },
    }));
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "log-2" },
      data: {
        status: "bounced",
        errorMessage: "Permanent — MailboxDoesNotExist — 550 5.1.1",
      },
    });
  });

  it("updates EmailLog status=complained for email.complained", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "log-3", status: "delivered" });
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const res = await POST(makeReq({ type: "email.complained", data: { email_id: "resend-c" } }));
    expect(res.status).toBe(200);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "log-3" },
      data: { status: "complained", errorMessage: "Recipient marked as spam" },
    });
  });

  it("does NOT downgrade complained → delivered (out-of-order events)", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "log-4", status: "complained" });
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const res = await POST(makeReq({ type: "email.delivered", data: { email_id: "resend-d" } }));
    expect(res.status).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("ignores email.opened (visibility-only, not stored)", async () => {
    findUniqueMock.mockResolvedValueOnce({ id: "log-5", status: "delivered" });
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const res = await POST(makeReq({ type: "email.opened", data: { email_id: "resend-o" } }));
    expect(res.status).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("acks gracefully when email_id is missing", async () => {
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const res = await POST(makeReq({ type: "email.delivered", data: {} }));
    expect(res.status).toBe(200);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("acks gracefully when EmailLog row not found", async () => {
    findUniqueMock.mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/webhooks/resend/route");
    const res = await POST(makeReq({ type: "email.delivered", data: { email_id: "unknown" } }));
    expect(res.status).toBe(200);
    expect(updateMock).not.toHaveBeenCalled();
  });
});
