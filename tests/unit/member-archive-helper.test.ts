import { describe, it, expect, vi } from "vitest";
import { archiveMember, archiveParentMemberWithKidsResolution, restoreMember } from "@/lib/member-delete";

/**
 * PR 3 (6 Nov 2026): the archive helpers write archivedAt and never delete.
 * A fake transaction client records every call; any delete would show up as
 * a call to a *delete* method, which the fake does not even provide.
 */
type Row = { id: string; name: string; tenantId: string; parentMemberId: string | null; accountType: string; archivedAt: Date | null; archivedById: string | null };

function fakeTx(rows: Row[]) {
  const matches = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      // NOT { AND: [startsWith "deleted-", endsWith "@deleted.invalid"] } — the erased-address exclusion.
      if (k === "NOT") return !/^deleted-.*@deleted\.invalid$/.test(String((r as Record<string, unknown>).email ?? ""));
      const val = (r as Record<string, unknown>)[k];
      if (v && typeof v === "object" && !(v instanceof Date)) {
        const o = v as Record<string, unknown>;
        if ("not" in o) return o.not === null ? val !== null : val !== o.not;
        if ("in" in o) return (o.in as unknown[]).includes(val);
      }
      if (v instanceof Date) return val instanceof Date && val.getTime() === v.getTime();
      return val === v;
    });
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "locked" }]),
    auditLog: { findFirst: vi.fn(async () => null) },
    member: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.find((r) => matches(r, where)) ?? null),
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => rows.filter((r) => matches(r, where))),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        const hit = rows.filter((r) => matches(r, where));
        for (const r of hit) for (const [k, v] of Object.entries(data)) if (k !== "sessionVersion") (r as Record<string, unknown>)[k] = v;
        return { count: hit.length };
      }),
    },
  };
  return tx;
}

const row = (id: string, extra: Partial<Row> = {}): Row => ({ id, name: id, tenantId: "t1", parentMemberId: null, accountType: "adult", archivedAt: null, archivedById: null, ...extra });
const AT = new Date("2026-11-06T09:30:00.000Z");

describe("archiveMember", () => {
  it("stamps archivedAt and who, and bumps the session version", async () => {
    const rows = [row("m1")];
    const tx = fakeTx(rows);
    const out = await archiveMember(tx as never, { id: "m1", tenantId: "t1" }, { userId: "u1", at: AT });
    expect(out).toEqual({ kind: "ok", name: "m1" });
    expect(rows[0]).toMatchObject({ archivedAt: AT, archivedById: "u1" });
    expect(tx.member.updateMany.mock.calls[0][0].data).toMatchObject({ sessionVersion: { increment: 1 } });
  });

  it("an already-archived member is not found", async () => {
    const tx = fakeTx([row("m1", { archivedAt: AT })]);
    expect(await archiveMember(tx as never, { id: "m1", tenantId: "t1" }, { userId: "u1", at: new Date() })).toEqual({ kind: "not-found" });
  });

  it("a member gone from under the lock is a race", async () => {
    const tx = fakeTx([row("m1")]);
    tx.$queryRaw.mockResolvedValueOnce([]);
    expect(await archiveMember(tx as never, { id: "m1", tenantId: "t1" }, { userId: "u1", at: AT })).toEqual({ kind: "race" });
  });
});

describe("archiveParentMemberWithKidsResolution", () => {
  it("asks for a choice when current kids exist, and writes nothing", async () => {
    const rows = [row("p"), row("k", { parentMemberId: "p", accountType: "kids" })];
    const tx = fakeTx(rows);
    const out = await archiveParentMemberWithKidsResolution(tx as never, { id: "p", tenantId: "t1" }, undefined, { userId: "u1", at: AT });
    expect(out).toEqual({ kind: "kids-present", kids: [{ id: "k", name: "k" }] });
    expect(tx.member.updateMany).not.toHaveBeenCalled();
  });

  it("cascade archives the kids with the parent's instant; orphan clears the link and keeps the kid current", async () => {
    const rows = [row("p"), row("k", { parentMemberId: "p", accountType: "kids" })];
    const out = await archiveParentMemberWithKidsResolution(fakeTx(rows) as never, { id: "p", tenantId: "t1" }, { kind: "cascade" }, { userId: "u1", at: AT });
    expect(out).toMatchObject({ kind: "ok", kidsAffected: 1, kidIds: ["k"] });
    expect(rows.map((r) => r.archivedAt)).toEqual([AT, AT]);

    const rows2 = [row("p"), row("k", { parentMemberId: "p", accountType: "kids" })];
    const out2 = await archiveParentMemberWithKidsResolution(fakeTx(rows2) as never, { id: "p", tenantId: "t1" }, { kind: "orphan" }, { userId: "u1", at: AT });
    expect(out2).toMatchObject({ kind: "ok", kidsAffected: 1 });
    expect(rows2[1]).toMatchObject({ archivedAt: null, parentMemberId: null, accountType: "junior" });
    expect(rows2[0].archivedAt).toEqual(AT);
  });

  it("a kid already archived on its own is not asked about", async () => {
    const rows = [row("p"), row("k", { parentMemberId: "p", accountType: "kids", archivedAt: new Date("2026-01-01") })];
    const out = await archiveParentMemberWithKidsResolution(fakeTx(rows) as never, { id: "p", tenantId: "t1" }, undefined, { userId: "u1", at: AT });
    expect(out).toMatchObject({ kind: "ok", kidsAffected: 0 });
  });
});

