import { vi, describe, it, expect, beforeEach } from "vitest";

// LB-006 (audit H5): /api/classes/[id]/instances POST handler must batch-fetch
// existing instances with one findMany — not loop with findFirst per date.

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { classFindFirst, instanceFindMany, instanceCreateMany } = vi.hoisted(() => ({
  classFindFirst: vi.fn(),
  instanceFindMany: vi.fn(),
  instanceCreateMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    class: { findFirst: classFindFirst },
    classInstance: { findMany: instanceFindMany, createMany: instanceCreateMany },
  },
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", tenantId: "tenant-A", role: "owner" } as unknown,
  })),
}));

import { POST } from "@/app/api/classes/[id]/instances/route";

beforeEach(() => {
  vi.clearAllMocks();
  classFindFirst.mockResolvedValue({
    id: "class-1",
    schedules: [
      { dayOfWeek: 1, startTime: "10:00", endTime: "11:00" }, // Mondays
      { dayOfWeek: 4, startTime: "18:00", endTime: "19:00" }, // Thursdays
    ],
  });
  instanceFindMany.mockResolvedValue([]);
  instanceCreateMany.mockResolvedValue({ count: 8 });
});

const params = Promise.resolve({ id: "class-1" });

function makeReq(weeks = 4) {
  return new Request("http://localhost/api/classes/class-1/instances", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ weeks }),
  });
}

describe("POST /api/classes/[id]/instances — N+1 elimination", () => {
  it("calls classInstance.findMany exactly ONCE regardless of how many candidate dates exist", async () => {
    // 4 weeks × 2 schedules = 8 candidate dates. The pre-fix code would have
    // called findFirst 8 times (one per date). The fix uses one findMany.
    const res = await POST(makeReq(4), { params });
    expect(res.status).toBe(200);
    expect(instanceFindMany).toHaveBeenCalledTimes(1);
  });

  it("scales to many weeks without scaling DB calls", async () => {
    // 26 weeks × 2 schedules = 52 candidate dates → still only one findMany.
    const res = await POST(makeReq(26), { params });
    expect(res.status).toBe(200);
    expect(instanceFindMany).toHaveBeenCalledTimes(1);
  });

  it("filters duplicates against the existing-keys Set in JS, not via SQL", async () => {
    instanceFindMany.mockResolvedValueOnce([
      { date: new Date("2026-05-04T00:00:00.000Z"), startTime: "10:00" },
    ]);
    await POST(makeReq(4), { params });
    // createMany should still be called (other dates remain), but skipDuplicates
    // is the only safety belt — the JS-side Set should also exclude the match.
    expect(instanceCreateMany).toHaveBeenCalledTimes(1);
    const createArgs = instanceCreateMany.mock.calls[0][0] as { data: { date: Date; startTime: string }[] };
    const hasMatch = createArgs.data.some(
      (d) => d.date.toISOString() === "2026-05-04T00:00:00.000Z" && d.startTime === "10:00",
    );
    expect(hasMatch).toBe(false);
  });
});
