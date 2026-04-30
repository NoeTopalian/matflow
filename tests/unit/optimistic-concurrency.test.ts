import { vi, describe, it, expect, beforeEach } from "vitest";

// Sprint 5 US-508: optimistic concurrency on /api/members/[id] and /api/staff/[id] PATCH.
// Client sends body.updatedAt — server's updateMany WHERE includes that timestamp.
// On count===0, server distinguishes 404 (gone) from 409 (someone else won the write).

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
    member: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
      updateMany: vi.fn(),
    },
  },
}));

vi.mock("@/lib/audit-log", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("bcryptjs", () => ({
  default: { hash: vi.fn().mockResolvedValue("hashed") },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";

const mockAuth = vi.mocked(auth);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { id: "user-1", role: "owner", tenantId: "tenant-A" },
  } as never);
});

function patch(url: string, body: object) {
  return new Request(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ── /api/members/[id] PATCH ───────────────────────────────────────────────────

describe("PATCH /api/members/[id] — optimistic concurrency", () => {
  it("returns 409 when client updatedAt is stale (row exists but not matched)", async () => {
    const { PATCH } = await import("@/app/api/members/[id]/route");
    vi.mocked(prisma.member.updateMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.member.findFirst).mockResolvedValue({
      updatedAt: new Date("2026-04-30T12:00:00Z"),
    } as never);

    const res = await PATCH(
      patch("http://localhost/api/members/m-1", {
        name: "Alice",
        updatedAt: "2026-04-30T11:00:00Z", // older than server
      }),
      { params: Promise.resolve({ id: "m-1" }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.currentUpdatedAt).toBe("2026-04-30T12:00:00.000Z");
  });

  it("returns 404 when the member doesn't exist (no row, no concurrency drama)", async () => {
    const { PATCH } = await import("@/app/api/members/[id]/route");
    vi.mocked(prisma.member.updateMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);

    const res = await PATCH(
      patch("http://localhost/api/members/missing", {
        name: "Alice",
        updatedAt: "2026-04-30T11:00:00Z",
      }),
      { params: Promise.resolve({ id: "missing" }) },
    );
    expect(res.status).toBe(404);
  });

  it("backward compatible: no updatedAt sent → no concurrency check, normal 404 on missing", async () => {
    const { PATCH } = await import("@/app/api/members/[id]/route");
    vi.mocked(prisma.member.updateMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.member.findFirst).mockResolvedValue(null);

    const res = await PATCH(
      patch("http://localhost/api/members/missing", { name: "Alice" }),
      { params: Promise.resolve({ id: "missing" }) },
    );
    expect(res.status).toBe(404);
  });

  it("happy path: updatedAt matches → row updated", async () => {
    const { PATCH } = await import("@/app/api/members/[id]/route");
    vi.mocked(prisma.member.updateMany).mockResolvedValue({ count: 1 } as never);
    vi.mocked(prisma.member.findUnique).mockResolvedValue({ id: "m-1", name: "Alice" } as never);

    const res = await PATCH(
      patch("http://localhost/api/members/m-1", {
        name: "Alice",
        updatedAt: "2026-04-30T12:00:00Z",
      }),
      { params: Promise.resolve({ id: "m-1" }) },
    );
    expect(res.status).toBe(200);
  });
});

// ── /api/staff/[id] PATCH ─────────────────────────────────────────────────────

describe("PATCH /api/staff/[id] — optimistic concurrency", () => {
  it("returns 409 when client updatedAt is stale", async () => {
    const { PATCH } = await import("@/app/api/staff/[id]/route");
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      updatedAt: new Date("2026-04-30T12:00:00Z"),
    } as never);

    const res = await PATCH(
      patch("http://localhost/api/staff/u-1", {
        name: "Coach Mike",
        updatedAt: "2026-04-30T11:00:00Z",
      }),
      { params: Promise.resolve({ id: "u-1" }) },
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.currentUpdatedAt).toBe("2026-04-30T12:00:00.000Z");
  });

  it("returns 404 when the staff member is missing (or is the owner)", async () => {
    const { PATCH } = await import("@/app/api/staff/[id]/route");
    vi.mocked(prisma.user.updateMany).mockResolvedValue({ count: 0 } as never);
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

    const res = await PATCH(
      patch("http://localhost/api/staff/owner-id", {
        name: "Owner",
        updatedAt: "2026-04-30T12:00:00Z",
      }),
      { params: Promise.resolve({ id: "owner-id" }) },
    );
    expect(res.status).toBe(404);
  });
});
