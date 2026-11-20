// @vitest-environment jsdom
/**
 * Issue #44: the gym dashboard shows the number of active members, and the
 * number is the logged-in user's gym only.
 *
 * The page already counted active training members (TRAINING_MEMBER, 2 Oct
 * 2026) but DashboardStats never rendered `totalActive`. Two checks:
 *   1. DashboardStats renders the count as the "Active Members" card.
 *   2. The real app/dashboard/page.tsx asks for the count with the session's
 *      tenantId, status "active" and the training-member population, and
 *      hands that tenant's number — not another tenant's — to DashboardStats.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import { TRAINING_MEMBER } from "@/lib/member-population";

vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/dashboard",
}));

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";

// Active training members per tenant. The fake tx answers from this table, so
// a count that forgot the tenant filter (or filtered the wrong tenant) would
// surface as the wrong number on the page.
const ACTIVE_BY_TENANT: Record<string, number> = { [TENANT_A]: 42, [TENANT_B]: 7 };

const memberCount = vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
  if (where.status === "active" && where.accountType !== undefined && !("waiverAccepted" in where) && !("OR" in where)) {
    return ACTIVE_BY_TENANT[String(where.tenantId)] ?? 0;
  }
  return 0;
});

const tx = {
  tenant: { findUnique: vi.fn().mockResolvedValue({ onboardingCompleted: false }) },
  membershipTier: { count: vi.fn().mockResolvedValue(0) },
  class: { count: vi.fn().mockResolvedValue(0) },
  member: { count: memberCount, findMany: vi.fn().mockResolvedValue([]) },
  classInstance: { findMany: vi.fn().mockResolvedValue([]) },
  attendanceRecord: { count: vi.fn().mockResolvedValue(0) },
  task: { findMany: vi.fn().mockResolvedValue([]) },
  payment: { findMany: vi.fn().mockResolvedValue([]) },
};

const withTenantContext = vi.fn(async <T,>(_tenantId: string, fn: (t: unknown) => Promise<T>): Promise<T> => fn(tx));
vi.mock("@/lib/prisma-tenant", () => ({ withTenantContext: (...args: unknown[]) => withTenantContext(...(args as [string, (t: unknown) => Promise<unknown>])) }));

const session = {
  user: { id: "user-a", tenantId: TENANT_A, role: "owner", tenantName: "Club A", primaryColor: "#2563eb", name: "Owner A" },
};
vi.mock("@/lib/authz", () => ({ requireStaff: vi.fn(async () => ({ session })) }));

import DashboardStats from "@/components/dashboard/DashboardStats";
import DashboardPage from "@/app/dashboard/page";

const baseStats = {
  totalActive: 0,
  newThisMonth: 0,
  attendanceThisWeek: 0,
  attendanceThisMonth: 0,
  waiverMissing: 0,
  missingPhone: 0,
  paymentsDue: 0,
  atRiskMembers: 0,
};

function findProps(node: unknown, component: unknown): Record<string, unknown> | null {
  if (!React.isValidElement(node)) return null;
  if (node.type === component) return node.props as Record<string, unknown>;
  const children = (node.props as { children?: React.ReactNode }).children;
  for (const child of React.Children.toArray(children)) {
    const found = findProps(child, component);
    if (found) return found;
  }
  return null;
}

describe("dashboard active member count (issue #44)", () => {
  beforeEach(() => {
    memberCount.mockClear();
    withTenantContext.mockClear();
  });

  it("DashboardStats shows the active member count as a card that opens the active members list", () => {
    render(
      <DashboardStats
        stats={{ ...baseStats, totalActive: 42 }}
        classes={[]}
        tenantName="Club A"
        primaryColor="#2563eb"
        currentUserRole="owner"
      />,
    );
    const card = screen.getByRole("link", { name: /active members/i });
    expect(card.textContent).toContain("42");
    expect(card.getAttribute("href")).toBe("/dashboard/members?filter=active");
  });

  it("the dashboard page counts only the signed-in user's tenant and passes that number to the stats", async () => {
    const page = await DashboardPage({ searchParams: Promise.resolve({}) });

    // Every read ran inside the session tenant's context.
    expect(withTenantContext).toHaveBeenCalledTimes(1);
    expect(withTenantContext.mock.calls[0][0]).toBe(TENANT_A);

    // The active count itself names the tenant, the status and the training population.
    const activeCalls = memberCount.mock.calls.filter(([arg]) => arg.where.status === "active" && !("waiverAccepted" in arg.where) && !("OR" in arg.where));
    expect(activeCalls).toHaveLength(1);
    expect(activeCalls[0][0]).toEqual({ where: { tenantId: TENANT_A, status: "active", ...TRAINING_MEMBER } });
    // No member query on the page runs without a tenant filter.
    for (const [arg] of memberCount.mock.calls) expect(arg.where.tenantId).toBe(TENANT_A);

    const props = findProps(page, DashboardStats);
    expect(props).not.toBeNull();
    expect((props!.stats as { totalActive: number }).totalActive).toBe(ACTIVE_BY_TENANT[TENANT_A]);
    expect((props!.stats as { totalActive: number }).totalActive).not.toBe(ACTIVE_BY_TENANT[TENANT_B]);
  });
});
