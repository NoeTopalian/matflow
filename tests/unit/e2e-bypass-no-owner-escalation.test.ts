// The E2E password bypass must not invent a subject.
//
// `auth.ts` lets a local test run present `E2E_BYPASS_TOKEN` instead of a real
// password (gated by `isTestingMode()` + a loopback-ish IP). That part is fine.
// What was not fine sat immediately after the user and member branches: when
// the bypass token was used and NO account matched the address, the handler
// looked up the tenant's first `owner` and returned it, "so the test session
// still works".
//
// Lane L-D found what that costs. They signed in as `member@totalbjj.com` — an
// address `prisma/seed.ts` never creates — and were handed the club's OWNER.
// Six cells asserting a member is REFUSED recorded 200s and 201s instead:
//
//   ld-1:112  REFUSED: member cannot create     Expected 403  Received 201
//   ld-1:405  REFUSED: member reads coach/today Expected 403  Received 200
//   ld-2:145  REFUSED: member marks another     Expected 403  Received 201
//   ld-2:303  REFUSED: a member cannot scan     Expected 403  Received 200
//
// The giveaway in their log: the "member" out-ranked `admin` and `coach`, both
// correctly refused in the same loop, and its own check-in 404'd because the
// session carried no `Member` row.
//
// This file reaches the REAL `authorize`. `auth.ts` builds it inline inside the
// `NextAuth({ … })` call, so nothing exports it and nothing could test it —
// the same structural reason `lib/session-revocation.ts` records for the
// revocation defect that survived in a codebase with 1300 tests. Mocking
// `next-auth` and the credentials provider to capture the config object is what
// makes the branch reachable at all.

import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

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
  // `auth.ts:161` subclasses this for its message-bearing refusals
  // (RateLimitedError, AccountLockedError, TenantRefusedError).
  CredentialsSignin: class extends Error {
    code = "credentials";
  },
}));
vi.mock("next-auth/providers/credentials", () => ({
  default: (cfg: { authorize?: Authorize }) => cfg,
}));
vi.mock("next-auth/providers/google", () => ({ default: (cfg: unknown) => cfg }));

const { tenantFindUnique, userFindUnique, memberFindUnique, userFindFirst } = vi.hoisted(() => ({
  tenantFindUnique: vi.fn(),
  userFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
}));

const tx = {
  tenant: { findUnique: tenantFindUnique },
  user: { findUnique: userFindUnique, findFirst: userFindFirst, update: vi.fn() },
  member: { findUnique: memberFindUnique, update: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({ prisma: tx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
  withTenantContext: async <T,>(_id: string, fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: () => true }));
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

const BYPASS = "bypass-token-for-this-test";
const SLUG = "totalbjj";
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

async function authorize(email: string, password: string = BYPASS) {
  if (!captured.authorize) {
    // Importing for its side effect: the mocked NextAuth captures the config.
    await import("@/auth");
  }
  return captured.authorize!(
    { email, password, tenantSlug: SLUG },
    new Request("http://localhost/api/auth/callback/credentials"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("E2E_BYPASS_TOKEN", BYPASS);
  vi.stubEnv("TESTING_MODE", "true");
  tenantFindUnique.mockResolvedValue(TENANT);
  userFindUnique.mockResolvedValue(null);
  memberFindUnique.mockResolvedValue(null);
  // There IS an owner sitting in this tenant, in every test. That is the point:
  // a refusal test that only passes because no owner could be found would go
  // green against the very code it exists to forbid. Verified — with the
  // fallback restored, both refusal cases below go red.
  userFindFirst.mockResolvedValue({
    id: "u-owner",
    email: "owner@totalbjj.com",
    name: "Owner",
    role: "owner",
    sessionVersion: 1,
    tenantId: "t1",
    totpEnabled: false,
  });
});

afterEach(() => vi.unstubAllEnvs());

describe("the E2E bypass resolves the account the email names, or nothing", () => {
  it("still signs in a seeded account presented with the bypass token", async () => {
    // The bypass has to keep working, or this fix has broken every e2e login
    // in the product and the next person will simply put the escalation back.
    userFindUnique.mockResolvedValue({
      id: "u-owner",
      email: "owner@totalbjj.com",
      name: "Owner",
      role: "owner",
      sessionVersion: 3,
      tenantId: "t1",
      passwordHash: "$2a$10$notthepasswordbeingpresented",
      failedLoginCount: 0,
      lockedUntil: null,
      totpEnabled: false,
      notifyOnNewLogin: false,
    });

    const result = await authorize("owner@totalbjj.com");

    expect(result, "the bypass itself is untouched").not.toBeNull();
    expect(result!.id).toBe("u-owner");
    expect(result!.email).toBe("owner@totalbjj.com");
  });

  it("REFUSES an address that matches no user and no member", async () => {
    // The defect: this returned the tenant's first owner. `member@totalbjj.com`
    // is L-D's actual address and is not seeded.
    const result = await authorize("member@totalbjj.com");

    expect(result, "an unmatched address must not mint a session").toBeNull();
  });

  it("never looks for an owner to stand in for the address it was given", async () => {
    // Stronger than the assertion above, and the one that catches a partial
    // revert: nothing goes LOOKING for a stand-in. If a future change returns
    // some other substitute — the first manager, say — the assertion above
    // would still pass and this one would not.
    const result = await authorize("member@totalbjj.com");

    expect(result, "no session for an address with no account").toBeNull();
    expect(
      userFindFirst.mock.calls.filter(
        (c) => JSON.stringify(c[0] ?? {}).includes('"role":"owner"'),
      ),
      "no owner lookup on the bypass path",
    ).toEqual([]);
  });

  it("does not sign in an unknown address when the password is NOT the bypass token", async () => {
    // The ordinary credential path, asserted so this file notices if the fix
    // ever widens past the branch it was scoped to.
    const result = await authorize("member@totalbjj.com", "some-other-password");
    expect(result).toBeNull();
  });
});
