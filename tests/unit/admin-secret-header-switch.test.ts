/**
 * Lane L-G round 1, defect 2 — the `x-admin-secret` door, made switchable.
 *
 * The door is NOT removed: scripts and the owner's own tooling use it, and
 * closing it is the owner's decision. What this pins is that the decision is
 * now possible, that the default is exactly today's behaviour, and that
 * turning it off leaves the two cookie paths untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
}));

vi.mock("@/lib/operator-auth", () => ({
  OP_SESSION_COOKIE: "matflow_op_session",
  resolveOperatorFromCookie: vi.fn(async () => null),
}));

import { adminSecretHeaderAllowed, checkAdminHeader, isAdminAuthed } from "@/lib/admin-auth";

const SECRET = "test-only-admin-secret-value";
const original = { ...process.env };

function reqWithHeader(value?: string): Request {
  return new Request("http://localhost:3847/api/admin/activity", {
    headers: value === undefined ? {} : { "x-admin-secret": value },
  });
}

beforeEach(() => {
  process.env.MATFLOW_ADMIN_SECRET = SECRET;
  delete process.env.ALLOW_ADMIN_SECRET_HEADER;
});

afterEach(() => {
  process.env = { ...original };
});

describe("ALLOW_ADMIN_SECRET_HEADER", () => {
  it("defaults to ALLOWED — unset is today's behaviour, unchanged", () => {
    expect(adminSecretHeaderAllowed()).toBe(true);
    expect(checkAdminHeader(reqWithHeader(SECRET))).toBe(true);
  });

  it("an empty string is still allowed — an unset var in a .env file is not a decision", () => {
    process.env.ALLOW_ADMIN_SECRET_HEADER = "";
    expect(adminSecretHeaderAllowed()).toBe(true);
    expect(checkAdminHeader(reqWithHeader(SECRET))).toBe(true);
  });

  it.each(["0", "false", "off", "no", "OFF", " False "])(
    "%s closes the door: the correct secret in the header no longer authenticates",
    (flag) => {
      process.env.ALLOW_ADMIN_SECRET_HEADER = flag;
      expect(adminSecretHeaderAllowed()).toBe(false);
      expect(checkAdminHeader(reqWithHeader(SECRET))).toBe(false);
    },
  );

  it.each(["1", "true", "yes", "on"])("%s keeps the door open", (flag) => {
    process.env.ALLOW_ADMIN_SECRET_HEADER = flag;
    expect(adminSecretHeaderAllowed()).toBe(true);
    expect(checkAdminHeader(reqWithHeader(SECRET))).toBe(true);
  });

  it("a wrong secret is refused whether the door is open or shut", () => {
    expect(checkAdminHeader(reqWithHeader("wrong"))).toBe(false);
    process.env.ALLOW_ADMIN_SECRET_HEADER = "0";
    expect(checkAdminHeader(reqWithHeader("wrong"))).toBe(false);
  });

  it("a missing header is false, and a missing env secret is false", () => {
    expect(checkAdminHeader(reqWithHeader())).toBe(false);
    delete process.env.MATFLOW_ADMIN_SECRET;
    expect(checkAdminHeader(reqWithHeader(SECRET))).toBe(false);
  });

  it("with the door shut, isAdminAuthed falls through to the cookie paths rather than granting", async () => {
    process.env.ALLOW_ADMIN_SECRET_HEADER = "0";
    // No cookies are present (both cookie sources are mocked empty), so the
    // only credential on offer is the header — and it must not be enough.
    await expect(isAdminAuthed(reqWithHeader(SECRET))).resolves.toBe(false);
  });

  it("with the door open, isAdminAuthed grants on the header alone — the behaviour being reported, not changed", async () => {
    await expect(isAdminAuthed(reqWithHeader(SECRET))).resolves.toBe(true);
  });
});
