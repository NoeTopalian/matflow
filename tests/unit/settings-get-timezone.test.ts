// Campaign lane L-B, J16 round 2 — the read half of the Settings time-zone
// control.
//
// Round 1 shipped the writer (`PATCH /api/settings { timezone }`) and stopped
// there, so the J16 ERROR was downgraded, not closed: an owner still had no
// screen. The control now lives in components/dashboard/SettingsPage.tsx, and
// it cannot offer "change this" without first showing what the zone IS.
//
// It cannot come from the server props — app/dashboard/settings/page.tsx
// builds `TenantSettings` by hand and does not carry the column — so it comes
// from this route's own GET. If `timezone` ever drops out of the select the
// control renders an empty dropdown and the owner is one click from saving a
// zone they never chose, which is the whole defect again with a nicer screen.
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { findUnique } = vi.hoisted(() => ({ findUnique: vi.fn() }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ tenant: { findUnique } }),
}));
vi.mock("@/lib/prisma", () => ({ prisma: { tenant: { update: vi.fn() } } }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: async () => ({
    ok: true,
    session: { user: { id: "u-1", tenantId: "t-A", role: "owner" } },
  }),
}));
vi.mock("@/auth", () => ({ auth: async () => null }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: async () => {} }));
vi.mock("next/cache", () => ({ revalidateTag: () => {} }));

import { GET } from "@/app/api/settings/route";

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue({ id: "t-A", name: "Total BJJ", timezone: "Pacific/Auckland" });
});

describe("GET /api/settings carries the club's time zone", () => {
  it("asks Prisma for the column", async () => {
    await GET();
    expect(findUnique.mock.calls[0][0].select).toMatchObject({ timezone: true });
  });

  it("returns it to the control", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ timezone: "Pacific/Auckland" });
  });
});
