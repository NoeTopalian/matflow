// Personal-details edit feature (2026-08-17): validation, email rules, and
// the owner-side version history written by PATCH /api/member/me.

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: vi.fn(), updateMany: vi.fn() },
    attendanceRecord: { count: vi.fn(), findMany: vi.fn() },
    classInstance: { findFirst: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    rankHistory: { findMany: vi.fn().mockResolvedValue([]) },
    memberRank: { findFirst: vi.fn().mockResolvedValue(null) },
  },
}));
// The real withTenantContext calls prisma.$transaction, which the mock above
// doesn't implement — hand the mocked client straight to the callback instead.
vi.mock("@/lib/prisma-tenant", async () => {
  const { prisma } = await import("@/lib/prisma");
  return {
    withTenantContext: async (_tenantId: string, fn: (tx: unknown) => unknown) => fn(prisma),
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
    expect(changes.email).toEqual({ from: "reese@example.com", to: "new@example.com" });
    expect(changes.phone).toEqual({ from: null, to: "+447700900123" });
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
