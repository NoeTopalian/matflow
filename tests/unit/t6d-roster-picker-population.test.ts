// T6d — the class roster picker lists training members only.
//
// The picker (components/dashboard/TimetableManager.tsx) loads
// /api/members?population=training. That spreads the shared TRAINING_MEMBER
// predicate (lib/member-population.ts) into the tenant-scoped query, so a
// guardian account — including the no-login guardian drafts a TeamUp import
// makes from emergency contacts — is never offered as a squad member. Without
// the parameter the list is unchanged.

import { vi, describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

const { findManyMock } = vi.hoisted(() => ({ findManyMock: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: { member: { findMany: findManyMock } } }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: vi.fn().mockReturnValue("203.0.113.9"),
}));

import { GET } from "@/app/api/members/route";
import { auth } from "@/auth";
import { TRAINING_MEMBER } from "@/lib/member-population";

const mockAuth = vi.mocked(auth);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { id: "u1", role: "owner", tenantId: "t-A" } } as unknown as Awaited<ReturnType<typeof auth>>);
  findManyMock.mockResolvedValue([]);
});

describe("GET /api/members?population=training", () => {
  it("excludes guardian accounts with the shared predicate, tenant-scoped", async () => {
    const res = await GET(new Request("http://localhost/api/members?take=100&population=training"));
    expect(res.status).toBe(200);
    const where = findManyMock.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t-A");
    expect(where.accountType).toEqual(TRAINING_MEMBER.accountType);
    expect(where.accountType).toEqual({ not: "parent" });
  });

  it("without the parameter the list is unchanged (guardians included, as before)", async () => {
    await GET(new Request("http://localhost/api/members?take=100"));
    expect(findManyMock.mock.calls[0][0].where.accountType).toBeUndefined();
  });

  it("an unknown population value changes nothing", async () => {
    await GET(new Request("http://localhost/api/members?population=everyone"));
    expect(findManyMock.mock.calls[0][0].where.accountType).toBeUndefined();
  });
});

describe("the roster picker asks for training members", () => {
  it("TimetableManager loads /api/members with population=training", () => {
    const src = readFileSync(join(__dirname, "..", "..", "components", "dashboard", "TimetableManager.tsx"), "utf8");
    expect(src).toMatch(/\/api\/members\?take=100&population=training/);
  });
});
