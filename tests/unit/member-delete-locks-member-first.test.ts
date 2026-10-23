// T7 lock order: deleteMemberCascade locks the Member row BEFORE any of the
// member-owned rows (packs above all). The check-in engine holds Class, then
// Member, then the pack; a cascade that took the pack first and then waited
// on the Member row would deadlock with it (planning evidence 8b.3 C1). The
// DSAR child cascade and the tenant purge call the cascade with no prior lock
// on that member, so the lock has to live in the cascade itself.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";
import { deleteMemberCascade } from "@/lib/member-delete";

const order: string[] = [];
const rec = (name: string, value: unknown = undefined) => vi.fn(async () => { order.push(name); return value; });

let lockRows: unknown[] = [{ id: "m1" }];
const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
  order.push(strings.join("?").includes('FROM "Member"') && strings.join("?").includes("FOR UPDATE") ? "member-lock" : "raw");
  return lockRows;
});

function makeTx() {
  return {
    $queryRaw: queryRaw,
    member: { findFirst: rec("member.findFirst", { id: "m1", name: "Alice", externalRef: null }), deleteMany: rec("member.deleteMany", { count: 1 }) },
    memberRank: { findMany: rec("memberRank.findMany", []), deleteMany: rec("memberRank.deleteMany") },
    rankHistory: { deleteMany: rec("rankHistory.deleteMany") },
    memberClassPack: { findMany: rec("memberClassPack.findMany", [{ id: "p1" }]), deleteMany: rec("memberClassPack.deleteMany") },
    classPackRedemption: { deleteMany: rec("classPackRedemption.deleteMany") },
    attendanceRecord: { deleteMany: rec("attendanceRecord.deleteMany") },
    classSubscription: { deleteMany: rec("classSubscription.deleteMany") },
    classWaitlist: { deleteMany: rec("classWaitlist.deleteMany") },
    loginEvent: { deleteMany: rec("loginEvent.deleteMany") },
    importedBooking: { deleteMany: rec("importedBooking.deleteMany") },
    importSourceMapping: { deleteMany: rec("importSourceMapping.deleteMany") },
  } as unknown as Prisma.TransactionClient;
}

beforeEach(() => {
  order.length = 0;
  lockRows = [{ id: "m1" }];
  queryRaw.mockClear();
});

describe("deleteMemberCascade - Member lock first", () => {
  it("takes Member FOR UPDATE, scoped to the tenant, before any pack, attendance or booking write", async () => {
    const out = await deleteMemberCascade(makeTx(), { id: "m1", tenantId: "t1" });
    expect(out).toEqual({ kind: "ok", name: "Alice" });
    const lock = order.indexOf("member-lock");
    expect(lock).toBeGreaterThan(-1);
    for (const write of ["memberClassPack.deleteMany", "classPackRedemption.deleteMany", "attendanceRecord.deleteMany", "classSubscription.deleteMany", "member.deleteMany"]) {
      expect(order.indexOf(write)).toBeGreaterThan(lock);
    }
    const values = queryRaw.mock.calls[0].slice(1);
    expect(values).toEqual(["m1", "t1"]);
  });

  it("writes nothing when the row is gone by the time the lock is granted", async () => {
    lockRows = [];
    const out = await deleteMemberCascade(makeTx(), { id: "m1", tenantId: "t1" });
    expect(out).toEqual({ kind: "race" });
    expect(order.filter((o) => o.endsWith("deleteMany"))).toEqual([]);
  });
});
