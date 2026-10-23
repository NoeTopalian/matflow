// T6b acceptance 9: a club whose only classes are paused, archived or
// imported history has nothing on the timetable, so the owner's setup banner
// shows "Schedule a class". The count used to be `deletedAt: null` alone, which
// counted paused and imported classes (and, once archive writes deletedAt,
// would still have counted paused ones).

import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ classCount: vi.fn(async () => 0) }));

/** Every delegate answers "nothing here", except the few reads the banner needs. */
function fakeTx() {
  const delegate = (model: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => {
          if (model === "class" && method === "count") return h.classCount;
          if (model === "tenant" && method === "findUnique") {
            return async () => ({ stripeConnected: true, onboardingCompleted: true, contactEmail: "club@example.test", billingContactEmail: null });
          }
          if (method === "count") return async () => 1;
          if (method === "findMany") return async () => [];
          return async () => null;
        },
      },
    );
  return new Proxy({}, { get: (_t, model: string) => delegate(model) });
}

vi.mock("@/lib/authz", () => ({
  requireStaff: async () => ({
    session: { user: { id: "u1", tenantId: "t1", role: "owner", primaryColor: "#3b82f6", tenantName: "Club", name: "Owner" } },
  }),
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async (_t: string, fn: (tx: unknown) => Promise<unknown>) => fn(fakeTx()),
}));
vi.mock("@/components/dashboard/SetupBanner", () => ({ default: () => null }));
vi.mock("@/components/dashboard/DashboardStats", () => ({ default: () => null }));
vi.mock("@/components/dashboard/WeeklyCalendar", () => ({ default: () => null }));
vi.mock("@/components/dashboard/DeniedNotice", () => ({ default: () => null }));

import DashboardPage from "@/app/dashboard/page";

type El = { props: { children?: unknown; items?: { label: string }[] } };

function setupItems(el: El): { label: string }[] {
  const kids = (Array.isArray(el.props.children) ? el.props.children : [el.props.children]) as (El | false | null)[];
  const banner = kids.find((k) => k && typeof k === "object" && Array.isArray((k as El).props?.items)) as El | undefined;
  return banner?.props.items ?? [];
}

describe("dashboard setup banner counts classes ON THE TIMETABLE", () => {
  it("counts with the live-class predicate", async () => {
    h.classCount.mockResolvedValue(0);
    await DashboardPage({});
    expect(h.classCount).toHaveBeenCalledWith({
      where: { tenantId: "t1", isActive: true, deletedAt: null, sourceImportJobId: null },
    });
  });

  it("acceptance 9: no live classes (only archived ones exist) → 'Schedule a class'", async () => {
    h.classCount.mockResolvedValue(0);
    const el = (await DashboardPage({})) as unknown as El;
    expect(setupItems(el).map((i) => i.label)).toContain("Schedule a class");
  });

  it("with a live class on the timetable the item is not shown", async () => {
    h.classCount.mockResolvedValue(2);
    const el = (await DashboardPage({})) as unknown as El;
    expect(setupItems(el).map((i) => i.label)).not.toContain("Schedule a class");
  });
});
