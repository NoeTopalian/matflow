// Round 4 (10 Nov 2026): adding a child twice with the same request id (a
// retry after a lost reply, or two sends at once) creates one child. The
// owner's Add child form now sends a retry-stable requestId, as Add member
// does. Real POST /api/members, Neon TEST branch, both database roles.
// Synthetic clubs (r4c-), torn down here.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }) },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, retryAfterSeconds: 0 })),
}));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));

import { auth } from "@/auth";
import { randomUUID } from "node:crypto";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as createMember } from "@/app/api/members/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r4c${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 120_000 });

describe.skipIf(!HAS_DB)("add child: one child per request id", () => {
  let tenantId = "";
  let ownerId = "";
  let parentId = "";
  const send = (requestId: string) =>
    createMember(new Request("https://test.local/api/members", {
      method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
      body: JSON.stringify({ name: `${STAMP} Kid`, accountType: "kids", parentMemberId: parentId, dateOfBirth: "2018-05-01", requestId }),
    })) as unknown as Promise<{ status: number; json: () => Promise<Record<string, unknown>> }>;
  const kids = () => withRlsBypass((tx) => tx.member.count({ where: { tenantId, parentMemberId: parentId } }));

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: `${STAMP} club`, slug: STAMP, onboardingCompleted: true } });
      tenantId = t.id;
      ownerId = (await tx.user.create({ data: { tenantId, email: `${STAMP}-o@example.test`, passwordHash: "x", name: "Owner", role: "owner" } })).id;
      parentId = (await tx.member.create({ data: { tenantId, name: `${STAMP} Parent`, email: `${STAMP}-p@example.test` } })).id;
    });
    mockAuth.mockResolvedValue({ user: { id: ownerId, tenantId, role: "owner", email: "owner" } } as never);
  });
  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.memberStatusEvent.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId, parentMemberId: { not: null } } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  it("a retry with the same request id returns the child already created", async () => {
    const key = randomUUID();
    const first = await send(key);
    const retry = await send(key);
    expect([first.status, retry.status]).toEqual([201, 200]);
    expect((await retry.json()).id).toBe((await first.json()).id);
    expect(await kids()).toBe(1);
  });

  it("two sends at once with one request id create one child", async () => {
    const before = await kids();
    const key = randomUUID();
    const results = await Promise.all([send(key), send(key)]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 201]);
    expect((await kids()) - before).toBe(1);
  });
});
