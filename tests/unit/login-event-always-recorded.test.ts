/**
 * Sign-in records are kept whether or not new-device EMAILS are switched on
 * (E2E flow 9, 6 Oct 2026).
 *
 * lib/login-event.ts returned before touching the database unless
 * NEXT_PUBLIC_ENABLE_LOGIN_NOTIFICATIONS === "true", and that flag is not set in
 * production. scripts/readiness/activation-verdict.mjs needs a LoginEvent row as
 * evidence the owner signed in themselves, so a genuine activation could never
 * read ACTIVATED. The row is now always written; only the email (and its audit
 * row) is gated on the flag. With the flag on, behaviour is unchanged.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  // sendEmail resolves { ok, logId, suppressed? } (lib/email-delivery.ts); the
  // "alert sent" audit row is written only for ok: true (7 Oct 2026, mail-dark).
  sendEmail: vi.fn(async (): Promise<{ ok: boolean; logId: string; suppressed?: string }> => ({ ok: true, logId: "log-1" })),
  logAudit: vi.fn(async () => undefined),
}));

vi.mock("@/lib/auth-secret", () => ({ AUTH_SECRET_VALUE: "unit-test-secret-0123456789" }));
vi.mock("@/lib/email", () => ({ sendEmail: h.sendEmail }));
vi.mock("@/lib/audit-log", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/prisma-tenant", () => {
  const tx = {
    loginEvent: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        const row = h.rows.find((r) =>
          r.deviceHash === where.deviceHash &&
          (where.userId ? r.userId === where.userId : r.memberId === where.memberId));
        // A copy, like Prisma: a later update must not rewrite what was read.
        return row ? { ...row } : null;
      },
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = h.rows.find((r) => r.id === where.id)!;
        Object.assign(row, data);
        return row;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `le-${h.rows.length + 1}`, disownedAt: null, ...data };
        h.rows.push(row);
        return row;
      },
    },
  };
  return { withTenantContext: async <T,>(_t: string, fn: (t: unknown) => Promise<T>) => fn(tx) };
});

import { recordLoginEvent } from "@/lib/login-event";

const OWNER = { kind: "user" as const, id: "u-owner", email: "owner@example.test", tenantId: "t-club", role: "owner", notifyOnNewLogin: false };
const args = (ua = "Mozilla/5.0 (Macintosh) Safari/605") => ({
  subject: OWNER,
  ip: "203.0.113.9",
  ua,
  appUrl: "https://app.example.test",
  gymName: "Test BJJ",
});

const FLAG = "NEXT_PUBLIC_ENABLE_LOGIN_NOTIFICATIONS";
let saved: string | undefined;
beforeEach(() => {
  saved = process.env[FLAG];
  h.rows = [];
  h.sendEmail.mockClear();
  h.logAudit.mockClear();
});
afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

describe("flag NOT set (production today)", () => {
  beforeEach(() => { delete process.env[FLAG]; });

  it("a sign-in on a new device RECORDS the LoginEvent row", async () => {
    await recordLoginEvent(args());
    expect(h.rows).toHaveLength(1);
    expect(h.rows[0]).toMatchObject({ tenantId: "t-club", userId: "u-owner", memberId: null });
    expect(h.rows[0].lastSeenAt).toBeInstanceOf(Date);
  });

  it("…and sends NO email and writes no notified audit row", async () => {
    await recordLoginEvent(args());
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("a repeat sign-in on the same device updates lastSeenAt, no second row", async () => {
    await recordLoginEvent(args());
    const first = h.rows[0].lastSeenAt as Date;
    await new Promise((r) => setTimeout(r, 5));
    await recordLoginEvent(args());
    expect(h.rows).toHaveLength(1);
    expect((h.rows[0].lastSeenAt as Date).getTime()).toBeGreaterThan(first.getTime());
  });

  it("does not clear a disowned flag it cannot notify about", async () => {
    await recordLoginEvent(args());
    h.rows[0].disownedAt = new Date();
    await recordLoginEvent(args());
    expect(h.rows[0].disownedAt).toBeInstanceOf(Date);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });
});

describe("flag ON — behaviour unchanged", () => {
  beforeEach(() => { process.env[FLAG] = "true"; });

  it("new device → row + email + audit (owners cannot opt out)", async () => {
    await recordLoginEvent(args());
    expect(h.rows).toHaveLength(1);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "auth.login.new_device_notified" }));
  });

  it("email turned off → row kept, but no 'alert sent' audit row claims a notification", async () => {
    h.sendEmail.mockResolvedValueOnce({ ok: false, logId: "log-off", suppressed: "delivery_off" });
    await recordLoginEvent(args());
    expect(h.rows).toHaveLength(1);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(h.logAudit).not.toHaveBeenCalledWith(expect.objectContaining({ action: "auth.login.new_device_notified" }));
  });

  it("known device → no email", async () => {
    await recordLoginEvent(args());
    h.sendEmail.mockClear();
    await recordLoginEvent(args());
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("a disowned device reappearing is re-armed and notified again", async () => {
    await recordLoginEvent(args());
    h.rows[0].disownedAt = new Date();
    h.sendEmail.mockClear();
    await recordLoginEvent(args());
    expect(h.rows[0].disownedAt).toBeNull();
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
  });
});
