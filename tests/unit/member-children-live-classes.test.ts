// T6b acceptance 1: a paused or archived class disappears from member Home —
// including the parent's view of their children's timetable. Pausing keeps
// the ClassSubscription rows and the sessions already minted, so the kids
// timetable must filter on the class's lifecycle, not just the subscription.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildMemberChildren } from "@/lib/member-home";
import { liveClassWhere } from "@/lib/class-live";

function fakeTx() {
  return {
    member: {
      findMany: vi.fn(async () => [
        { id: "kid-1", name: "Alex", dateOfBirth: null, accountType: "junior", waiverAccepted: true, memberRanks: [], _count: { attendances: 0 } },
      ]),
    },
    classSubscription: { findMany: vi.fn(async () => [{ memberId: "kid-1", classId: "c-paused" }]) },
    classInstance: { findMany: vi.fn(async () => []) },
  };
}

describe("buildMemberChildren — kids timetable", () => {
  it("reads only live classes' sessions (a paused or archived subscribed class is absent), never imported history", async () => {
    const tx = fakeTx();
    const kids = await buildMemberChildren(tx as never, { tenantId: "t1", memberId: "parent-1", includeTimetable: true });
    expect(kids[0].timetable).toEqual([]);
    const where = (tx.classInstance.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }])[0].where;
    expect(where.class).toEqual(liveClassWhere("t1"));
    expect(where.sourceImportJobId).toBeNull();
    // Cancelled sessions stay: the view flags them.
    expect("isCancelled" in where).toBe(false);
  });
});

describe("GET /api/member/me/children — same filter", () => {
  it("the standalone route filters its instance read on liveClassWhere", () => {
    const src = readFileSync(join(process.cwd(), "app/api/member/me/children/route.ts"), "utf8");
    expect(src).toMatch(/class:\s*liveClassWhere\(session\.user\.tenantId\)/);
    expect(src).toMatch(/sourceImportJobId:\s*null/);
  });
});
