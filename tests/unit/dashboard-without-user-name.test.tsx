// @vitest-environment jsdom
//
// E2E re-run (6 Oct 2026, lane J item 9): support started in a clean operator
// browser swapped to the target, but the session reached the dashboard with no
// name, and every /dashboard page 500'd — userTone(session.user.name) read
// `.length` of undefined (app/dashboard/layout.tsx; components/layout/Topbar.tsx).
// auth.ts now carries the target's name (tests/unit/support-swap-identity.test.ts);
// this pins that the chrome itself survives a session without one.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import React from "react";

const h = vi.hoisted(() => ({ user: {} as Record<string, unknown> }));

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
      user: { findFirst: async () => ({ mustChangePassword: false }) },
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
import { userTone } from "@/lib/color";

afterEach(cleanup);

const BASE = {
  id: "u-target", tenantId: "t1", tenantSlug: "club", tenantName: "Club", role: "manager",
  primaryColor: "#3b82f6", secondaryColor: "#2563eb", textColor: "#ffffff", totpEnabled: true,
};

describe("userTone tolerates a missing name", () => {
  it.each([undefined, null, ""])("%o → a colour, not a throw", (n) => {
    expect(userTone(n)).toMatch(/^hsla\(/);
  });
  it("a real name still seeds a hue", () => {
    expect(userTone("Ada Lovelace")).not.toBe(userTone(undefined));
  });
});

describe("the dashboard chrome renders without a user name", () => {
  it("name undefined → renders (no 500)", async () => {
    h.user = { ...BASE, name: undefined, email: undefined };
    const el = await DashboardLayout({ children: <p>page body</p> });
    render(el);
    expect(screen.getByText("page body")).toBeTruthy();
  });

  it("control: a named user renders their initials", async () => {
    h.user = { ...BASE, name: "Target Owner", email: "target@example.test" };
    const el = await DashboardLayout({ children: <p>page body</p> });
    render(el);
    expect(screen.getAllByText("TO").length).toBeGreaterThan(0);
  });
});
