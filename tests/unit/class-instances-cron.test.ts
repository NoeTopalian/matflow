/**
 * Task 3a — nothing regenerated ClassInstance rows.
 *
 * They were minted only by two manual endpoints, both defaulting to a four-week
 * window, and vercel.json declared no cron for them. So about four weeks after
 * the last time a staff member happened to press "Generate":
 *
 *   /api/member/schedule returns `classInstanceId: null`
 *   → app/member/home only offers check-in `if (cls.classInstanceId)`
 *   → /api/checkin requires one
 *   → members silently cannot check in and staff see an empty register.
 *
 * Silent, on the screen the gym runs its front door on. These tests pin the
 * three things that make the nightly job safe to run unattended: it is
 * unreachable without CRON_SECRET, its horizon is far wider than the gap
 * between runs, and one gym's failure cannot take the rest of the estate down.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/prisma-tenant", async () => {
  const { prisma } = await import("@/lib/prisma");
  return {
    withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => fn(prisma),
    withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn(prisma),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findMany: vi.fn() },
    class: { findMany: vi.fn() },
    classInstance: { createMany: vi.fn() },
  },
}));

import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/cron/class-instances/route";

const SECRET = "test-cron-secret";
const NOW = new Date("2026-08-19T02:40:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

function req(auth?: string) {
  return new Request("https://matflow.studio/api/cron/class-instances", {
    headers: auth ? { authorization: auth } : {},
  });
}

type Body = {
  ok: boolean;
  windowFrom: string;
  windowTo: string;
  created: number;
  tenantsProcessed: number;
  results: Array<{ tenantId: string; created?: number; error?: string; skipped?: boolean; partial?: boolean }>;
};

/** One class with a single Monday schedule — 8 Mondays inside a 56-day window. */
const MONDAY_CLASS = [
  {
    id: "c1",
    schedules: [
      { dayOfWeek: 1, startTime: "18:00", endTime: "19:00", startDate: new Date("2020-01-01"), endDate: null },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  process.env.CRON_SECRET = SECRET;
  vi.mocked(prisma.tenant.findMany).mockResolvedValue([{ id: "t1" }] as never);
  vi.mocked(prisma.class.findMany).mockResolvedValue(MONDAY_CLASS as never);
  vi.mocked(prisma.classInstance.createMany).mockResolvedValue({ count: 8 } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

// ─── Auth ─────────────────────────────────────────────────────────────────────

describe("GET /api/cron/class-instances — auth", () => {
  it("503s when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;
    const res = await GET(req("Bearer anything"));
    expect(res.status).toBe(503);
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  it("401s with no Authorization header", async () => {
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(prisma.tenant.findMany).not.toHaveBeenCalled();
  });

  it("401s with the wrong bearer token", async () => {
    const res = await GET(req("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(prisma.classInstance.createMany).not.toHaveBeenCalled();
  });

  it("runs with the correct bearer token", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Body;
    expect(body.ok).toBe(true);
    expect(body.created).toBe(8);
  });
});

// ─── It is actually wired up, and on a schedule the Hobby plan allows ────────

describe("the cron is registered in vercel.json", () => {
  const vercel = JSON.parse(
    readFileSync(resolve(__dirname, "../../vercel.json"), "utf8"),
  ) as { crons: Array<{ path: string; schedule: string }> };

  it("declares /api/cron/class-instances", () => {
    // The whole defect was that no cron existed. A route nobody calls is the
    // same outage with more code.
    expect(vercel.crons.map((c) => c.path)).toContain("/api/cron/class-instances");
  });

  it("runs DAILY — the Vercel Hobby plan permits nothing finer", () => {
    const cron = vercel.crons.find((c) => c.path === "/api/cron/class-instances")!;
    const [minute, hour, dom, month, dow] = cron.schedule.split(" ");
    // A fixed minute and hour, every day of every month, any weekday.
    expect(minute).toMatch(/^\d+$/);
    expect(hour).toMatch(/^\d+$/);
    expect(dom).toBe("*");
    expect(month).toBe("*");
    expect(dow).toBe("*");
  });

  it("does not collide with the other two crons' slots", () => {
    const slots = vercel.crons.map((c) => c.schedule.split(" ").slice(0, 2).join(":"));
    expect(new Set(slots).size).toBe(slots.length);
  });
});

// ─── The window is the fix ───────────────────────────────────────────────────

describe("GET /api/cron/class-instances — rolling window", () => {
  it("keeps 56 days generated, so a missed run cannot break check-in", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as Body;

    const from = new Date(body.windowFrom).getTime();
    const to = new Date(body.windowTo).getTime();
    expect(to - from).toBe(56 * DAY_MS);

    // The point of the number: the horizon has to dwarf the gap between runs.
    // Daily cron + 56-day horizon = 55 consecutive failed nights before a
    // single member loses the ability to check in.
    expect(to - from).toBeGreaterThan(7 * DAY_MS);
  });

  it("starts the window at today's midnight, not at some point mid-day", async () => {
    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as Body;
    const from = new Date(body.windowFrom);
    expect(from.getHours()).toBe(0);
    expect(from.getMinutes()).toBe(0);
    expect(from.getSeconds()).toBe(0);
    expect(from.getMilliseconds()).toBe(0);
  });

  it("generates every occurrence in the window, not just the next four weeks", async () => {
    await GET(req(`Bearer ${SECRET}`));
    const args = vi.mocked(prisma.classInstance.createMany).mock.calls[0][0] as {
      data: Array<{ date: Date }>;
      skipDuplicates: boolean;
    };
    // 56 days from a Wednesday contains 8 Mondays.
    expect(args.data).toHaveLength(8);
    expect(args.skipDuplicates).toBe(true);
  });
});

// ─── What it will and will not generate for ──────────────────────────────────

describe("GET /api/cron/class-instances — scope", () => {
  it("only considers live tenants", async () => {
    await GET(req(`Bearer ${SECRET}`));
    expect(prisma.tenant.findMany).toHaveBeenCalledWith({
      where: { subscriptionStatus: { in: ["active", "trial"] }, deletedAt: null },
      select: { id: true },
    });
  });

  it("skips paused and removed classes, and inactive schedules", async () => {
    await GET(req(`Bearer ${SECRET}`));
    const args = vi.mocked(prisma.class.findMany).mock.calls[0][0] as {
      where: Record<string, unknown>;
      select: { schedules: { where: Record<string, unknown> } };
    };
    // Minting instances for a removed class would put it back on the check-in
    // screen while every list filters it out.
    expect(args.where).toMatchObject({ tenantId: "t1", isActive: true, deletedAt: null });
    expect(args.select.schedules.where).toMatchObject({ isActive: true });
  });

  it("writes nothing when a tenant has no schedules", async () => {
    vi.mocked(prisma.class.findMany).mockResolvedValue([] as never);
    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as Body;
    expect(prisma.classInstance.createMany).not.toHaveBeenCalled();
    expect(body.results[0]).toMatchObject({ tenantId: "t1", created: 0 });
    expect(body.ok).toBe(true);
  });
});

// ─── Independence and the runtime cap ────────────────────────────────────────

describe("GET /api/cron/class-instances — one gym cannot break the estate", () => {
  it("keeps generating for the other tenants when one throws, and reports 500", async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([
      { id: "t1" },
      { id: "t2" },
      { id: "t3" },
    ] as never);
    vi.mocked(prisma.class.findMany).mockImplementation((async (args: { where: { tenantId: string } }) => {
      if (args.where.tenantId === "t2") throw new Error("connection reset");
      return MONDAY_CLASS;
    }) as never);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as Body;

    // 200 + ok:false is invisible to every uptime check.
    expect(res.status).toBe(500);
    expect(body.ok).toBe(false);
    expect(body.results.find((r) => r.tenantId === "t2")?.error).toBe("connection reset");
    expect(body.results.find((r) => r.tenantId === "t1")?.created).toBe(8);
    expect(body.results.find((r) => r.tenantId === "t3")?.created).toBe(8);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it("stops starting new tenants past the deadline and reports them skipped", async () => {
    vi.mocked(prisma.tenant.findMany).mockResolvedValue([{ id: "t1" }, { id: "t2" }] as never);
    vi.mocked(prisma.class.findMany).mockImplementation((async () => {
      vi.advanceTimersByTime(241_000);
      return MONDAY_CLASS;
    }) as never);

    const res = await GET(req(`Bearer ${SECRET}`));
    const body = (await res.json()) as Body;

    // A truncated sweep is a healthy sweep: every row is idempotent under the
    // unique constraint, so tomorrow's run re-derives and re-inserts nothing.
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.results.find((r) => r.tenantId === "t2")).toMatchObject({ skipped: true });
    expect(prisma.class.findMany).toHaveBeenCalledTimes(1);
  });

  it("chunks a large tenant into batches so a timeout lands on a committed boundary", async () => {
    // 30 schedules x 8 Mondays = 240 rows… bump it past the 500-row batch.
    const manySchedules = [
      {
        id: "c1",
        schedules: Array.from({ length: 80 }, (_, i) => ({
          dayOfWeek: i % 7,
          startTime: `${String(6 + (i % 12)).padStart(2, "0")}:00`,
          endTime: `${String(7 + (i % 12)).padStart(2, "0")}:00`,
          startDate: new Date("2020-01-01"),
          endDate: null,
        })),
      },
    ];
    vi.mocked(prisma.class.findMany).mockResolvedValue(manySchedules as never);
    vi.mocked(prisma.classInstance.createMany).mockResolvedValue({ count: 500 } as never);

    await GET(req(`Bearer ${SECRET}`));

    const calls = vi.mocked(prisma.classInstance.createMany).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const [args] of calls) {
      expect((args as { data: unknown[] }).data.length).toBeLessThanOrEqual(500);
    }
  });
});
