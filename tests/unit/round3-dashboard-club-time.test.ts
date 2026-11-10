// Round 3 (10 Nov 2026): the dashboard home's week of classes, "New this
// month" and the week's and month's check-ins are the club's (Tenant.timezone),
// not the server's (UTC on Vercel). A session's `date` is UTC midnight of its
// club day, so the week of sessions is each day key ± 12 hours (todayWindow).

import { describe, it, expect, vi, afterEach } from "vitest";

type Args = { where?: Record<string, unknown> };
const calls: { model: string; method: string; args: Args }[] = [];
let clubZone = "Europe/London";

function fakeTx() {
  const delegate = (model: string) =>
    new Proxy(
      {},
      {
        get: (_t, method: string) => async (args: Args) => {
          calls.push({ model, method, args });
          if (model === "tenant" && method === "findUnique") {
            return { timezone: clubZone, stripeConnected: true, onboardingCompleted: true, contactEmail: "club@example.test", billingContactEmail: null };
          }
          if (method === "count") return 1;
          if (method === "findMany" || method === "groupBy") return [];
          return null;
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

const ORIGINAL_TZ = process.env.TZ;
afterEach(() => {
  vi.useRealTimers();
  process.env.TZ = ORIGINAL_TZ;
  calls.length = 0;
});

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : undefined);

async function render(zone: string, at: string) {
  clubZone = zone;
  process.env.TZ = "UTC";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at));
  await DashboardPage({});
  const checkInGtes = calls
    .filter((c) => c.model === "attendanceRecord" && c.method === "count")
    .map((c) => iso((c.args.where?.checkInTime as { gte?: Date } | undefined)?.gte));
  const joinedGtes = calls
    .filter((c) => c.model === "member" && c.method === "count")
    .map((c) => iso((c.args.where?.joinedAt as { gte?: Date } | undefined)?.gte))
    .filter(Boolean);
  const week = calls.find((c) => c.model === "classInstance" && c.method === "findMany" && c.args.where?.date)?.args.where?.date as { gte: Date; lt: Date };
  return { checkInGtes, joinedGtes, week };
}

describe("dashboard home counts in the club's week and month", () => {
  it("Auckland club, UTC server, 2026-11-08T12:00Z (Monday 9 Nov, 01:00 in Auckland)", async () => {
    const { checkInGtes, joinedGtes, week } = await render("Pacific/Auckland", "2026-11-08T12:00:00Z");
    // This week's check-ins from Auckland's Monday midnight; this month's from its 1 November.
    expect(checkInGtes).toContain("2026-11-08T11:00:00.000Z");
    expect(checkInGtes).toContain("2026-10-31T11:00:00.000Z");
    expect(joinedGtes).toEqual(["2026-10-31T11:00:00.000Z"]);
    // The week of sessions: 9–15 November, stored as UTC midnights, ± 12 hours.
    expect(iso(week.gte)).toBe("2026-11-08T12:00:00.000Z");
    expect(iso(week.lt)).toBe("2026-11-15T12:00:00.000Z");
  });

  it("London club in BST: this week starts at 23:00 UTC on the Sunday", async () => {
    const { checkInGtes, week } = await render("Europe/London", "2026-10-19T08:00:00Z");
    expect(checkInGtes).toContain("2026-10-18T23:00:00.000Z");
    expect(checkInGtes).toContain("2026-09-30T23:00:00.000Z");
    expect(iso(week.gte)).toBe("2026-10-18T12:00:00.000Z");
    expect(iso(week.lt)).toBe("2026-10-25T12:00:00.000Z");
  });
});
