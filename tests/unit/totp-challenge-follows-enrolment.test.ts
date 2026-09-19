// The second factor follows ENROLMENT, not rank.
//
// Approved by Noe, 19 Sep 2026: "anyone ENROLLED is challenged at sign-in,
// whatever their role; TOTP remains mandatory for no one but the owner-nudge
// stays as is."
//
// What it was before: `auth.ts` minted
//
//     totpPending: !isTestingMode() && isOwner && user.totpEnabled === true
//
// at BOTH staff sign-in sites (the password door and the Google door). Any
// staff role may enrol — `app/api/auth/totp/setup/route.ts` has no role gate —
// so a manager, coach or admin could scan the QR, store a secret on their own
// row, watch the dashboard nudge clear, and never once be asked for a code.
// The second factor existed in the database and nowhere in the door. Members
// (`auth.ts`, the `memberRow` branch) were challenged correctly all along, so
// the two populations were precisely inverted.
//
// This file reaches the REAL `authorize`, by the same route as
// `e2e-bypass-no-owner-escalation.test.ts` beside it: `auth.ts` builds the
// callback inline inside `NextAuth({ … })`, so nothing exports it and nothing
// could test it. Mocking `next-auth` and the credentials provider to capture
// the config object is what makes the branch reachable.
//
// `isTestingMode()` is mocked FALSE here, deliberately: it is the other half of
// the same expression, and the campaign runner has it true — which is exactly
// why no e2e run could ever have caught this.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import bcrypt from "bcryptjs";

type Authorize = (
  credentials: Record<string, unknown>,
  request: Request,
) => Promise<Record<string, unknown> | null>;

const captured: { authorize?: Authorize } = {};

vi.mock("next-auth", () => ({
  default: (config: { providers: { authorize?: Authorize }[] }) => {
    for (const p of config.providers) if (p?.authorize) captured.authorize = p.authorize;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({
  default: (cfg: { authorize?: Authorize }) => cfg,
}));
vi.mock("next-auth/providers/google", () => ({ default: (cfg: unknown) => cfg }));

const { tenantFindUnique, userFindUnique, memberFindUnique } = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
}));

const tx = {
  tenant: { findUnique: tenantFindUnique },
  user: { findUnique: userFindUnique, findFirst: vi.fn(), update: vi.fn() },
  member: { findUnique: memberFindUnique, update: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({ prisma: tx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
  withTenantContext: async <T,>(_id: string, fn: (t: unknown) => Promise<T>) => fn(tx),
}));
// FALSE, unlike every other auth unit test in this directory. With it true the
// whole expression collapses to `false` and this file would pass against any
// role gate at all — including the one it exists to forbid.
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: () => false }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "unknown",
}));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/session-revocation", () => ({ checkSessionVersion: vi.fn() }));
vi.mock("@/lib/impersonation", () => ({ readImpersonationCookie: vi.fn() }));
vi.mock("@/lib/pending-tenant-cookie", () => ({
  readPendingTenantSlug: vi.fn(),
  clearPendingTenantSlug: vi.fn(),
}));

const SLUG = "totalbjj";
const PASSWORD = "Ashgrove!2026aA";
const HASH = bcrypt.hashSync(PASSWORD, 4);
const TENANT = {
  id: "t1",
  slug: SLUG,
  name: "Total BJJ",
  subscriptionStatus: "active",
  deletedAt: null,
  primaryColor: "#000",
  secondaryColor: "#111",
  textColor: "#fff",
};

function staff(role: string, totpEnabled: boolean) {
  return {
    id: `u-${role}`,
    email: `${role}@totalbjj.com`,
    name: role,
    role,
    sessionVersion: 1,
    tenantId: "t1",
    passwordHash: HASH,
    failedLoginCount: 0,
    lockedUntil: null,
    totpEnabled,
    notifyOnNewLogin: false,
  };
}

