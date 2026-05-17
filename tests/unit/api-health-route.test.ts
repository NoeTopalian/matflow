import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  },
}));

import { prisma } from "@/lib/prisma";
import { GET } from "@/app/api/health/route";

const mockedQueryRaw = vi.mocked(prisma.$queryRaw);
const mockedTransaction = vi.mocked(prisma.$transaction);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/health — round-trip optimisation", () => {
  it("calls prisma.$queryRaw directly without wrapping in a transaction", async () => {
    mockedQueryRaw.mockResolvedValue([{ "?column?": 1 }]);

    await GET();

    expect(mockedQueryRaw).toHaveBeenCalledTimes(1);
    expect(mockedTransaction).not.toHaveBeenCalled();
  });

  it("returns 200 with status=ok when the DB ping succeeds", async () => {
    mockedQueryRaw.mockResolvedValue([{ "?column?": 1 }]);

    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; db: string; timestamp: string };
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
    expect(typeof body.timestamp).toBe("string");
    expect(res.headers["Cache-Control"]).toBe("no-store");
  });

  it("returns 503 with status=degraded when the DB ping rejects", async () => {
    mockedQueryRaw.mockRejectedValue(new Error("connection refused"));

    const res = await GET();
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; db: string };
    expect(body.status).toBe("degraded");
    expect(body.db).toBe("down");
  });
});
