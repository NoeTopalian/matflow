// The failed-attempt counter has to survive attempts that overlap.
//
// Another lane found it intermittently lost, by wire probes against throwaway
// rows in the test branch (their table, verbatim):
//
//   fresh User, count 0    | 11 refusals | failedLoginCount = 1, never locked
//   fresh Member, count 0  | 11 refusals | failedLoginCount = 1, never locked
//   User seeded at 5       |  1 refusal  | 6   — the increment lands
//   User seeded at 9       |  1 refusal  | locked — the lock lands
//
// The read, the write and the threshold were all fine; what was unreliable was
// counting UP from zero across many attempts. Their corroboration from the data
// rather than the theory: every `auth.account.locked` row in the test database
// was a Member and none was a User — nothing had ever locked a staff account.
//
// The mechanism is a read-modify-write across a long gap. `authorize` captures
// `subject.failedLoginCount` near the top, then spends ~100 ms in
// `bcrypt.compare`, then writes `captured + 1` ABSOLUTELY. Overlapping attempts
// therefore all read the same number and all write the same number — ten wrong
// passwords in parallel leave the counter at 1 — and the window is widest under
// precisely the traffic the lockout exists to stop.
//
// These tests make that interleaving EXACT rather than hoping for it: the
// bcrypt mock holds every attempt at a barrier until all of them have read, so
// the race happens every run, on every machine. A test for a race that only
// sometimes races is not a test.

import { vi, describe, it, expect, beforeEach } from "vitest";

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
vi.mock("next-auth/providers/credentials", () => ({ default: (c: unknown) => c }));
vi.mock("next-auth/providers/google", () => ({ default: (c: unknown) => c }));

const { releaseBarrier, compareMock, captureException, logAudit } = vi.hoisted(() => {
  let waiting: (() => void)[] = [];
  return {
    compareMock: vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          waiting.push(() => resolve(false));
        }),
    ),
    releaseBarrier: () => {
      const w = waiting;
      waiting = [];
      for (const r of w) r();
    },
    captureException: vi.fn(),
    logAudit: vi.fn(),
  };
});

vi.mock("bcryptjs", () => ({
  default: { compare: compareMock, hashSync: () => "$2a$10$x", hash: async () => "$2a$10$x" },
}));
vi.mock("@sentry/nextjs", () => ({ captureException }));
vi.mock("@/lib/audit-log", () => ({ logAudit }));

// ── A row that behaves like Postgres for the one operation that matters ──────
// `{ increment: n }` is applied to whatever is in the row AT WRITE TIME, which
// is the entire point: the database adds to the current value, not to the one
// this process read before it went off to hash a password.
const row = { id: "u1", failedLoginCount: 0, lockedUntil: null as Date | null };

function applyUpdate(data: Record<string, unknown>) {
  const bag = row as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === "object" && "increment" in (v as Record<string, unknown>)) {
      bag[k] = Number(bag[k] ?? 0) + Number((v as { increment: number }).increment);
    } else {
      bag[k] = v;
    }
  }
  return { ...row };
}

const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => applyUpdate(data));

const tx = {
  tenant: { findUnique: vi.fn() },
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update,
  },
  member: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn(), update: vi.fn() },
};

vi.mock("@/lib/prisma", () => ({ prisma: tx }));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>) => fn(tx),
  withTenantContext: async <T,>(_id: string, fn: (t: unknown) => Promise<T>) => fn(tx),
}));
vi.mock("@/lib/testing-mode", () => ({ isTestingMode: () => false }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 }),
  getClientIp: () => "unknown",
}));
vi.mock("@/lib/login-event", () => ({ recordLoginEvent: vi.fn() }));
vi.mock("@/lib/impersonation", () => ({ readImpersonationCookie: vi.fn() }));
vi.mock("@/lib/session-revocation", () => ({ checkSessionVersion: vi.fn() }));
vi.mock("@/lib/pending-tenant-cookie", () => ({
  readPendingTenantSlug: vi.fn(),
  clearPendingTenantSlug: vi.fn(),
}));

const TENANT = { id: "t1", slug: "totalbjj", name: "Total BJJ", subscriptionStatus: "active", deletedAt: null };

async function attempt(password = "wrong-password-1") {
  if (!captured.authorize) await import("@/auth");
  return captured.authorize!(
    { email: "coach@totalbjj.com", password, tenantSlug: "totalbjj" },
    new Request("http://localhost/api/auth/callback/credentials"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  row.failedLoginCount = 0;
  row.lockedUntil = null;
  tx.tenant.findUnique.mockResolvedValue(TENANT);
  // Every lookup sees the row as it stands right now — a real pre-read.
  tx.user.findUnique.mockImplementation(async () => ({
    ...row,
    email: "coach@totalbjj.com",
    name: "Coach",
    role: "coach",
    tenantId: "t1",
    sessionVersion: 0,
    passwordHash: "$2a$10$somethingthatwillnotmatch",
    totpEnabled: false,
    notifyOnNewLogin: false,
  }));
  tx.member.findUnique.mockResolvedValue(null);
  update.mockClear();
});

describe("overlapping wrong passwords each count", () => {
  it("ten simultaneous refusals leave the counter at ten, not one", async () => {
    // All ten read the row, THEN all ten are told their password was wrong.
    // Before the fix every one of them computed 0 + 1 and wrote 1 absolutely.
    const flight = Array.from({ length: 10 }, () => attempt());
    await vi.waitFor(() => expect(compareMock).toHaveBeenCalledTimes(10));
    releaseBarrier();
    const results = await Promise.all(flight);

    expect(results.every((r) => r === null), "every attempt is still refused").toBe(true);
    // Ten increments: the tenth crosses the threshold, so the counter resets to
    // 0 and the lock goes on. Either way the arithmetic reached ten.
    expect(row.lockedUntil, "ACCOUNT_LOCKOUT_THRESHOLD is 10 — ten attempts must lock").not.toBeNull();
  });

  it("three simultaneous refusals leave the counter at three", async () => {
    const flight = Array.from({ length: 3 }, () => attempt());
    await vi.waitFor(() => expect(compareMock).toHaveBeenCalledTimes(3));
    releaseBarrier();
    await Promise.all(flight);

    expect(row.failedLoginCount, "one increment per attempt, however they interleave").toBe(3);
    expect(row.lockedUntil).toBeNull();
  });

  it("counts up from a seeded value too — the case that always worked", async () => {
    row.failedLoginCount = 5;
    const one = attempt();
    await vi.waitFor(() => expect(compareMock).toHaveBeenCalledTimes(1));
    releaseBarrier();
    await one;

    expect(row.failedLoginCount).toBe(6);
  });

  it("asks the database to add one, rather than writing a number it worked out earlier", async () => {
    const one = attempt();
    await vi.waitFor(() => expect(compareMock).toHaveBeenCalledTimes(1));
    releaseBarrier();
    await one;

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { failedLoginCount: { increment: 1 } } }),
    );
  });
});

describe("a counter that cannot be written is not silent", () => {
  it("logs and reports when the update fails, instead of swallowing it", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    update.mockRejectedValueOnce(new Error("P2028: transaction already closed"));

    const one = attempt();
    await vi.waitFor(() => expect(compareMock).toHaveBeenCalledTimes(1));
    releaseBarrier();
    const result = await one;

    expect(result, "a database blip must not turn a wrong password into a 500").toBeNull();
    expect(
      errorSpy.mock.calls.flat().join(" "),
      "while this is failing the lockout is not counting, and this line is how anyone finds out",
    ).toMatch(/lockout is not counting/);
    expect(captureException, "and it reaches Sentry, like every other fail-open control").toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
