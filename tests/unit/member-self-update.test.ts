// Personal-details edit feature (2026-08-17): validation, email rules, and
// the owner-side version history written by PATCH /api/member/me.

import { vi, describe, it, expect, beforeEach } from "vitest";
import { addLoginClaimSql } from "./login-claim-fake";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => {
      const cookies: Array<{ name: string; value: string; opts: Record<string, unknown> }> = [];
      return {
        status: init?.status ?? 200,
        json: async () => body,
        headers: new Headers(),
        cookies: { set: (name: string, value: string, opts: Record<string, unknown>) => cookies.push({ name, value, opts }), list: cookies },
      };
    },
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: vi.fn(), updateMany: vi.fn() },
    // An email change retires reset codes and sign-in links for old + new (AH-01).
    passwordResetToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
    magicLinkToken: { updateMany: vi.fn(async () => ({ count: 0 })) },
    attendanceRecord: { count: vi.fn(), findMany: vi.fn() },
    classInstance: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    user: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    rankHistory: { findMany: vi.fn().mockResolvedValue([]) },
    memberRank: { findFirst: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
  },
}));
// The real withTenantContext calls prisma.$transaction, which the mock above
// doesn't implement — hand the mocked client straight to the callback instead.
vi.mock("@/lib/prisma-tenant", async () => {
  const { prisma } = await import("@/lib/prisma");
  return {
    withTenantContext: async (_tenantId: string, fn: (tx: unknown) => unknown) => fn(addLoginClaimSql(prisma)),
  };
});

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { logAudit } from "@/lib/audit-log";
import { PATCH } from "@/app/api/member/me/route";
import { memberSelfUpdateSchema } from "@/lib/schemas/member";

const mockAuth = vi.mocked(auth);
const mockFindFirst = vi.mocked(prisma.member.findFirst as (...a: unknown[]) => unknown);
const mockUpdateMany = vi.mocked(prisma.member.updateMany as (...a: unknown[]) => unknown);
const mockLogAudit = vi.mocked(logAudit);

const SESSION = {
  user: { id: "user-1", tenantId: "tenant-1", memberId: "member-1", role: "member" },
} as never;

const BEFORE_ROW = {
  name: "Reese Hall",
  email: "reese@example.com",
  phone: null,
  accountType: "adult",
  emergencyContactName: null,
  emergencyContactPhone: null,
  emergencyContactRelation: null,
  dateOfBirth: null,
};