async function signIn(email: string) {
  if (!captured.authorize) await import("@/auth");
  return captured.authorize!(
    { email, password: PASSWORD, tenantSlug: SLUG },
    new Request("http://localhost/api/auth/callback/credentials"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("TESTING_MODE", "");
  tenantFindUnique.mockResolvedValue(TENANT);
  userFindUnique.mockResolvedValue(null);
  memberFindUnique.mockResolvedValue(null);
});

afterEach(() => vi.unstubAllEnvs());

describe("the 2FA challenge follows enrolment, whatever the role", () => {
  // The four staff roles the product recognises. `admin` is the LOWEST staff
  // role and the schema default, which is why it matters that it is in here.
  for (const role of ["manager", "coach", "admin"] as const) {
    it(`challenges an ENROLLED ${role} at the password door`, async () => {
      userFindUnique.mockResolvedValue(staff(role, true));
      const result = await signIn(`${role}@totalbjj.com`);
      expect(result, "the sign-in itself still succeeds").not.toBeNull();
      expect(
        result!.totpPending,
        `an enrolled ${role} must be sent to /login/totp, not straight to the dashboard`,
      ).toBe(true);
    });
  }

  it("still challenges an enrolled owner", async () => {
    userFindUnique.mockResolvedValue(staff("owner", true));
    const result = await signIn("owner@totalbjj.com");
    expect(result!.totpPending).toBe(true);
  });

  it("challenges nobody who has not enrolled — 2FA stays optional", async () => {
    // The other direction, and the one that stops this fix turning an opt-in
    // into a wall. A coach who never enrolled signs in on the password alone.
    for (const role of ["owner", "manager", "coach", "admin"] as const) {
      userFindUnique.mockResolvedValue(staff(role, false));
      const result = await signIn(`${role}@totalbjj.com`);
      expect(result!.totpPending, `an un-enrolled ${role} is not challenged`).toBe(false);
    }
  });

  it("leaves the owner NUDGE owner-only, as decided", async () => {
    // `requireTotpSetup` drives the dashboard banner, not a gate. The decision
    // moved the challenge, not the nudge; asserted so a later tidy cannot
    // quietly widen it and start nagging every coach in the club.
    userFindUnique.mockResolvedValue(staff("coach", false));
    const coach = await signIn("coach@totalbjj.com");
    expect(coach!.requireTotpSetup, "no nudge for a coach").toBe(false);

    userFindUnique.mockResolvedValue(staff("owner", false));
    const owner = await signIn("owner@totalbjj.com");
    expect(owner!.requireTotpSetup, "the owner still gets the nudge").toBe(true);
  });

  it("a member with a password is challenged too — unchanged, and pinned", async () => {
    // This branch was always right. It is asserted here so that the two staff
    // sites and the member site can never drift apart again unnoticed.
    memberFindUnique.mockResolvedValue({
      id: "m1",
      email: "jordan@example.com",
      name: "Jordan",
      sessionVersion: 1,
      tenantId: "t1",
      passwordHash: HASH,
      failedLoginCount: 0,
      lockedUntil: null,
      totpEnabled: true,
      notifyOnNewLogin: false,
    });
    const result = await signIn("jordan@example.com");
    expect(result!.role).toBe("member");
    expect(result!.totpPending).toBe(true);
  });
});

describe("the Google door enforces the same rule", () => {
  // Read as source rather than driven: the Google branch lives in the `signIn`
  // callback, which needs an OAuth account object and a provider round-trip to
  // reach. The gate itself is one expression, and a scan pins it exactly.
  it("has no isOwner gate left on either totpPending site", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../auth.ts", import.meta.url), "utf8");
    const pendingLines = src
      .split("\n")
      .filter((l) => /totpPending:\s*!isTestingMode\(\)/.test(l));
    expect(pendingLines.length, "both staff sites plus both member sites").toBeGreaterThanOrEqual(4);
    for (const line of pendingLines) {
      expect(line, `a role gate is back on a totpPending site: ${line.trim()}`).not.toMatch(
        /isOwner/,
      );
    }
    // And the nudge is still owner-gated, so this scan cannot be satisfied by
    // deleting `isOwner` from the file wholesale.
    expect(src).toMatch(/requireTotpSetup:\s*!isTestingMode\(\)\s*&&\s*isOwner/);
  });
});
