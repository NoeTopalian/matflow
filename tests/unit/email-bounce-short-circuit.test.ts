/**
 * Regression guard for the bounce-aware short-circuit in lib/email.ts
 * (shipped in commit eb0b84d, audited in iteration 2).
 *
 * sendEmail must refuse to call Resend when the recipient hard-bounced or
 * marked us as spam within the BOUNCE_LOOKBACK_MS window (30 days). This
 * prevents reputation damage from repeatedly hammering a dead inbox or a
 * complainant. Skipped sends still write to EmailLog with status="failed"
 * for operator visibility.
 *
 * Operator-clear path: delete / update the offending EmailLog row.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const { findFirstMock, createMock, updateMock, resendSendMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn().mockResolvedValue({}),
  resendSendMock: vi.fn(),
}));

// Use a real class so `new Resend(apiKey)` works regardless of vitest mock-
// reset behaviour (vi.fn().mockImplementation gets stripped by clearAllMocks
// / resetAllMocks; a class declaration survives).
vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = { send: (args: unknown) => resendSendMock(args) };
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({
      emailLog: {
        findFirst: findFirstMock,
        create: createMock,
        update: updateMock,
      },
    })),
}));

import { sendEmail } from "@/lib/email";

const ARGS = {
  tenantId: "t-1",
  templateId: "magic_link" as const,
  to: "victim@example.com",
  vars: { gymName: "Test Gym", link: "https://example.com/x", expiresIn: "30 minutes" },
};

beforeEach(() => {
  findFirstMock.mockReset();
  createMock.mockReset();
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
  resendSendMock.mockReset();
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.RESEND_FROM = "MatFlow <noreply@matflow.studio>";
});

describe("lib/email.ts — bounce-aware short-circuit", () => {
  it("refuses to send when recipient bounced within the 30-day window", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: "log-bounce-1",
      status: "bounced",
      createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000), // 1 day ago
    });
    createMock.mockResolvedValueOnce({ id: "log-skipped" });

    const result = await sendEmail(ARGS);

    expect(result.ok).toBe(false);
    expect(result.logId).toBe("log-skipped");
    // Resend MUST NOT be called — that's the whole point
    expect(resendSendMock).not.toHaveBeenCalled();
    // The EmailLog row was created with status=failed + a clear errorMessage
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "t-1",
        recipient: "victim@example.com",
        status: "failed",
        errorMessage: expect.stringContaining("bounced"),
      }),
    });
  });

  it("refuses to send when recipient marked us as spam (complained) within the window", async () => {
    findFirstMock.mockResolvedValueOnce({
      id: "log-complaint-1",
      status: "complained",
      createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 days ago
    });
    createMock.mockResolvedValueOnce({ id: "log-skipped" });

    const result = await sendEmail(ARGS);

    expect(result.ok).toBe(false);
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: "failed",
        errorMessage: expect.stringContaining("complained"),
      }),
    });
  });

  it("queries EmailLog with the correct WHERE clause (tenantId + recipient + status + 30-day window)", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValueOnce({ id: "log-fresh" });
    resendSendMock.mockResolvedValueOnce({ data: { id: "resend-id-1" }, error: null });

    await sendEmail(ARGS);

    const call = findFirstMock.mock.calls[0]?.[0];
    expect(call).toMatchObject({
      where: {
        tenantId: "t-1",
        recipient: "victim@example.com",
        status: { in: ["bounced", "complained"] },
      },
    });
    // The createdAt window must be present and approximately 30 days back.
    const window = call?.where?.createdAt?.gte as Date | undefined;
    expect(window).toBeInstanceOf(Date);
    const ageMs = Date.now() - (window?.getTime() ?? 0);
    expect(ageMs).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
    expect(ageMs).toBeLessThan(31 * 24 * 60 * 60 * 1000);
  });

  it("happy path: no recent bounce → Resend is called normally + log gets status=sent", async () => {
    findFirstMock.mockResolvedValueOnce(null);
    createMock.mockResolvedValueOnce({ id: "log-ok" });
    resendSendMock.mockResolvedValueOnce({ data: { id: "resend-id-1" }, error: null });

    const result = await sendEmail(ARGS);

    expect(result.ok).toBe(true);
    expect(result.logId).toBe("log-ok");
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    expect(updateMock).toHaveBeenCalledWith({
      where: { id: "log-ok" },
      data: expect.objectContaining({ status: "sent", resendId: "resend-id-1" }),
    });
  });
});
