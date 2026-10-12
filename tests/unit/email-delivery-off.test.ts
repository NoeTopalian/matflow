/**
 * The mail-dark switch (lib/email-delivery.ts, lib/email.ts) — handover story
 * US-003, 7 Oct 2026.
 *
 * Production carries RESEND_API_KEY, so "mail-dark" cannot mean "unset the
 * key" (lib/env-guards.ts refuses to boot without it while delivery is on).
 * EMAIL_DELIVERY=off is the switch: with it set, NO template reaches the Resend
 * client — the client is never even constructed — and each attempted send
 * leaves one EmailLog row at status "suppressed" with a reason, and a result
 * the caller can tell apart from both "sent" and "failed".
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { findFirstMock, createMock, updateMock, resendSendMock, resendCtorMock, userFindFirstMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn().mockResolvedValue({}),
  resendSendMock: vi.fn(),
  resendCtorMock: vi.fn(),
  userFindFirstMock: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class MockResend {
    constructor(key: string) { resendCtorMock(key); }
    emails = { send: (args: unknown) => resendSendMock(args) };
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({
      emailLog: { findFirst: findFirstMock, create: createMock, update: updateMock },
      tenant: { findUnique: vi.fn().mockResolvedValue({ contactEmail: null, billingContactEmail: null }) },
    })),
  // The provisional-recipient lookup spans EVERY club (review defect 8, 7 Oct
  // 2026): it runs only through withRlsBypass, so it is the only tx with `user`.
  withRlsBypass: (fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({ user: { findFirst: userFindFirstMock } })),
}));

import { sendEmail } from "@/lib/email";
import { emailDeliveryMode, isEmailDeliveryOn, emailDeliveryMisconfigured, suppressedMessage, EMAIL_OFF_MESSAGE } from "@/lib/email-delivery";

// Every template lib/email.ts can render. Kept in step with its TemplateId
// union; a template missing here is a send path this test does not cover.
const ALL_TEMPLATES = [
  "welcome", "payment_failed", "payment_failed_owner", "dispute_opened_owner", "stripe_disconnected_owner",
  "password_reset", "import_complete", "test", "magic_link", "application_received", "application_internal",
  "invite_member", "csv_handoff_internal", "owner_activation", "login_new_device", "rank_promoted", "rank_demoted",
  "member_action_assigned", "kiosk_waiver", "refund_processed", "dispute_created", "receipt",
] as const;

const VARS: Record<string, string> = {
  memberName: "M", gymName: "G", loginUrl: "https://x", portalUrl: "https://x", amount: "£1", code: "123456",
  ownerName: "O", importedCount: "1", skippedCount: "0", newRankName: "Blue", coachName: "C", reason: "r",
  message: "m", link: "https://x", expiresIn: "30 minutes", contactName: "C", email: "a@b.c", phone: "1",
  discipline: "BJJ", memberCount: "10", notes: "", memberEmail: "a@b.c", dashboardUrl: "https://x",
  customerName: "C", evidenceDueBy: "", clubCode: "g", when: "now", ipApprox: "x", uaSummary: "x",
  disownLink: "https://x", fromName: "", title: "T", body: "", actionUrl: "https://x", subscriptionNote: "",
  description: "d", paidDate: "today", evidenceDue: "", paymentsUrl: "https://x", tenantSlug: "g",
  fileName: "f.csv", fileSizeKb: "1", jobId: "j",
};

let logSeq = 0;

beforeEach(() => {
  findFirstMock.mockReset();
  createMock.mockReset();
  createMock.mockImplementation(() => Promise.resolve({ id: `log-${++logSeq}` }));
  updateMock.mockReset();
  updateMock.mockResolvedValue({});
  resendSendMock.mockReset();
  resendSendMock.mockResolvedValue({ data: { id: "re_1" }, error: null });
  resendCtorMock.mockReset();
  userFindFirstMock.mockReset();
  userFindFirstMock.mockResolvedValue(null);
  process.env.RESEND_API_KEY = "re_test_key";
});

afterEach(() => {
  delete process.env.EMAIL_DELIVERY;
});

describe("EMAIL_DELIVERY mode parsing", () => {
  it("defaults to on when unset or empty, so existing environments keep sending", () => {
    delete process.env.EMAIL_DELIVERY;
    expect(emailDeliveryMode()).toBe("on");
    process.env.EMAIL_DELIVERY = "";
    expect(isEmailDeliveryOn()).toBe(true);
    process.env.EMAIL_DELIVERY = " ON ";
    expect(isEmailDeliveryOn()).toBe(true);
    expect(emailDeliveryMisconfigured()).toBe(false);
  });

  it("treats off, and any unrecognised value, as off (fail closed)", () => {
    for (const v of ["off", "OFF", "false", "0", "no", "of"]) {
      process.env.EMAIL_DELIVERY = v;
      expect(emailDeliveryMode(), v).toBe("off");
    }
    process.env.EMAIL_DELIVERY = "false";
    expect(emailDeliveryMisconfigured()).toBe(true);
    process.env.EMAIL_DELIVERY = "off";
    expect(emailDeliveryMisconfigured()).toBe(false);
  });
});

describe("sendEmail with EMAIL_DELIVERY=off", () => {
  it("never constructs or calls the Resend client, for every template", async () => {
    process.env.EMAIL_DELIVERY = "off";
    for (const templateId of ALL_TEMPLATES) {
      const r = await sendEmail({ tenantId: "t-1", templateId, to: "someone@example.com", vars: VARS });
      expect(r.ok, templateId).toBe(false);
      expect(r.suppressed, templateId).toBe("delivery_off");
    }
    expect(resendCtorMock).not.toHaveBeenCalled();
    expect(resendSendMock).not.toHaveBeenCalled();
    // One suppressed log row per attempted send; no bounce lookup, no update.
    expect(createMock).toHaveBeenCalledTimes(ALL_TEMPLATES.length);
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("writes a suppressed EmailLog row with a clear reason and returns a not-sent result", async () => {
    process.env.EMAIL_DELIVERY = "off";
    const r = await sendEmail({ tenantId: "t-1", templateId: "invite_member", to: "m@example.com", vars: VARS });
    expect(r).toEqual({ ok: false, logId: expect.stringMatching(/^log-/), suppressed: "delivery_off" });
    expect(createMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "t-1",
        templateId: "invite_member",
        recipient: "m@example.com",
        status: "suppressed",
        errorMessage: expect.stringContaining("suppressed_delivery_off"),
      }),
    });
    expect(suppressedMessage(r)).toBe(EMAIL_OFF_MESSAGE);
  });

  it("an unrecognised value also suppresses (a typo never turns mail on)", async () => {
    process.env.EMAIL_DELIVERY = "false";
    const r = await sendEmail({ tenantId: "t-1", templateId: "receipt", to: "m@example.com", vars: VARS });
    expect(r.suppressed).toBe("delivery_off");
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("suppresses even when RESEND_API_KEY is unset, recording it as suppressed rather than failed", async () => {
    process.env.EMAIL_DELIVERY = "off";
    delete process.env.RESEND_API_KEY;
    const r = await sendEmail({ tenantId: "t-1", templateId: "test", to: "m@example.com", vars: VARS });
    expect(r.suppressed).toBe("delivery_off");
    expect(createMock.mock.calls[0][0].data.status).toBe("suppressed");
  });
});

describe("sendEmail — provisional login email recipient (delivery ON)", () => {
  it("suppresses any template to a provisional login address, logs suppressed_provisional, never calls Resend", async () => {
    delete process.env.EMAIL_DELIVERY;
    userFindFirstMock.mockResolvedValue({ id: "u-owner", loginEmailProvisionalSince: new Date("2026-10-07T00:00:00Z") });
    for (const templateId of ["password_reset", "magic_link", "import_complete", "payment_failed_owner", "invite_member"] as const) {
      const r = await sendEmail({ tenantId: "t-1", templateId, to: "Provisional@Example.com", vars: VARS });
      expect(r, templateId).toEqual({ ok: false, logId: expect.any(String), suppressed: "provisional_recipient" });
    }
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        status: "suppressed",
        errorMessage: expect.stringContaining("suppressed_provisional"),
      }),
    });
    // The lookup is case-insensitive on the address and spans EVERY club: an
    // address provisional in any club receives nothing (review defect 8).
    expect(userFindFirstMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        email: { equals: "Provisional@Example.com", mode: "insensitive" },
        loginEmailProvisionalSince: { not: null },
      }),
    }));
    for (const call of userFindFirstMock.mock.calls) {
      expect((call[0] as { where: Record<string, unknown> }).where).not.toHaveProperty("tenantId");
    }
  });

  it("system mail (_system tenant) to an address provisional in a club is suppressed too", async () => {
    delete process.env.EMAIL_DELIVERY;
    userFindFirstMock.mockResolvedValue({ id: "u-owner", loginEmailProvisionalSince: new Date("2026-10-07T00:00:00Z") });
    const r = await sendEmail({ tenantId: "_system", templateId: "application_received", to: "owner@club.example", vars: VARS });
    expect(r).toEqual({ ok: false, logId: expect.any(String), suppressed: "provisional_recipient" });
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("fails closed: if the provisional check cannot run, nothing is sent", async () => {
    delete process.env.EMAIL_DELIVERY;
    userFindFirstMock.mockRejectedValue(new Error("db down"));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await sendEmail({ tenantId: "t-1", templateId: "test", to: "m@example.com", vars: VARS });
    errSpy.mockRestore();
    expect(r.ok).toBe(false);
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("a verified (non-provisional) address still sends", async () => {
    delete process.env.EMAIL_DELIVERY;
    userFindFirstMock.mockResolvedValue(null);
    const r = await sendEmail({ tenantId: "t-1", templateId: "test", to: "m@example.com", vars: VARS });
    expect(r.ok).toBe(true);
    expect(resendSendMock).toHaveBeenCalledTimes(1);
  });
});

describe("sendEmail with delivery on (control)", () => {
  it("sends through Resend as before", async () => {
    delete process.env.EMAIL_DELIVERY;
    const r = await sendEmail({ tenantId: "t-1", templateId: "test", to: "m@example.com", vars: VARS });
    expect(r.ok).toBe(true);
    expect(r.suppressed).toBeUndefined();
    expect(resendSendMock).toHaveBeenCalledTimes(1);
  });
});
