/**
 * lib/env-guards.ts and the mail-dark switch (7 Oct 2026).
 *
 * RESEND_API_KEY is a boot-time requirement in production because without it
 * resets, sign-in links and invites fail silently. With EMAIL_DELIVERY=off
 * nothing is sent by design, so the key is not needed and must not stop the
 * app booting — but the boot log has to say, loudly, that delivery is off.
 * With delivery on (or unset) the key stays required exactly as before.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { runProductionEnvGuards } from "@/lib/env-guards";

const OTHER_REQUIRED = {
  DATABASE_URL: "postgres://x",
  STRIPE_SECRET_KEY: "sk_test_x",
  STRIPE_WEBHOOK_SECRET: "whsec_x",
  STRIPE_CLIENT_ID: "ca_x",
};

let warn: { mock: { calls: unknown[][] }; mockRestore: () => void };

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PHASE", "");
  for (const [k, v] of Object.entries(OTHER_REQUIRED)) vi.stubEnv(k, v);
  vi.stubEnv("RESEND_API_KEY", "");
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  warn.mockRestore();
});

describe("env-guards — RESEND_API_KEY and EMAIL_DELIVERY", () => {
  it("still refuses to boot without RESEND_API_KEY when delivery is on (unset)", () => {
    vi.stubEnv("EMAIL_DELIVERY", "");
    expect(() => runProductionEnvGuards()).toThrow(/RESEND_API_KEY/);
  });

  it("still refuses to boot without RESEND_API_KEY when EMAIL_DELIVERY=on", () => {
    vi.stubEnv("EMAIL_DELIVERY", "on");
    expect(() => runProductionEnvGuards()).toThrow(/RESEND_API_KEY/);
  });

  it("boots without RESEND_API_KEY when EMAIL_DELIVERY=off, and warns that delivery is off", () => {
    vi.stubEnv("EMAIL_DELIVERY", "off");
    expect(() => runProductionEnvGuards()).not.toThrow();
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes("EMAIL_DELIVERY=off") && /NO email/i.test(l))).toBe(true);
  });

  it("warns that delivery is off even when the key IS set (production today)", () => {
    vi.stubEnv("EMAIL_DELIVERY", "off");
    vi.stubEnv("RESEND_API_KEY", "re_x");
    expect(() => runProductionEnvGuards()).not.toThrow();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("EMAIL_DELIVERY=off"))).toBe(true);
  });

  it("names an unrecognised EMAIL_DELIVERY value and says it is treated as off", () => {
    vi.stubEnv("EMAIL_DELIVERY", "false");
    expect(() => runProductionEnvGuards()).not.toThrow();
    expect(warn.mock.calls.some((c) => /not "on" or "off"/.test(String(c[0])))).toBe(true);
  });

  it("does not warn about delivery when it is on and the key is set", () => {
    vi.stubEnv("EMAIL_DELIVERY", "on");
    vi.stubEnv("RESEND_API_KEY", "re_x");
    expect(() => runProductionEnvGuards()).not.toThrow();
    expect(warn.mock.calls.some((c) => String(c[0]).includes("EMAIL_DELIVERY"))).toBe(false);
  });
});
