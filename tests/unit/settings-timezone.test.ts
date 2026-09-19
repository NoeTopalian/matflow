// Campaign lane L-B, J16: `Tenant.timezone` had no writer.
//
// The column has existed since migration 20260503000001 and three readers
// depend on it — app/api/coach/today/route.ts (what is on today),
// app/api/classes/route.ts (which day an instance is minted for) and
// lib/checkin.ts (the check-in window). Its schema comment has always claimed
// "defaults from owner browser at onboarding step 1". Nothing ever wrote it:
// `updateSchema` had no such key, so every club outside Europe/London ran its
// day boundary and its check-in window on London time with no way to correct
// it, and the PATCH that tried answered 200 having saved nothing.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { update } = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { update } } }));

vi.mock("@/auth", () => ({
  auth: async () => ({ user: { id: "u-1", tenantId: "t-A", role: "owner" } }),
}));

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: async () => {} }));
vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

import { PATCH } from "@/app/api/settings/route";

function patchWith(body: unknown) {
  return PATCH(
    new Request("http://localhost:3847/api/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3847" },
      body: JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  update.mockResolvedValue({ id: "t-A", timezone: "America/New_York" });
});

describe("PATCH /api/settings writes Tenant.timezone", () => {
  it("accepts a real IANA zone and persists it", async () => {
    const res = await patchWith({ timezone: "America/New_York" });

    expect(res.status).toBe(200);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data).toMatchObject({ timezone: "America/New_York" });
  });

  it("accepts the other side of the world too", async () => {
    const res = await patchWith({ timezone: "Pacific/Auckland" });
    expect(res.status).toBe(200);
    expect(update.mock.calls[0][0].data).toMatchObject({ timezone: "Pacific/Auckland" });
  });

  it.each([
    ["a zone that does not exist", "Mars/Olympus_Mons"],
    ["a UTC offset, which Intl accepts but a club is not", "GMT+5"],
    ["an empty string", ""],
    ["a city with no region", "London"],
  ])("refuses %s with a 400 and writes nothing", async (_label, timezone) => {
    const res = await patchWith({ timezone });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("does not let a bad zone through alongside a good field", async () => {
    const res = await patchWith({ name: "Total BJJ", timezone: "Nowhere/Nothing" });
    expect(res.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });
});
