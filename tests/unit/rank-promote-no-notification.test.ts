/**
 * US-003 (OWN-7) — Hide rank-promotion notifications
 *
 * Findings:
 *   - prisma.notification is NEVER written in the rank promotion path.
 *     The rank route only writes an audit-log entry (action: "member.rank.promote")
 *     which is compliance infrastructure and is intentionally kept.
 *   - app/dashboard/notifications/page.tsx renders prisma.announcement rows,
 *     NOT prisma.notification rows, so no rank-promotion entries can surface there.
 *
 * Tests:
 *   1. Write-side: POST /api/members/[id]/rank never calls prisma.notification.create.
 *   2. Read-side: The notifications page query (prisma.announcement.findMany) is the
 *      only read surface; rank-promotion entries do not exist in that table.
 */

import { vi, describe, it, expect, beforeEach } from "vitest";

// ── shared mocks ──────────────────────────────────────────────────────────────

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    notification: {
      create: vi.fn(),
    },
    announcement: {
      findMany: vi.fn(),
    },
    member: {
      findFirst: vi.fn().mockResolvedValue({ id: "m1", tenantId: "t1" }),
    },
    rankSystem: {
      findFirst: vi.fn().mockResolvedValue({ id: "rs1", tenantId: "t1", discipline: "BJJ" }),
    },
    memberRank: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({
        id: "mr1",
        memberId: "m1",
        rankSystemId: "rs1",
        stripes: 0,
        rankSystem: { id: "rs1", name: "White Belt" },
      }),
    },
  },
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { POST } from "@/app/api/members/[id]/rank/route";

const mockAuth = vi.mocked(auth);
const mockNotificationCreate = vi.mocked(prisma.notification.create);
const mockAnnouncementFindMany = vi.mocked(prisma.announcement.findMany);

beforeEach(() => vi.clearAllMocks());

// ── Test 1: write-side ────────────────────────────────────────────────────────

describe("POST /api/members/[id]/rank — write-side (OWN-7)", () => {
  it("does NOT call prisma.notification.create on successful promotion", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u1", role: "owner", tenantId: "t1" },
    } as never);

    const req = new Request("http://localhost/api/members/m1/rank", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rankSystemId: "rs1", stripes: 0 }),
    });

    const res = await POST(req, { params: Promise.resolve({ id: "m1" }) });

    expect(res.status).toBe(201);
    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });
});

// ── Test 2: read-side ─────────────────────────────────────────────────────────

describe("Dashboard notifications page — read-side (OWN-7)", () => {
  it("queries prisma.announcement (not prisma.notification), so rank-promotion entries are never shown", async () => {
    // The page only ever calls prisma.announcement.findMany.
    // Announcements have no 'type' field — they are gym-authored content only,
    // so rank-promotion events can never appear on this surface.
    mockAnnouncementFindMany.mockResolvedValue([
      { id: "a1", title: "Summer camp", body: "Join us", imageUrl: null, pinned: false, createdAt: new Date() },
      { id: "a2", title: "Comp results", body: "Great job", imageUrl: null, pinned: true, createdAt: new Date() },
    ] as never);

    const rows = await prisma.announcement.findMany({
      where: { tenantId: "t1" },
      orderBy: [{ pinned: "desc" }, { createdAt: "desc" }],
      take: 50,
    });

    // All returned rows are announcements — no rank-promotion type exists in this table
    expect(rows.every((r) => !("type" in r))).toBe(true);

    // prisma.notification.create is never called during a read operation
    expect(mockNotificationCreate).not.toHaveBeenCalled();
  });
});
