/**
 * Test recipient allowlist (lib/email-delivery.ts, lib/email.ts), 17 Oct 2026.
 *
 * In test mode — EMAIL_DELIVERY=test, or `on`/unset anywhere that is not
 * production — only EMAIL_TEST_RECIPIENTS receive mail. A recipient outside the
 * list is stopped in sendEmail before any lookup and before the Resend client
 * is built or called; an empty or missing list sends nothing. Production `on`
 * is unchanged. The Resend client is mocked: this is simulated evidence.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";

const { createMock, updateMock, findFirstMock, resendSendMock, resendCtorMock, userFindFirstMock } = vi.hoisted(() => ({
  createMock: vi.fn(),
  updateMock: vi.fn().mockResolvedValue({}),
  findFirstMock: vi.fn().mockResolvedValue(null),
  resendSendMock: vi.fn(),
  resendCtorMock: vi.fn(),
  userFindFirstMock: vi.fn().mockResolvedValue(null),
}));

vi.mock("resend", () => ({
  Resend: class MockResend {
    constructor(key: string) { resendCtorMock(key); }
    emails = { send: (args: unknown) => resendSendMock(args) };
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn({
      emailLog: { findFirst: findFirstMock, create: createMock, update: updateMock },
      tenant: { findUnique: vi.fn().mockResolvedValue({ contactEmail: null, billingContactEmail: null }) },
    })),
  withRlsBypass: (fn: (tx: unknown) => unknown) => Promise.resolve(fn({ user: { findFirst: userFindFirstMock } })),
}));

import { sendEmail } from "@/lib/email";
import { emailSendingPolicy, isRecipientAllowed, emailDeliveryMode, suppressedMessage, EMAIL_NOT_ALLOWLISTED_MESSAGE } from "@/lib/email-delivery";

const ENV_KEYS = ["EMAIL_DELIVERY", "EMAIL_TEST_RECIPIENTS", "VERCEL_ENV", "DATABASE_URL", "RESEND_API_KEY"] as const;
const saved: Record<string, string | undefined> = {};
let seq = 0;

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.RESEND_API_KEY = "re_test_key";
  createMock.mockReset();
  createMock.mockImplementation(() => Promise.resolve({ id: `log-${++seq}` }));
  resendSendMock.mockReset();
  resendSendMock.mockResolvedValue({ data: { id: "re_1" }, error: null });
  resendCtorMock.mockReset();
  findFirstMock.mockClear();
  userFindFirstMock.mockClear();
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const send = (to: string) => sendEmail({ tenantId: "t1", templateId: "test", to, vars: {} });

describe("policy", () => {
  it("EMAIL_DELIVERY=test with a list → allowlist of exactly those addresses (case-insensitive)", () => {
    process.env.EMAIL_DELIVERY = "test";
    process.env.EMAIL_TEST_RECIPIENTS = " Noe.Test@Example.test , delivered@resend.dev, not-an-address ";
    const p = emailSendingPolicy();
    expect(p.kind).toBe("allowlist");
    expect(isRecipientAllowed(p, "noe.test@example.test")).toBe(true);
    expect(isRecipientAllowed(p, "DELIVERED@resend.dev")).toBe(true);
    expect(isRecipientAllowed(p, "not-an-address")).toBe(false);
    expect(isRecipientAllowed(p, "sean@example.test")).toBe(false);
    expect(emailDeliveryMode()).toBe("on"); // screens: mail can go out (to the list)
  });

  it("outside production, on/unset means test mode", () => {
    for (const v of [undefined, "on"]) {
      if (v) process.env.EMAIL_DELIVERY = v; else delete process.env.EMAIL_DELIVERY;
      for (const vercel of [undefined, "preview", "development"]) {
        if (vercel) process.env.VERCEL_ENV = vercel; else delete process.env.VERCEL_ENV;
        expect(emailSendingPolicy().kind).toBe("allowlist");
      }
    }
  });

  it("production on is unchanged: open (Vercel production or the production database)", () => {
    process.env.EMAIL_DELIVERY = "on";
    process.env.VERCEL_ENV = "production";
    expect(emailSendingPolicy().kind).toBe("open");
    delete process.env.VERCEL_ENV;
    process.env.DATABASE_URL = "postgresql://u:p@ep-bold-wave-abt39t7x-pooler.example/db";
    expect(emailSendingPolicy().kind).toBe("open");
  });

  it("off and unknown values stay off", () => {
    for (const v of ["off", "false", "0", "tset"]) {
      process.env.EMAIL_DELIVERY = v;
      expect(emailSendingPolicy().kind).toBe("off");
    }
  });

  it("the staff-facing message says test mode", () => {
    expect(suppressedMessage({ suppressed: "recipient_not_allowlisted" })).toBe(EMAIL_NOT_ALLOWLISTED_MESSAGE);
  });
});

describe("sendEmail enforcement (before the provider)", () => {
  it("an unauthorised recipient is blocked before any lookup and before Resend is built or called", async () => {
    process.env.EMAIL_DELIVERY = "test";
    process.env.EMAIL_TEST_RECIPIENTS = "noe.test@example.test";
    const r = await send("sean@example.test");
    expect(r).toMatchObject({ ok: false, suppressed: "recipient_not_allowlisted" });
    expect(resendCtorMock).not.toHaveBeenCalled();
    expect(resendSendMock).not.toHaveBeenCalled();
    expect(userFindFirstMock).not.toHaveBeenCalled();
    expect(findFirstMock).not.toHaveBeenCalled();
    expect(createMock).toHaveBeenCalledWith({ data: expect.objectContaining({ status: "suppressed", errorMessage: expect.stringMatching(/^suppressed_not_allowlisted/) }) });
  });

  it("an empty or missing list blocks everyone (fail closed)", async () => {
    process.env.EMAIL_DELIVERY = "test";
    for (const list of [undefined, "", " , ", "not-an-address"]) {
      if (list === undefined) delete process.env.EMAIL_TEST_RECIPIENTS; else process.env.EMAIL_TEST_RECIPIENTS = list;
      expect((await send("noe.test@example.test")).suppressed).toBe("recipient_not_allowlisted");
    }
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("outside production with delivery left on and no list, nothing is sent", async () => {
    process.env.EMAIL_DELIVERY = "on";
    expect((await send("anyone@example.test")).suppressed).toBe("recipient_not_allowlisted");
    expect(resendSendMock).not.toHaveBeenCalled();
  });

  it("an authorised recipient is sent to exactly that address and nobody else", async () => {
    process.env.EMAIL_DELIVERY = "test";
    process.env.EMAIL_TEST_RECIPIENTS = "noe.test@example.test";
    const r = await send("Noe.Test@example.test");
    expect(r.ok).toBe(true);
    expect(resendSendMock).toHaveBeenCalledTimes(1);
    const args = resendSendMock.mock.calls[0][0] as Record<string, unknown>;
    expect(args.to).toBe("Noe.Test@example.test");
    expect(args).not.toHaveProperty("cc");
    expect(args).not.toHaveProperty("bcc");
  });
});

describe("static guard: one sending boundary", () => {
  it("only lib/email.ts calls Resend, and no code passes cc / bcc / batch sends", () => {
    const root = path.resolve(__dirname, "../..");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
        const rel = `${d}/${e.name}`;
        if (e.isDirectory()) walk(rel);
        else if (/\.(ts|tsx|mjs|js)$/.test(e.name)) files.push(rel);
      }
    };
    for (const d of ["app", "lib", "components", "scripts"]) walk(d);
    const offenders = files.filter((f) => {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      if (/\bemails\.send\s*\(|\bbatch\.send\s*\(|new Resend\s*\(/.test(src) && f !== "lib/email.ts") return true;
      return f === "lib/email.ts" && /\b(cc|bcc)\s*:/.test(src);
    });
    expect(offenders).toEqual([]);
  });
});