describe("restoreMember", () => {
  it("restores the member and only the kids archived with them", async () => {
    const earlier = new Date("2026-01-01T00:00:00.000Z");
    const rows = [
      row("p", { archivedAt: AT, archivedById: "u1" }),
      row("k1", { parentMemberId: "p", accountType: "kids", archivedAt: AT, archivedById: "u1" }),
      row("k2", { parentMemberId: "p", accountType: "kids", archivedAt: earlier }),
    ];
    const out = await restoreMember(fakeTx(rows) as never, { id: "p", tenantId: "t1" });
    expect(out).toEqual({ kind: "ok", name: "p", restoredKidIds: ["k1"], subscriptionEnding: false });
    expect(rows.map((r) => r.archivedAt)).toEqual([null, null, earlier]);
    expect(rows[0].archivedById).toBeNull();
  });

  it("a member who is already current is answered as such (idempotent), and an unknown id is not found", async () => {
    expect(await restoreMember(fakeTx([row("m1")]) as never, { id: "m1", tenantId: "t1" })).toEqual({ kind: "already-current", name: "m1" });
    expect(await restoreMember(fakeTx([row("m1")]) as never, { id: "nope", tenantId: "t1" })).toEqual({ kind: "not-found" });
  });

  it("refuses an erased member, and a child whose parent is still archived", async () => {
    const erased = row("e1", { archivedAt: AT });
    (erased as Record<string, unknown>).email = "deleted-e1@deleted.invalid";
    expect(await restoreMember(fakeTx([erased]) as never, { id: "e1", tenantId: "t1" })).toEqual({ kind: "erased" });
    const tx = fakeTx([row("p", { archivedAt: AT }), row("k", { parentMemberId: "p", accountType: "kids", archivedAt: new Date("2026-01-01") })]);
    tx.$queryRaw.mockResolvedValueOnce([{ id: "k", name: "k", email: "k@example.test", archivedAt: AT }, { id: "p", name: "Parent P", email: "p@example.test", archivedAt: AT }] as never);
    expect(await restoreMember(tx as never, { id: "k", tenantId: "t1" })).toEqual({ kind: "parent-archived", parentName: "Parent P" });
    // Locked in ONE statement, in id order (the archive route's order).
    expect(String((tx.$queryRaw.mock.calls as unknown as unknown[][])[0][0])).toMatch(/ORDER BY "id"[\s\S]*FOR UPDATE/);
  });

  it("a child whose parent was ERASED comes back as if it had none, and says so", async () => {
    const rows = [row("p", { archivedAt: AT }), row("k", { parentMemberId: "p", accountType: "kids", archivedAt: new Date("2026-01-01") })];
    const tx = fakeTx(rows);
    tx.$queryRaw.mockResolvedValueOnce([{ id: "k", name: "k", email: "k@example.test", archivedAt: new Date("2026-01-01") }, { id: "p", name: "Deleted member", email: "deleted-p@deleted.invalid", archivedAt: AT }] as never);
    expect(await restoreMember(tx as never, { id: "k", tenantId: "t1" })).toMatchObject({ kind: "ok", parentErased: true });
    expect(rows[1].archivedAt).toBeNull();
  });

  it("billing: a child archived WITH its parent reads the parent's archive row", async () => {
    const tx = fakeTx([row("p", { archivedAt: AT }), row("k", { parentMemberId: "p", accountType: "kids", archivedAt: AT })]);
    tx.$queryRaw.mockResolvedValueOnce([{ id: "k", name: "k", email: "k@example.test", archivedAt: AT }, { id: "p", name: "p", email: "p@example.test", archivedAt: null }] as never);
    tx.auditLog.findFirst.mockResolvedValueOnce(null as never).mockResolvedValueOnce({ metadata: { stripeCancelledMemberIds: ["k"] } } as never);
    expect(await restoreMember(tx as never, { id: "k", tenantId: "t1" })).toMatchObject({ kind: "ok", subscriptionEnding: true });
  });

  it("restoring a parent never brings back a child erased since", async () => {
    const kid = row("k1", { parentMemberId: "p", accountType: "kids", archivedAt: AT });
    (kid as Record<string, unknown>).email = "deleted-k1@deleted.invalid";
    const rows = [row("p", { archivedAt: AT }), kid];
    const out = await restoreMember(fakeTx(rows) as never, { id: "p", tenantId: "t1" });
    expect(out).toMatchObject({ kind: "ok", restoredKidIds: [] });
    expect(rows[1].archivedAt).toEqual(AT);
  });

  it("says a card subscription is still set to end when the removal cancelled one", async () => {
    const tx = fakeTx([row("p", { archivedAt: AT })]);
    tx.auditLog.findFirst.mockResolvedValueOnce({ metadata: { stripeSubscriptionsCancelled: 1 } } as never);
    expect(await restoreMember(tx as never, { id: "p", tenantId: "t1" })).toMatchObject({ kind: "ok", subscriptionEnding: true });
  });
});