function req(body: unknown): Request {
  return new Request("https://test.local/api/member/me", {
    method: "PATCH",
    headers: { "content-type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue(SESSION);
  mockFindFirst.mockResolvedValue(BEFORE_ROW);
  mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe("memberSelfUpdateSchema", () => {
  it("rejects malformed email with a field message", () => {
    const r = memberSelfUpdateSchema.safeParse({ email: "not-an-email" });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.flatten().fieldErrors.email?.[0]).toMatch(/valid email/i);
  });

  it("normalises email to lowercase and trims", () => {
    const r = memberSelfUpdateSchema.safeParse({ email: "  Reese@Example.COM " });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.email).toBe("reese@example.com");
  });

  it("normalises UK phone to E.164 and rejects junk", () => {
    const ok = memberSelfUpdateSchema.safeParse({ phone: "07700 900123" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.phone).toBe("+447700900123");
    expect(memberSelfUpdateSchema.safeParse({ phone: "not a phone" }).success).toBe(false);
  });

  it("rejects empty name", () => {
    expect(memberSelfUpdateSchema.safeParse({ name: "  " }).success).toBe(false);
  });
});

describe("PATCH /api/member/me — validation + email rules", () => {
  it("400s with fieldErrors on invalid email", async () => {
    const res = await PATCH(req({ email: "nope" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fieldErrors.email).toMatch(/valid email/i);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("403s when the account's email is structural (kid account)", async () => {
    mockFindFirst.mockResolvedValue({ ...BEFORE_ROW, accountType: "kids", email: "kid-abc@no-login.matflow.local" });
    const res = await PATCH(req({ email: "real@example.com" }));
    expect(res.status).toBe(403);
    expect(mockUpdateMany).not.toHaveBeenCalled();
  });

  it("403s when the current email is a GDPR-erasure sentinel", async () => {
    mockFindFirst.mockResolvedValue({ ...BEFORE_ROW, email: "deleted-x@deleted.invalid" });
    const res = await PATCH(req({ email: "real@example.com" }));
    expect(res.status).toBe(403);
  });

  it("409s with an email field error on P2002 (address taken at this gym)", async () => {
    mockUpdateMany.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    const res = await PATCH(req({ email: "taken@example.com" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.fieldErrors.email).toMatch(/already used/i);
  });
});

describe("PATCH /api/member/me — version history", () => {
  it("writes an audit row with from→to changes on identity edits", async () => {
    const res = await PATCH(req({ name: "Reese H", email: "new@example.com", phone: "07700 900123" }));
    expect(res.status).toBe(200);
    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const call = mockLogAudit.mock.calls[0][0];
    expect(call.action).toBe("member.self_update");
    expect(call.entityType).toBe("Member");
    expect(call.entityId).toBe("member-1");
    const changes = (call.metadata as { changes: Record<string, { from: unknown; to: unknown }> }).changes;
    expect(changes.name).toEqual({ from: "Reese Hall", to: "Reese H" });
    expect(changes.phone).toEqual({ from: null, to: "+447700900123" });
    // AH-H2/H3 (9 Oct 2026): the login address appears only as keyed digests,
    // and the row is written inside the transaction with the change.
    expect(changes.email).toBeUndefined();
    const meta = call.metadata as Record<string, unknown>;
    expect(meta.oldEmailSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(meta.newEmailSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(meta)).not.toContain("@example.com");
    expect(call.tx, "audit row shares the transaction").toBe(prisma);
  });

  it("an audit failure fails the request", async () => {
    mockLogAudit.mockRejectedValueOnce(new Error("audit insert refused"));
    const res = await PATCH(req({ name: "Reese H" }));
    expect(res.status).toBe(500);
  });
});

describe("PATCH /api/member/me — a changed login address signs the member out (AH-H3)", () => {
  type Res = { status: number; json: () => Promise<Record<string, unknown>>; cookies: { list: Array<{ name: string; value: string; opts: Record<string, unknown> }> } };
  const bumpCall = () =>
    mockUpdateMany.mock.calls.find((c) => "passwordHash" in ((c as [{ where: Record<string, unknown> }])[0].where));

  const bumpAnswers = (count: number) =>
    mockUpdateMany.mockImplementation(async (...a: unknown[]) =>
      "passwordHash" in (a[0] as { where: Record<string, unknown> }).where ? { count } : { count: 1 });

  it("member with a password: sessionVersion +1 in the transaction, this device's cookie cleared, signInAgain", async () => {
    bumpAnswers(1);
    const res = (await PATCH(req({ email: "new@example.com" }))) as unknown as Res;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, signInAgain: true });
    const bump = bumpCall() as [{ where: Record<string, unknown>; data: Record<string, unknown> }] | undefined;
    expect(bump?.[0].where).toMatchObject({ id: "member-1", tenantId: "tenant-1", passwordHash: { not: null } });
    expect(bump?.[0].data).toEqual({ sessionVersion: { increment: 1 } });
    expect(res.cookies.list.map((c) => [c.name, c.value, c.opts.maxAge])).toEqual([[expect.stringMatching(/authjs\.session-token$/), "", 0]]);
    const meta = mockLogAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(meta.unverified).toBe(true);
    expect(meta.sessionsRevoked).toBe(true);
  });

  it("member without a password: contact change only — no sign-out, no signInAgain", async () => {
    bumpAnswers(0);
    const res = (await PATCH(req({ email: "new@example.com" }))) as unknown as Res;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.cookies.list).toEqual([]);
    const meta = mockLogAudit.mock.calls[0][0].metadata as Record<string, unknown>;
    expect(meta.unverified).toBe(true);
    expect(meta.sessionsRevoked).toBe(false);
  });

  it("a name-only edit never touches sessionVersion", async () => {
    const res = (await PATCH(req({ name: "Reese H" }))) as unknown as Res;
    expect(res.status).toBe(200);
    expect(bumpCall()).toBeUndefined();
    expect(res.cookies.list).toEqual([]);
  });

  it("writes NO audit row when only notification prefs change", async () => {
    const res = await PATCH(req({ beltPromotions: false }));
    expect(res.status).toBe(200);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });

  it("writes NO audit row when values are unchanged", async () => {
    const res = await PATCH(req({ name: "Reese Hall", email: "reese@example.com" }));
    expect(res.status).toBe(200);
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
