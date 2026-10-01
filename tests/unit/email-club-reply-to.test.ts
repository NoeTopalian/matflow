/**
 * Reply-To = the club's contact address on every email MatFlow sends ON THE
 * CLUB'S BEHALF (1 Oct 2026, "integrate it so the system understands this").
 *
 * All mail leaves from the single MatFlow sender (RESEND_FROM — Resend only
 * sends from verified domains), so a member who hits Reply on a receipt or a
 * reminder must land in the club's inbox, not MatFlow's no-reply void. The
 * club's address is Settings → Contact email (`Tenant.contactEmail`), falling
 * back to `billingContactEmail`. Owner alerts and operator/platform mail are
 * NOT club-voiced and carry no club Reply-To. An explicit `replyTo` always
 * wins (the magic-link route sets its own). An empty contact means no
 * Reply-To at all — never a dead address.
 *
 * Red on revert: remove the resolution in sendEmail and the first case fails.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

const { findFirstMock, createMock, updateMock, resendSendMock, tenantFindUnique } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  createMock: vi.fn(),
  updateMock: vi.fn().mockResolvedValue({}),
  resendSendMock: vi.fn(),
  tenantFindUnique: vi.fn(),
}));

vi.mock("resend", () => ({
  Resend: class MockResend {
    emails = { send: (args: unknown) => resendSendMock(args) };
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_tenantId: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(
      fn({
        emailLog: { findFirst: findFirstMock, create: createMock, update: updateMock },
        tenant: { findUnique: tenantFindUnique },
      }),
    ),
}));

import { sendEmail, CLUB_VOICED_TEMPLATES } from "@/lib/email";

// Every template reads different vars; the subject here is the envelope, not
// the body, so any string satisfies the renderers.
const VARS = new Proxy({} as Record<string, string>, { get: (_t, k) => (typeof k === "string" ? `v:${k}` : undefined) });

function sentArgs(): { replyTo?: string } {
  expect(resendSendMock).toHaveBeenCalledTimes(1);
  return resendSendMock.mock.calls[0][0] as { replyTo?: string };
}

beforeEach(() => {
  findFirstMock.mockReset().mockResolvedValue(null);
  createMock.mockReset().mockResolvedValue({ id: "log-1" });
  updateMock.mockReset().mockResolvedValue({});
  resendSendMock.mockReset().mockResolvedValue({ data: { id: "re_1" }, error: null });
  tenantFindUnique.mockReset().mockResolvedValue({ contactEmail: "info@totalbjj.co.uk", billingContactEmail: null });
  process.env.RESEND_API_KEY = "re_test_key";
  process.env.RESEND_FROM = "MatFlow Studio <noreply@matflow.studio>";
});

describe("sendEmail — club Reply-To", () => {
  it("a receipt carries Reply-To = the club's contact email", async () => {
    await sendEmail({ tenantId: "t-1", templateId: "receipt", to: "tom@example.com", vars: VARS });
    expect(sentArgs().replyTo).toBe("info@totalbjj.co.uk");
  });

  it("falls back to billingContactEmail when contactEmail is empty", async () => {
    tenantFindUnique.mockResolvedValue({ contactEmail: null, billingContactEmail: "billing@totalbjj.co.uk" });
    await sendEmail({ tenantId: "t-1", templateId: "payment_failed", to: "tom@example.com", vars: VARS });
    expect(sentArgs().replyTo).toBe("billing@totalbjj.co.uk");
  });

  it("no club address → no Reply-To at all (never a dead address)", async () => {
    tenantFindUnique.mockResolvedValue({ contactEmail: null, billingContactEmail: null });
    await sendEmail({ tenantId: "t-1", templateId: "receipt", to: "tom@example.com", vars: VARS });
    expect(sentArgs().replyTo).toBeUndefined();
  });

  it("an owner alert is not club-voiced and carries no club Reply-To", async () => {
    await sendEmail({ tenantId: "t-1", templateId: "payment_failed_owner", to: "sean@example.com", vars: VARS });
    expect(sentArgs().replyTo).toBeUndefined();
    expect(tenantFindUnique).not.toHaveBeenCalled();
  });

  it("an explicit replyTo always wins", async () => {
    await sendEmail({
      tenantId: "t-1",
      templateId: "receipt",
      to: "tom@example.com",
      vars: VARS,
      replyTo: "desk@totalbjj.co.uk",
    });
    expect(sentArgs().replyTo).toBe("desk@totalbjj.co.uk");
    expect(tenantFindUnique).not.toHaveBeenCalled();
  });

  it("a failed tenant lookup never blocks the send", async () => {
    tenantFindUnique.mockRejectedValue(new Error("db down"));
    const r = await sendEmail({ tenantId: "t-1", templateId: "receipt", to: "tom@example.com", vars: VARS });
    expect(r.ok).toBe(true);
    expect(sentArgs().replyTo).toBeUndefined();
  });

  it("the club-voiced set is exactly the member-facing templates", () => {
    expect([...CLUB_VOICED_TEMPLATES].sort()).toEqual(
      [
        "invite_member",
        "kiosk_waiver",
        "member_action_assigned",
        "payment_failed",
        "rank_demoted",
        "rank_promoted",
        "receipt",
        "refund_processed",
        "welcome",
      ].sort(),
    );
  });
});
