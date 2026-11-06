// @vitest-environment jsdom
//
// Speed quick win 2c (6 Nov 2026): the dashboard layout's temporary-password
// backstop reads the session's mustChangePassword claim instead of re-reading
// the User row on every dashboard render. proxy.ts enforces the same claim
// first (tests/unit/owner-activation-order.test.ts); every write that sets the
// flag also bumps sessionVersion, so a live session cannot carry a stale false.

import { describe, it, expect, vi, afterEach } from "vitest";
import { cleanup } from "@testing-library/react";
import React from "react";

const h = vi.hoisted(() => ({
  user: {} as Record<string, unknown>,
  userFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Error(`REDIRECT:${to}`); },
  usePathname: () => "/dashboard",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("@/lib/authz", () => ({ requireStaff: async () => ({ session: { user: h.user } }) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      user: { findFirst: h.userFindFirst, findUnique: h.userFindUnique },
      tenant: { findUnique: async () => ({ logoUrl: null, logoSize: "md", onboardingCompleted: true, reviewLockedAt: null, reviewSnapshotAt: null, reviewNote: null }) },
    }),
}));
vi.mock("@/components/layout/Sidebar", () => ({ default: () => null }));
vi.mock("@/components/layout/MobileNav", () => ({ default: () => null }));
vi.mock("@/components/layout/ThemeProvider", () => ({ default: ({ children }: { children?: React.ReactNode }) => children }));
vi.mock("@/components/layout/ImpersonationBanner", () => ({ default: () => null }));
vi.mock("@/components/layout/Recommend2FABanner", () => ({ default: () => null }));
vi.mock("@/components/layout/ReviewModeBanner", () => ({ default: () => null }));

import DashboardLayout from "@/app/dashboard/layout";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const BASE = {
  id: "u-claim", tenantId: "t1", tenantSlug: "club", tenantName: "Club", role: "manager", name: "Claim Manager",
  primaryColor: "#3b82f6", secondaryColor: "#2563eb", textColor: "#ffffff", totpEnabled: true,
};

describe("dashboard layout temporary-password backstop", () => {
  it("a session carrying mustChangePassword goes to /set-password", async () => {
    h.user = { ...BASE, mustChangePassword: true };
    await expect(DashboardLayout({ children: <p>page body</p> })).rejects.toThrow("REDIRECT:/set-password");
  });

  it("a session without it renders, and the layout does not re-read the User row", async () => {
    h.user = { ...BASE, mustChangePassword: false };
    await expect(DashboardLayout({ children: <p>page body</p> })).resolves.toBeTruthy();
    expect(h.userFindFirst).not.toHaveBeenCalled();
    expect(h.userFindUnique).not.toHaveBeenCalled();
  });
});
