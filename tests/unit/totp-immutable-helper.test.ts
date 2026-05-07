/**
 * Unit guard for lib/totp-immutable.ts — the no-self-disable invariant
 * helper. Every PATCH/PUT route on User or Member must run stripTotpFields()
 * before forwarding to Prisma so a body like `{ totpEnabled: false }` cannot
 * bypass the security floor.
 */
import { describe, expect, it } from "vitest";
import { assertNoTotpFields, stripTotpFields } from "@/lib/totp-immutable";

describe("stripTotpFields", () => {
  it("removes the three TOTP fields from a body", () => {
    const out = stripTotpFields({
      name: "Noe",
      email: "noe@example.com",
      totpEnabled: false,
      totpSecret: null,
      totpRecoveryCodes: null,
    });
    expect(out).toEqual({ name: "Noe", email: "noe@example.com" });
    expect("totpEnabled" in out).toBe(false);
    expect("totpSecret" in out).toBe(false);
    expect("totpRecoveryCodes" in out).toBe(false);
  });

  it("returns a shallow copy (does not mutate input)", () => {
    const input = { name: "Noe", totpEnabled: false };
    const out = stripTotpFields(input);
    expect(input).toEqual({ name: "Noe", totpEnabled: false });
    expect(out).toEqual({ name: "Noe" });
  });

  it("is a no-op when no TOTP fields are present", () => {
    const out = stripTotpFields({ name: "Noe", phone: "+447" });
    expect(out).toEqual({ name: "Noe", phone: "+447" });
  });

  it("removes only TOTP fields, never adjacent fields", () => {
    const out = stripTotpFields({
      totpEnabledOther: true,
      totpFakeField: "x",
      totpEnabled: false,
    });
    expect(out).toEqual({ totpEnabledOther: true, totpFakeField: "x" });
  });
});

describe("assertNoTotpFields", () => {
  it("throws if any TOTP field is present", () => {
    expect(() => assertNoTotpFields({ totpEnabled: false })).toThrow(/totpEnabled/);
    expect(() => assertNoTotpFields({ totpSecret: "abc" })).toThrow(/totpSecret/);
    expect(() => assertNoTotpFields({ totpRecoveryCodes: [] })).toThrow(/totpRecoveryCodes/);
  });

  it("throws once with all detected field names", () => {
    expect(() =>
      assertNoTotpFields({ totpEnabled: false, totpSecret: null }),
    ).toThrow(/totpEnabled, totpSecret/);
  });

  it("does not throw when body has no TOTP fields", () => {
    expect(() => assertNoTotpFields({ name: "Noe" })).not.toThrow();
    expect(() => assertNoTotpFields({})).not.toThrow();
  });
});
