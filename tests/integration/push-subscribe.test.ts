import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => b, headers: new Headers() }) },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as subscribe } from "@/app/api/push/subscribe/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

function jsonReq(body: unknown): Request {
  return new Request("https://test.local/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!HAS_DB)("POST /api/push/subscribe", () => {
  let tenantId: string;
  let memberId: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: "P-T", slug: `p-t-${STAMP}` } });
      tenantId = t.id;
      const m = await tx.member.create({ data: { tenantId, name: "M", email: `m-${STAMP}@p.test` } });
      memberId = m.id;
    });
  });
  afterAll(async () => {
    await withRlsBypass((tx) => tx.pushSubscription.deleteMany({ where: { tenantId } }));
    await withRlsBypass((tx) => tx.member.deleteMany({ where: { tenantId } }));
    await withRlsBypass((tx) => tx.tenant.deleteMany({ where: { id: tenantId } }));
  });

  it("creates a subscription tied to the calling member", async () => {
    mockAuth.mockResolvedValue({ user: { id: "u", memberId, tenantId, role: "member", email: "m" } } as never);
    const res = await subscribe(jsonReq({
      endpoint: `https://fcm.example/x-${STAMP}`,
      keys: { p256dh: "p256-test", auth: "auth-test" },
    }));
    expect(res.status).toBe(201);

    const persisted = await withRlsBypass((tx) =>
      tx.pushSubscription.findFirst({ where: { memberId } }),
    );
    expect(persisted?.endpoint).toBe(`https://fcm.example/x-${STAMP}`);
  });
});
