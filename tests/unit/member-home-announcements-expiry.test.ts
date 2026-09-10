/**
 * Task 0.2 — lib/member-home.ts `buildAnnouncementsData` (the member-home
 * bootstrap payload, a SECOND announcements read path distinct from the
 * standalone app/api/announcements/route.ts GET) must exclude expired
 * announcements for members, and the "unseen" computation must never be able
 * to mark an expired row unseen — the lane-E bug this closes was an expired
 * announcement counted "unseen" forever, which also drove the home page's
 * auto-open-first-unseen modal.
 *
 * Predicate test for the query shape (style matches
 * tests/unit/class-soft-delete-filter.test.ts) plus a direct behavioural test
 * of the belt-and-braces JS filter, so the invariant holds even if the WHERE
 * clause ever regressed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildAnnouncementsData } from "@/lib/member-home";

const earlier = new Date("2026-01-01T00:00:00Z");
const later = new Date("2026-06-01T00:00:00Z");

function whereOfCall(fn: ReturnType<typeof vi.fn>, n = 0) {
  return (fn.mock.calls[n]?.[0] as { where?: Record<string, unknown> } | undefined)?.where;
}

function fakeTx(rows: unknown[]) {
  return {
    announcement: { findMany: vi.fn(async () => rows) },
    member: { findUnique: vi.fn(async () => ({ lastAnnouncementSeenAt: null })) },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("buildAnnouncementsData — expiry", () => {
  it("member reads: the query excludes expired rows (expiresAt null OR still in the future)", async () => {
    const tx = fakeTx([]);
    await buildAnnouncementsData(tx as never, {
      tenantId: "t1",
      role: "member",
      memberId: "m1",
      take: 50,
    });

    expect(whereOfCall(tx.announcement.findMany)).toMatchObject({
      tenantId: "t1",
      OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
    });
  });

  it("staff reads: no expiry filter — staff still see expired announcements", async () => {
    const tx = fakeTx([]);
    await buildAnnouncementsData(tx as never, {
      tenantId: "t1",
      role: "owner",
      memberId: undefined,
      take: 50,
    });

    expect(whereOfCall(tx.announcement.findMany)).toEqual({ tenantId: "t1" });
  });

  it("member: an expired row is dropped and never marked unseen, even if it somehow reached the JS layer", async () => {
    // Simulates a regression where the WHERE clause stopped filtering —
    // findMany hands back an expired row alongside two valid ones. The
    // belt-and-braces filter in buildAnnouncementsData must still catch it.
    const rows = [
      { id: "expired", createdAt: later, pinned: false, expiresAt: earlier }, // in the past
      { id: "permanent", createdAt: earlier, pinned: false, expiresAt: null },
      { id: "future-expiry", createdAt: later, pinned: false, expiresAt: new Date(Date.now() + 86400000) },
    ];
    const tx = fakeTx(rows);

    const { announcements } = await buildAnnouncementsData(tx as never, {
      tenantId: "t1",
      role: "member",
      memberId: "m1",
      take: 50,
    });

    const ids = announcements.map((a) => a.id);
    expect(ids).not.toContain("expired");
    expect(ids).toContain("permanent");
    expect(ids).toContain("future-expiry");
    // The expired row can't be "unseen" if it isn't even in the array.
    expect(announcements.find((a) => a.id === "expired")).toBeUndefined();
  });

  it("staff: an expired row IS kept (staff manage expiry from the desk) and is always unseen=false", async () => {
    const rows = [{ id: "expired", createdAt: later, pinned: false, expiresAt: earlier }];
    const tx = fakeTx(rows);

    const { announcements } = await buildAnnouncementsData(tx as never, {
      tenantId: "t1",
      role: "owner",
      memberId: undefined,
      take: 50,
    });

    expect(announcements).toHaveLength(1);
    expect(announcements[0].unseen).toBe(false);
  });
});
