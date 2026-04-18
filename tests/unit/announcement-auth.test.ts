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
    announcement: {
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: "ann-1", title: "T", body: "B", pinned: false, imageUrl: null }),
    },
  },
}));

import { auth } from "@/auth";
import { POST } from "@/app/api/announcements/route";

const mockAuth = vi.mocked(auth);

beforeEach(() => vi.clearAllMocks());

const VALID_BODY = JSON.stringify({ title: "Test announcement", body: "This is the body content." });

function makeReq() {
  return new Request("http://localhost/api/announcements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: VALID_BODY,
  });
}

describe("POST /api/announcements — role guard", () => {
  it("allows owner to create (201)", async () => {
    mockAuth.mockResolvedValue({ user: { role: "owner", tenantId: "t1" } } as never);
    expect((await POST(makeReq())).status).toBe(201);
  });

  it("allows manager to create (201)", async () => {
    mockAuth.mockResolvedValue({ user: { role: "manager", tenantId: "t1" } } as never);
    expect((await POST(makeReq())).status).toBe(201);
  });

  it("forbids coach (403)", async () => {
    mockAuth.mockResolvedValue({ user: { role: "coach", tenantId: "t1" } } as never);
    expect((await POST(makeReq())).status).toBe(403);
  });

  it("forbids member (403)", async () => {
    mockAuth.mockResolvedValue({ user: { role: "member", tenantId: "t1" } } as never);
    expect((await POST(makeReq())).status).toBe(403);
  });

  it("forbids admin (403)", async () => {
    mockAuth.mockResolvedValue({ user: { role: "admin", tenantId: "t1" } } as never);
    expect((await POST(makeReq())).status).toBe(403);
  });

  it("returns 401 when no session", async () => {
    mockAuth.mockResolvedValue(null as never);
    expect((await POST(makeReq())).status).toBe(401);
  });
});
