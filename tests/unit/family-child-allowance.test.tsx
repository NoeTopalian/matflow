/**
 * T7 review (17 Oct 2026): a parent can see a child's class allowance on the
 * child's page before the member app refuses a check-in for it. The count is
 * read only for a child the confirmed-guardian lookup found, by the same rows
 * the check-in counts (memberAllowanceUsage); a failure says so; an Unlimited
 * plan shows nothing.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const h = vi.hoisted(() => ({
  childFindFirst: vi.fn(),
  usage: vi.fn(),
  notFound: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({ user: { tenantId: "t1", memberId: "parent-1", primaryColor: "#123456" } })),
}));
vi.mock("next/navigation", () => ({ redirect: vi.fn(), notFound: h.notFound }));
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { findFirst: h.childFindFirst },
      memberPhoto: { findMany: vi.fn(async () => []) },
      tenant: { findUnique: vi.fn(async () => ({ name: "Total BJJ", kidsWaiverTitle: null, kidsWaiverContent: null })) },
    }),
}));
vi.mock("@/lib/member-stats", () => ({
  computeMemberStats: vi.fn(async () => ({
    stats: { totalClasses: 3, thisWeek: 1, thisMonth: 2, streakWeeks: 1, badges: [] },
    nextClass: null,
  })),
}));
vi.mock("@/lib/class-allowance-count", () => ({ memberAllowanceUsage: h.usage }));
vi.mock("@/components/member/KidPhotosAndWaiver", () => ({ default: () => null }));
vi.mock("@/components/member/MilestonesCard", () => ({ default: () => null }));
vi.mock("@/components/member/KidBillingCard", () => ({ KidBillingCard: () => null }));

import ChildProfilePage from "@/app/member/family/[childId]/page";

const CHILD = {
  id: "kid-1", name: "Sam", dateOfBirth: null, accountType: "kids", waiverAccepted: true,
  memberRanks: [], attendances: [], _count: { attendances: 0 },
};

async function render(): Promise<string> {
  const el = await ChildProfilePage({ params: Promise.resolve({ childId: "kid-1" }) });
  return renderToStaticMarkup(el);
}

beforeEach(() => {
  vi.clearAllMocks();
  h.childFindFirst.mockResolvedValue(CHILD);
  h.usage.mockResolvedValue({
    used: 2, limit: 4, basis: "weeks", weeks: 4, period: { start: "2026-09-28", end: "2026-10-26" }, resetsOn: "2026-10-26",
    text: "2 of 4 classes used this 4-week period — resets Monday 26 October",
  });
});

describe("child page: class allowance", () => {
  it("shows the child's count, read for that child in that club", async () => {
    const html = await render();
    expect(html).toContain("Class allowance");
    expect(html).toContain("2 of 4 classes used this 4-week period — resets Monday 26 October");
    expect(h.usage).toHaveBeenCalledWith(expect.anything(), { tenantId: "t1", memberId: "kid-1" });
  });

  it("the guardian lookup gates it: confirmed guardian of this child, in this club", async () => {
    await render();
    const where = h.childFindFirst.mock.calls[0][0].where as Record<string, unknown>;
    expect(where).toMatchObject({ id: "kid-1", parentMemberId: "parent-1", tenantId: "t1" });
  });

  it("a child the parent may not see is not found, and nothing is counted", async () => {
    h.childFindFirst.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(h.usage).not.toHaveBeenCalled();
  });

  it("a failed count says so, never a blank", async () => {
    h.usage.mockRejectedValue(new Error("db down"));
    const html = await render();
    expect(html).toContain("Couldn&#x27;t load how many classes Sam&#x27;s plan has left.");
  });

  it("an Unlimited plan shows no allowance card", async () => {
    h.usage.mockResolvedValue(null);
    const html = await render();
    expect(html).not.toContain("Class allowance");
  });
});
