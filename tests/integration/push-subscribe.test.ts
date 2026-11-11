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
  let otherMemberId: string;
  let otherTenantId: string;
  let otherClubMemberId: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({ data: { name: "P-T", slug: `p-t-${STAMP}` } });
      tenantId = t.id;
      const m = await tx.member.create({ data: { tenantId, name: "M", email: `m-${STAMP}@p.test` } });
      memberId = m.id;
      otherMemberId = (await tx.member.create({ data: { tenantId, name: "M2", email: `m2-${STAMP}@p.test` } })).id;
      otherTenantId = (await tx.tenant.create({ data: { name: "P-T2", slug: `p-t2-${STAMP}` } })).id;
      otherClubMemberId = (await tx.member.create({ data: { tenantId: otherTenantId, name: "M3", email: `m3-${STAMP}@p.test` } })).id;
    });
  });
  afterAll(async () => {
    const ids = [tenantId, otherTenantId];
    await withRlsBypass((tx) => tx.pushSubscription.deleteMany({ where: { tenantId: { in: ids } } }));
    await withRlsBypass((tx) => tx.member.deleteMany({ where: { tenantId: { in: ids } } }));
    await withRlsBypass((tx) => tx.tenant.deleteMany({ where: { id: { in: ids } } }));
  });
  const as = (t: string, m: string) => mockAuth.mockResolvedValue({ user: { id: `u-${m}`, memberId: m, tenantId: t, role: "member", email: "m" } } as never);

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

  // Round 5: the endpoint is unique across clubs; only the subject who registered it may change its row.
  it("another member of the club, or of another club, presenting the endpoint is refused and the row is unchanged; the owner can re-register", async () => {
    const endpoint = `https://fcm.example/own-${STAMP}`;
    as(tenantId, memberId);
    expect((await subscribe(jsonReq({ endpoint, keys: { p256dh: "mine", auth: "mine" } }))).status).toBe(201);
    await withRlsBypass((tx) => tx.pushSubscription.update({ where: { endpoint }, data: { disabledAt: new Date() } }));

    as(tenantId, otherMemberId);
    expect((await subscribe(jsonReq({ endpoint, keys: { p256dh: "theirs", auth: "theirs" } }))).status).toBe(409);
    as(otherTenantId, otherClubMemberId);
    expect((await subscribe(jsonReq({ endpoint, keys: { p256dh: "theirs", auth: "theirs" } }))).status).toBe(409);
    const kept = await withRlsBypass((tx) => tx.pushSubscription.findUniqueOrThrow({ where: { endpoint } }));
    expect([kept.tenantId, kept.memberId, kept.p256dh, kept.auth]).toEqual([tenantId, memberId, "mine", "mine"]);

    as(tenantId, memberId);
    expect((await subscribe(jsonReq({ endpoint, keys: { p256dh: "renewed", auth: "renewed" } }))).status).toBe(201);
    const renewed = await withRlsBypass((tx) => tx.pushSubscription.findUniqueOrThrow({ where: { endpoint } }));
    expect([renewed.p256dh, renewed.disabledAt]).toEqual(["renewed", null]);
  });
});
