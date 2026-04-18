import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    class: { findMany: vi.fn() },
    classInstance: { findMany: vi.fn() },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/member/schedule/route";

const mockAuth = vi.mocked(auth);
const mockClassFindMany = vi.mocked(prisma.class.findMany as (...args: unknown[]) => unknown);
const mockInstanceFindMany = vi.mocked(prisma.classInstance.findMany as (...args: unknown[]) => unknown);

const MOCK_CLASSES = [
  {
    id: "class-1",
    name: "No-Gi",
    coachName: "Coach Mike",
    location: "Mat 1",
    maxCapacity: 20,
    schedules: [{ id: "sched-1", dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }], // Monday
  },
  {
    id: "class-2",
    name: "Kids BJJ",
    coachName: "Coach Emma",
    location: "Mat 2",
    maxCapacity: 12,
    schedules: [{ id: "sched-2", dayOfWeek: 0, startTime: "10:00", endTime: "11:00" }], // Sunday
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({ user: { tenantId: "tenant-1" } } as never);
  mockClassFindMany.mockResolvedValue(MOCK_CLASSES as never);
  mockInstanceFindMany.mockResolvedValue([]);
});

describe("GET /api/member/schedule — dayOfWeek convention", () => {
  it("returns the correct dayOfWeek value for each class", async () => {
    const res = await GET(new Request("http://localhost/api/member/schedule"));
    const data = await res.json();
    expect(data.find((c: { name: string }) => c.name === "No-Gi").dayOfWeek).toBe(1);
    expect(data.find((c: { name: string }) => c.name === "Kids BJJ").dayOfWeek).toBe(0);
  });

  it("returns classInstanceId as null when no ?date param", async () => {
    const res = await GET(new Request("http://localhost/api/member/schedule"));
    const data = await res.json();
    for (const cls of data) {
      expect(cls.classInstanceId).toBeNull();
    }
  });

  it("populates classInstanceId when ?date matches a ClassInstance", async () => {
    mockInstanceFindMany.mockResolvedValue([
      { id: "inst-42", classId: "class-1", startTime: "18:00" },
    ] as never);
    const res = await GET(new Request("http://localhost/api/member/schedule?date=2026-04-20"));
    const data = await res.json();
    const noGi = data.find((c: { name: string }) => c.name === "No-Gi");
    expect(noGi.classInstanceId).toBe("inst-42");
  });

  it("leaves classInstanceId null for classes without a matching instance", async () => {
    mockInstanceFindMany.mockResolvedValue([
      { id: "inst-42", classId: "class-1", startTime: "18:00" },
    ] as never);
    const res = await GET(new Request("http://localhost/api/member/schedule?date=2026-04-20"));
    const data = await res.json();
    const kids = data.find((c: { name: string }) => c.name === "Kids BJJ");
    expect(kids.classInstanceId).toBeNull();
  });
});
