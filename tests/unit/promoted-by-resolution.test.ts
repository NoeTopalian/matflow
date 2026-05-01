import { vi, describe, it, expect, beforeEach } from "vitest";

// LB-007 (audit H4): MemberRank.promotedBy must resolve the promoter's
// User.name when promotedById is set.

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const { memberFindFirst, userFindMany } = vi.hoisted(() => ({
  memberFindFirst: vi.fn(),
  userFindMany: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: { findFirst: memberFindFirst },
    user: { findMany: userFindMany },
  },
}));

vi.mock("@/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "owner-1", tenantId: "t-A" } as unknown,
  })),
}));

import { GET } from "@/app/api/members/[id]/route";

beforeEach(() => {
  vi.clearAllMocks();
});

const params = Promise.resolve({ id: "mem-1" });

describe("GET /api/members/[id] — promotedBy resolution", () => {
  it("attaches promoter {id, name} when promotedById is set", async () => {
    memberFindFirst.mockResolvedValueOnce({
      id: "mem-1",
      memberRanks: [
        {
          id: "rank-1", promotedById: "user-coach-mike", rankSystem: { name: "Blue Belt" },
          rankHistory: [],
        },
      ],
    });
    userFindMany.mockResolvedValueOnce([{ id: "user-coach-mike", name: "Coach Mike" }]);

    const res = await GET(new Request("http://localhost/api/members/mem-1"), { params });
    const body = await res.json();

    expect(body.memberRanks[0].promotedBy).toEqual({ id: "user-coach-mike", name: "Coach Mike" });
  });

  it("attaches promoter for rankHistory entries too", async () => {
    memberFindFirst.mockResolvedValueOnce({
      id: "mem-1",
      memberRanks: [
        {
          id: "rank-1", promotedById: "user-coach-mike", rankSystem: { name: "Blue Belt" },
          rankHistory: [
            { id: "h-1", promotedById: "user-coach-sarah", notes: "1st stripe" },
          ],
        },
      ],
    });
    userFindMany.mockResolvedValueOnce([
      { id: "user-coach-mike", name: "Coach Mike" },
      { id: "user-coach-sarah", name: "Coach Sarah" },
    ]);

    const res = await GET(new Request("http://localhost/api/members/mem-1"), { params });
    const body = await res.json();

    expect(body.memberRanks[0].rankHistory[0].promotedBy).toEqual({
      id: "user-coach-sarah", name: "Coach Sarah",
    });
  });

  it("returns null when promotedById is null (not yet promoted by anyone)", async () => {
    memberFindFirst.mockResolvedValueOnce({
      id: "mem-1",
      memberRanks: [
        { id: "rank-1", promotedById: null, rankSystem: { name: "White Belt" }, rankHistory: [] },
      ],
    });
    userFindMany.mockResolvedValueOnce([]);

    const res = await GET(new Request("http://localhost/api/members/mem-1"), { params });
    const body = await res.json();
    expect(body.memberRanks[0].promotedBy).toBeNull();
  });

  it("returns null when the promoter user no longer exists (deleted staff)", async () => {
    memberFindFirst.mockResolvedValueOnce({
      id: "mem-1",
      memberRanks: [
        { id: "rank-1", promotedById: "deleted-user", rankSystem: { name: "Purple Belt" }, rankHistory: [] },
      ],
    });
    userFindMany.mockResolvedValueOnce([]); // promoter not found

    const res = await GET(new Request("http://localhost/api/members/mem-1"), { params });
    const body = await res.json();
    expect(body.memberRanks[0].promotedBy).toBeNull();
  });
});
