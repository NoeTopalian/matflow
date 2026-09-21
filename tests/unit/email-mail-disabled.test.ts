/**
 * Mail-disabled short-circuit in lib/email.ts.
 *
 * When RESEND_API_KEY is unset (the test environment, or a deliberately
 * mail-dark deploy) sendEmail must record the outcome with a SINGLE EmailLog
 * write and return — no bounce lookup, no "queued"→"failed" update, no Resend
 * call. The three-round-trip path this replaces was real connection-pool
 * pressure under a burst of email-bearing requests and surfaced as intermittent
 * 502s on /api/apply during the assess loop.
 *
 * Own file (not folded into email-bounce-short-circuit) because getResendClient
 * memoises per module process: a sibling test that constructs a client with a
 * key first would poison the cache, so this needs a fresh module with the key
 * unset from the start.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const { findFirstMock, createMock, updateMock, resendSendMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn().mockResolvedValue({}),
  resendSendMock: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = { send: (args: unknown) => resendSendMock(args) };
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({
      emailLog: { findFirst: findFirstMock, create: createMock, update: updateMock },
    })),
}));

import { sendEmail } from "@/lib/email";

const ARGS = {
  tenantId: "t-1",
  templateId: "magic_link" as const,
  to: "x@example.com",
  vars: { gymName: "G", link: "https://example.com/x", expiresIn: "30 minutes" },
};

beforeEach(() => {
  findFirstMock.mockReset();
  createMock.mockReset();
  resendSendMock.mockReset();
  delete process.env.RESEND_API_KEY;
});

describe("lib/email.ts — mail-disabled short-circuit (no RESEND_API_KEY)", () => {
  it("writes ONE EmailLog row and skips the bounce lookup and Resend entirely", async () => {
    createMock.mockResolvedValueOnce({ id: "log-nomail" });

    const result = await sendEmail(ARGS);

    expect(result).toEqual({ ok: false, logId: "log-nomail" });
    // Red-on-revert: the pre-fix path runs the bounce findFirst BEFORE the
    // client check, so reverting the short-circuit makes this fail.
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "t-1",
        recipient: "x@example.com",
        status: "failed",
        errorMessage: expect.stringContaining("not configured"),
      }),
    });
  });
});
