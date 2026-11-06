/**
 * lib/push.ts under a restricted runtime role (6 Oct 2026).
 *
 * PushSubscription has RLS FORCEd. The old bare `prisma.pushSubscription`
 * calls carried no tenant context, so under matflow_app they would see zero
 * rows and push would silently never send. They now run inside the caller's
 * club (withTenantContext) and filter on tenantId as well as memberId — no
 * RLS bypass (the first version used one; review asked for the tenant scope).
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const h = vi.hoisted(() => ({
  findMany: vi.fn(),
  deleteMany: vi.fn(),
  updateMany: vi.fn(),
  withTenantContext: vi.fn(),
  sendNotification: vi.fn(),
  bareFindMany: vi.fn(),
}));

vi.mock("web-push", () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: h.sendNotification },
}));
vi.mock("@/lib/prisma-tenant", () => ({ withTenantContext: h.withTenantContext }));
// Any bare use of the singleton would show up here.
vi.mock("@/lib/prisma", () => ({ prisma: { pushSubscription: { findMany: h.bareFindMany, delete: h.bareFindMany } } }));

async function load(withKeys: boolean) {
  vi.resetModules();
  vi.stubEnv("VAPID_PUBLIC_KEY", withKeys ? "test-public" : "");
  vi.stubEnv("VAPID_PRIVATE_KEY", withKeys ? "test-private" : "");
  return (await import("@/lib/push")).sendPushToMember;
}

const payload = { title: "t", body: "b" };

beforeEach(() => {
  vi.clearAllMocks();
  h.withTenantContext.mockImplementation(async (_tenantId: string, fn: (tx: unknown) => unknown) =>
    fn({ pushSubscription: { findMany: h.findMany, deleteMany: h.deleteMany, updateMany: h.updateMany } }),
  );
  h.findMany.mockResolvedValue([{ id: "ps1", endpoint: "https://push.example/1", p256dh: "k", auth: "a" }]);
  h.deleteMany.mockResolvedValue({ count: 1 });
  h.updateMany.mockResolvedValue({ count: 1 });
  h.sendNotification.mockResolvedValue({});
});
afterEach(() => vi.unstubAllEnvs());

describe("sendPushToMember", () => {
  it("reads the member's subscriptions inside the club's tenant context, scoped by tenant and member", async () => {
    const send = await load(true);
    await send("ten_A", "mem_1", payload);
    expect(h.withTenantContext).toHaveBeenCalledTimes(1);
    expect(h.withTenantContext.mock.calls[0][0]).toBe("ten_A");
    expect(h.findMany.mock.calls[0][0].where).toEqual({ memberId: "mem_1", tenantId: "ten_A", disabledAt: null });
    expect(h.sendNotification).toHaveBeenCalledTimes(1);
    expect(h.bareFindMany).not.toHaveBeenCalled();
  });

  it("a 410 marks only that row inactive, scoped to the member as well as the id, and never deletes it", async () => {
    h.sendNotification.mockRejectedValue({ statusCode: 410 });
    const send = await load(true);
    await send("ten_A", "mem_1", payload);
    expect(h.updateMany).toHaveBeenCalledWith({ where: { id: "ps1", memberId: "mem_1", tenantId: "ten_A", disabledAt: null }, data: { disabledAt: expect.any(Date) } });
    // Product rule (Noe, 6 Nov 2026): nothing is deleted automatically.
    expect(h.deleteMany).not.toHaveBeenCalled();
  });

  it("a gone subscription is skipped on the next send", async () => {
    // A two-row store the fake honours: the read filters on disabledAt, the 410 sets it.
    const rows = [
      { id: "ps1", endpoint: "https://push.example/gone", p256dh: "k", auth: "a", disabledAt: null as Date | null },
      { id: "ps2", endpoint: "https://push.example/live", p256dh: "k", auth: "a", disabledAt: null as Date | null },
    ];
    h.findMany.mockImplementation(async ({ where }: { where: { disabledAt?: null } }) => rows.filter((r) => !("disabledAt" in where) || r.disabledAt === null));
    h.updateMany.mockImplementation(async ({ where, data }: { where: { id: string }; data: { disabledAt: Date } }) => {
      const row = rows.find((r) => r.id === where.id && r.disabledAt === null);
      if (row) row.disabledAt = data.disabledAt;
      return { count: row ? 1 : 0 };
    });
    h.sendNotification.mockImplementation(async (sub: { endpoint: string }) => {
      if (sub.endpoint.endsWith("/gone")) throw { statusCode: 410 };
      return {};
    });
    const send = await load(true);
    await send("ten_A", "mem_1", payload);
    expect(h.sendNotification).toHaveBeenCalledTimes(2);
    h.sendNotification.mockClear();
    await send("ten_A", "mem_1", payload);
    expect(h.sendNotification.mock.calls.map(([s]) => (s as { endpoint: string }).endpoint)).toEqual(["https://push.example/live"]);
    // Both rows are still there; the gone one is marked, not removed.
    expect(rows).toHaveLength(2);
    expect(rows[0].disabledAt).toBeInstanceOf(Date);
    expect(h.deleteMany).not.toHaveBeenCalled();
  });

  it("other push failures change nothing", async () => {
    h.sendNotification.mockRejectedValue({ statusCode: 500 });
    const send = await load(true);
    await send("ten_A", "mem_1", payload);
    expect(h.deleteMany).not.toHaveBeenCalled();
    expect(h.updateMany).not.toHaveBeenCalled();
  });

  it("does nothing without VAPID keys (today's production state)", async () => {
    const send = await load(false);
    await send("ten_A", "mem_1", payload);
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });

  it("an empty memberId never becomes an unfiltered read", async () => {
    const send = await load(true);
    await send("ten_A", "", payload);
    expect(h.findMany).not.toHaveBeenCalled();
  });

  it("an empty tenant id never becomes an unscoped read", async () => {
    const send = await load(true);
    await send("", "mem_1", payload);
    expect(h.withTenantContext).not.toHaveBeenCalled();
  });
});
