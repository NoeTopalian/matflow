/**
 * One password rule, one history length, on every staff password door
 * (8 Oct 2026, handover lane S-staff). /api/auth/set-password and
 * /api/auth/reset-password used their own copies (set-password kept 5
 * previous passwords, reset-password 8 and did not refuse the CURRENT
 * password); both now use lib/password-policy.ts: 10+ characters with an
 * upper-case letter, a lower-case letter and a number; not the current
 * password; not any of the last PASSWORD_HISTORY_LIMIT (= 8).
 *
 * The tx is an in-memory fake whose passwordHistory honours `take` and the
 * newest-first order, so a shorter window shows up as an accepted reuse.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import { readFileSync } from "node:fs";
import { PASSWORD_HISTORY_LIMIT } from "@/lib/password-policy";
import { hashToken } from "@/lib/token-hash";

type Hist = { id: string; userId: string; passwordHash: string; createdAt: Date };
const h = vi.hoisted(() => ({
  history: [] as { id: string; userId: string; passwordHash: string; createdAt: Date }[],
  user: null as null | Record<string, unknown>,
  userUpdates: [] as Record<string, unknown>[],
  session: null as null | { user: Record<string, unknown> },
}));

vi.mock("@/auth", () => ({ auth: async () => h.session }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }) }));
vi.mock("next-auth/jwt", () => ({ getToken: async () => null, encode: async () => "jwt" }));

let seq = 0;
const tx = {
  tenant: { findUnique: async () => ({ id: "t-1", slug: "club" }) },
  user: {
    findFirst: async () => (h.user ? { ...h.user } : null),
    update: async ({ data }: { data: Record<string, unknown> }) => {
      h.userUpdates.push(data);
      return { sessionVersion: 2 };
    },
  },
  member: { findFirst: async () => null, update: async () => ({}) },
  passwordResetToken: {
    findFirst: async ({ where }: { where: { tokenHash: string } }) =>
      where.tokenHash === hashToken("123456") ? { id: "prt-1" } : null,
    updateMany: async () => ({ count: 1 }),
  },
  passwordHistory: {
    findMany: async ({ where, take }: { where: { userId: string }; take?: number }) => {
      const rows = h.history
        .filter((r) => r.userId === where.userId)
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
      return typeof take === "number" ? rows.slice(0, take) : rows;
    },
    create: async ({ data }: { data: { userId: string; passwordHash: string } }) => {
      const row: Hist = { id: `new-${++seq}`, ...data, createdAt: new Date(Date.now() + seq) };
      h.history.push(row);
      return row;
    },
    deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
      const before = h.history.length;
      for (const id of where.id.in) {
        const i = h.history.findIndex((r) => r.id === id);
        if (i >= 0) h.history.splice(i, 1);
      }
      return { count: before - h.history.length };
    },
  },
};
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
  withRlsBypass: async <T,>(fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx),
}));

import { POST as setPassword } from "@/app/api/auth/set-password/route";
import { POST as resetPassword } from "@/app/api/auth/reset-password/route";

const CURRENT = "CurrentPass1";
const OLD = Array.from({ length: 8 }, (_, i) => `OldPassword${i}A`); // OLD[0] newest
const CURRENT_HASH = bcrypt.hashSync(CURRENT, 4);
const OLD_HASHES = OLD.map((p) => bcrypt.hashSync(p, 4));

function seed(extra: Partial<Record<string, unknown>> = {}) {
  h.history.length = 0;
  OLD_HASHES.forEach((hash, i) =>
    h.history.push({ id: `old-${i}`, userId: "u-1", passwordHash: hash, createdAt: new Date(Date.UTC(2026, 0, 30 - i)) }),
  );
  h.user = { id: "u-1", passwordHash: CURRENT_HASH, mustChangePassword: false, tempPasswordExpiresAt: null, loginEmailProvisionalSince: null, ...extra };
  h.userUpdates.length = 0;
}
const json = (body: unknown) => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const set = (password: string) => setPassword(new Request("http://localhost/api/auth/set-password", json({ password })));
const reset = (password: string) =>
  resetPassword(new Request("http://localhost/api/auth/reset-password", json({ token: "123456", email: "staff@club.test", tenantSlug: "club", password })));

beforeEach(() => {
  h.session = { user: { id: "u-1", tenantId: "t-1", role: "manager" } };
});

describe("the shared rule", () => {
  it("keeps 8 previous passwords", () => {
    expect(PASSWORD_HISTORY_LIMIT).toBe(8);
  });

  it.each(["app/api/auth/set-password/route.ts", "app/api/auth/reset-password/route.ts"])(
    "%s takes its rule and history from lib/password-policy.ts and keeps no copy",
    (p) => {
      const s = readFileSync(p, "utf8");
      expect(s).toMatch(/from "@\/lib\/password-policy"/);
      expect(s).not.toMatch(/HISTORY_LIMIT\s*=/);
      expect(s).not.toMatch(/\[A-Z\]/);
    },
  );
});

describe("POST /api/auth/set-password", () => {
  beforeEach(() => seed({ mustChangePassword: true, tempPasswordExpiresAt: new Date(Date.now() + 3_600_000) }));

  it.each(["short1A", "alllowercase1", "ALLUPPERCASE1", "NoNumberHere"])("refuses %s (strength rule)", async (pw) => {
    expect((await set(pw)).status).toBe(400);
    expect(h.userUpdates).toHaveLength(0);
  });

  it("refuses the current (temporary) password", async () => {
    expect((await set(CURRENT)).status).toBe(400);
  });

  it.each([0, 4, 5, 7])("refuses the password from %i changes ago (window is 8, was 5)", async (i) => {
    const res = await set(OLD[i]);
    expect(res.status).toBe(400);
    expect(h.userUpdates).toHaveLength(0);
  });

  it("accepts a new one, records the outgoing hash and trims history to 8", async () => {
    const res = await set("BrandNewPass9");
    expect(res.status).toBe(200);
    expect(h.userUpdates[0]).toMatchObject({ mustChangePassword: false, tempPasswordExpiresAt: null });
    expect(h.history).toHaveLength(8);
    expect(h.history.some((r) => r.passwordHash === CURRENT_HASH)).toBe(true);
    expect(h.history.some((r) => r.id === "old-7")).toBe(false); // the oldest dropped
  });
});

describe("POST /api/auth/reset-password", () => {
  beforeEach(() => seed());

  it.each(["alllowercase1", "ALLUPPERCASE1", "NoNumberHere"])("refuses %s (strength rule)", async (pw) => {
    expect((await reset(pw)).status).toBe(400);
    expect(h.userUpdates).toHaveLength(0);
  });

  it("refuses the CURRENT password (now part of the shared rule)", async () => {
    const res = await reset(CURRENT);
    expect(res.status).toBe(400);
    expect(h.userUpdates).toHaveLength(0);
  });

  it.each([0, 7])("refuses the password from %i changes ago", async (i) => {
    expect((await reset(OLD[i])).status).toBe(400);
    expect(h.userUpdates).toHaveLength(0);
  });

  it("accepts a new one, records the outgoing hash and trims history to 8", async () => {
    const res = await reset("BrandNewPass9");
    expect(res.status).toBe(200);
    expect(h.userUpdates[0]).toMatchObject({ sessionVersion: { increment: 1 }, lockedUntil: null, failedLoginCount: 0 });
    expect(h.history).toHaveLength(8);
    expect(h.history.some((r) => r.passwordHash === CURRENT_HASH)).toBe(true);
  });
});
