import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Prisma } from "@prisma/client";
import { deleteMemberCascade } from "@/lib/member-delete";

/**
 * Deleting a member must take their imported history with them.
 *
 * ImportedBooking.memberId is ON DELETE SET NULL: left to the database, the row
 * survives with the source's name and email on it, attached to nobody. And the
 * owner's person mapping (ImportSourceMapping kind=person) keys on
 * "teamup:<email>|<name>". Both are deleted explicitly by the cascade walk.
 */

const fake = {
  member: { findFirst: vi.fn(), deleteMany: vi.fn() },
  memberRank: { findMany: vi.fn(), deleteMany: vi.fn() },
  rankHistory: { deleteMany: vi.fn() },
  memberClassPack: { findMany: vi.fn(), deleteMany: vi.fn() },
  classPackRedemption: { deleteMany: vi.fn() },
  attendanceRecord: { deleteMany: vi.fn() },
  classSubscription: { deleteMany: vi.fn() },
  classWaitlist: { deleteMany: vi.fn() },
  loginEvent: { deleteMany: vi.fn() },
  importedBooking: { deleteMany: vi.fn() },
  importSourceMapping: { deleteMany: vi.fn() },
};
const tx = fake as unknown as Prisma.TransactionClient;

beforeEach(() => {
  for (const d of Object.values(fake)) for (const f of Object.values(d)) f.mockReset();
  fake.memberRank.findMany.mockResolvedValue([]);
  fake.memberClassPack.findMany.mockResolvedValue([]);
  fake.member.deleteMany.mockResolvedValue({ count: 1 });
});

describe("deleteMemberCascade — imported history", () => {
  it("deletes the member's ImportedBooking rows and person mappings (by target and by externalRef) before the member", async () => {
    fake.member.findFirst.mockResolvedValue({ id: "m1", name: "Alice", externalRef: "teamup:alice@example.com|Alice" });

    const out = await deleteMemberCascade(tx, { id: "m1", tenantId: "t1" });

    expect(out).toEqual({ kind: "ok", name: "Alice" });
    expect(fake.importedBooking.deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", memberId: "m1" } });
    expect(fake.importSourceMapping.deleteMany).toHaveBeenCalledWith({
      where: {
        tenantId: "t1",
        kind: "person",
        OR: [{ targetId: "m1" }, { sourceKey: "teamup:alice@example.com|Alice" }],
      },
    });
    expect(fake.importedBooking.deleteMany.mock.invocationCallOrder[0]).toBeLessThan(
      fake.member.deleteMany.mock.invocationCallOrder[0],
    );
  });

  it("matches mappings by target only when the member has no externalRef", async () => {
    fake.member.findFirst.mockResolvedValue({ id: "m2", name: "Bob", externalRef: null });

    await deleteMemberCascade(tx, { id: "m2", tenantId: "t1" });

    expect(fake.importSourceMapping.deleteMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", kind: "person", OR: [{ targetId: "m2" }] },
    });
  });

  it("touches nothing when the member is not found", async () => {
    fake.member.findFirst.mockResolvedValue(null);

    expect(await deleteMemberCascade(tx, { id: "nope", tenantId: "t1" })).toEqual({ kind: "not-found" });
    expect(fake.importedBooking.deleteMany).not.toHaveBeenCalled();
    expect(fake.importSourceMapping.deleteMany).not.toHaveBeenCalled();
  });
});
