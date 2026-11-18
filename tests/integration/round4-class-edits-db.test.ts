// Round 4 (10 Nov 2026): a class edited in two places keeps both changes, and
// a save from an older tab cannot put back a capacity or coach. Real PATCH
// /api/classes/[id], Neon TEST branch, both database roles (db-tests.mjs).
// Synthetic clubs (r4k-), torn down here.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }) },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async (e: Record<string, unknown>) => { audit.calls.push(e); }) }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { PATCH } from "@/app/api/classes/[id]/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r4k${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 120_000 });

type Res = { status: number; body: Record<string, unknown> };

describe.skipIf(!HAS_DB)("class edits: no silent overwrite", () => {
  const club = { A: "", B: "" };
  const owner = { A: "", B: "" };
  let classId = "";
  let rankId = "";
  const squadMembers: string[] = [];
  const as = (k: "A" | "B") => mockAuth.mockResolvedValue({ user: { id: owner[k], tenantId: club[k], role: "owner", email: `${STAMP}-${k}@example.test` } } as never);
  const patch = async (body: unknown): Promise<Res> => {
    const r = (await PATCH(new Request(`http://test/api/classes/${classId}`, { method: "PATCH", body: JSON.stringify(body) }), { params: Promise.resolve({ id: classId }) })) as unknown as { status: number; json: () => Promise<Record<string, unknown>> };
    return { status: r.status, body: await r.json() };
  };
  const row = () => withRlsBypass((tx) => tx.class.findUniqueOrThrow({ where: { id: classId }, select: { name: true, maxCapacity: true, coachName: true, duration: true } }));
  const reset = () => withRlsBypass((tx) => tx.class.update({ where: { id: classId }, data: { name: "Fundamentals", maxCapacity: 20, coachName: "Sam", duration: 60 } }));
  // What the class editor sent before Round 4 for these fields: every one, from when it opened.
  const wholeForm = (over: Record<string, unknown>) => ({ name: "Fundamentals", coachName: "Sam", duration: 60, maxCapacity: 20, isKids: false, description: null, ...over });

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      for (const k of ["A", "B"] as const) {
        const t = await tx.tenant.create({ data: { name: `${STAMP} ${k}`, slug: `${STAMP}-${k.toLowerCase()}` } });
        club[k] = t.id;
        owner[k] = (await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-${k}@example.test`, passwordHash: "x", name: `Owner ${k}`, role: "owner" } })).id;
      }
      classId = (await tx.class.create({ data: { tenantId: club.A, name: "Fundamentals", maxCapacity: 20, coachName: "Sam", duration: 60 } })).id;
      rankId = (await tx.rankSystem.create({ data: { tenantId: club.A, discipline: "BJJ", name: "Blue", order: 2, color: "#3b82f6" } })).id;
      for (const n of [1, 2]) {
        squadMembers.push((await tx.member.create({ data: { tenantId: club.A, name: `${STAMP} squad ${n}`, email: `${STAMP}-s${n}@example.test` } })).id);
      }
    });
  });
  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.classRoster.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.class.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.member.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.rankSystem.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.user.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.tenant.deleteMany({ where: { id: { in: [club.A, club.B] } } });
    });
  });

  it("reproduction, the whole-form body sent before Round 4: a coach change from an older tab puts the old capacity back", async () => {
    as("A");
    await reset();
    expect((await patch(wholeForm({ maxCapacity: 30 }))).status).toBe(200);  // tab 1
    expect((await patch(wholeForm({ coachName: "Alex" }))).status).toBe(200); // tab 2, opened earlier
    expect(await row()).toMatchObject({ coachName: "Alex", maxCapacity: 20 }); // the capacity change is lost
  });

  it("only changed fields with what they replace: both changes kept", async () => {
    as("A");
    await reset();
    expect((await patch({ maxCapacity: 30, expected: { maxCapacity: 20 } })).status).toBe(200);
    expect((await patch({ coachName: "Alex", expected: { coachName: "Sam" } })).status).toBe(200);
    expect(await row()).toMatchObject({ coachName: "Alex", maxCapacity: 30 });
  });

  it("the same field from an older tab is refused with the current value; nothing in that save is written", async () => {
    as("A");
    await reset();
    expect((await patch({ maxCapacity: 30, expected: { maxCapacity: 20 } })).status).toBe(200);
    audit.calls.length = 0;
    const stale = await patch({ maxCapacity: 25, name: "Fundamentals (Gi)", expected: { maxCapacity: 20, name: "Fundamentals" } });
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ reason: "stale_class", conflicts: [{ field: "maxCapacity", current: 30 }] });
    expect(await row()).toMatchObject({ maxCapacity: 30, name: "Fundamentals" });
    expect(audit.calls).toHaveLength(0);
  });

  it("a retry after a lost reply succeeds (its value is already stored)", async () => {
    as("A");
    await reset();
    const save = { maxCapacity: 30, expected: { maxCapacity: 20 } };
    expect((await patch(save)).status).toBe(200);
    expect((await patch(save)).status).toBe(200);
    expect((await row()).maxCapacity).toBe(30);
  });

  it("two capacity edits at once from the same screen: exactly one is written", async () => {
    as("A");
    await reset();
    const results = await Promise.all([patch({ maxCapacity: 30, expected: { maxCapacity: 20 } }), patch({ maxCapacity: 40, expected: { maxCapacity: 20 } })]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await row()).maxCapacity).toBe(results[0].status === 200 ? 30 : 40);
  });

  it("another club cannot edit this class", async () => {
    as("B");
    await reset();
    expect((await patch({ maxCapacity: 99, expected: { maxCapacity: 20 } })).status).toBe(404);
    expect((await row()).maxCapacity).toBe(20);
  });

  // Round 4 follow-up (11 Nov 2026): the squad and the rank gate exclude each
  // other (a rank gate clears the squad; a squad clears the rank gate). A save
  // from an older tab that sets one must not silently wipe the other set since.
  const squadState = async () => withRlsBypass(async (tx) => ({
    squad: (await tx.classRoster.findMany({ where: { classId }, select: { memberId: true } })).map((r) => r.memberId).sort(),
    rank: (await tx.class.findUniqueOrThrow({ where: { id: classId }, select: { requiredRankId: true } })).requiredRankId,
  }));
  const clearGates = () => withRlsBypass(async (tx) => {
    await tx.classRoster.deleteMany({ where: { classId } });
    await tx.class.update({ where: { id: classId }, data: { requiredRankId: null, maxRankId: null } });
  });
  // What the editor sends now: a squad save carries both rank fields with what it loaded,
  // and every edit carries the squad it loaded.
  const squadSave = (ids: string[], base: string[]) => ({ roster: ids.map((memberId) => ({ memberId })), requiredRankId: null, maxRankId: null, expected: { requiredRankId: null, maxRankId: null }, baseRosterIds: base });
  const rankSave = (base: string[]) => ({ requiredRankId: rankId, expected: { requiredRankId: null }, baseRosterIds: base });

  it("reproduction, without the squad the editor loaded: a rank set from an older tab silently wipes a squad set since", async () => {
    as("A");
    await clearGates();
    expect((await patch({ roster: [{ memberId: squadMembers[0] }] })).status).toBe(200);        // B adds a squad
    expect((await patch({ requiredRankId: rankId, expected: { requiredRankId: null } })).status).toBe(200); // A, older tab, sets a rank
    expect(await squadState()).toEqual({ squad: [], rank: rankId });                             // the squad is gone
  });

  it("two editors: B sets a squad; A's rank gate from the tab opened before is refused, and the squad stays", async () => {
    as("A");
    await clearGates();
    expect((await patch(squadSave([squadMembers[0]], []))).status).toBe(200);
    audit.calls.length = 0;
    const stale = await patch(rankSave([]));
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ reason: "stale_class", conflicts: [{ field: "roster", current: [squadMembers[0]] }] });
    expect(await squadState()).toEqual({ squad: [squadMembers[0]], rank: null });
    expect(audit.calls).toHaveLength(0);
  });

  it("two editors: B sets a rank gate; A's squad from the tab opened before is refused, and the gate stays", async () => {
    as("A");
    await clearGates();
    expect((await patch(rankSave([]))).status).toBe(200);
    const stale = await patch(squadSave([squadMembers[0]], []));
    expect(stale.status).toBe(409);
    expect(await squadState()).toEqual({ squad: [], rank: rankId });
  });

  it("the same two saves at once: exactly one lands, the other is refused, never both half-applied", async () => {
    as("A");
    await clearGates();
    const results = await Promise.all([patch(squadSave([squadMembers[0]], [])), patch(rankSave([]))]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const st = await squadState();
    expect(results[0].status === 200 ? st : st).toEqual(results[0].status === 200 ? { squad: [squadMembers[0]], rank: null } : { squad: [], rank: rankId });
  });

  it("two admins editing one squad from the same starting squad: the second is refused", async () => {
    as("A");
    await clearGates();
    expect((await patch(squadSave([squadMembers[0]], []))).status).toBe(200);
    expect((await patch(squadSave([squadMembers[1]], []))).status).toBe(409);
    expect((await squadState()).squad).toEqual([squadMembers[0]]);
  });

  // Round 6 merge review (13 Nov 2026), finding 1: every edit carries the squad and the slots it loaded; those are
  // freshness checks, not fields of the class, and the Activity row must not list them as changed.
  it("the activity row lists only the class's own fields, never the freshness checks the editor sends", async () => {
    as("A");
    await reset();
    await clearGates();
    audit.calls.length = 0;
    expect((await patch({ maxCapacity: 31, expected: { maxCapacity: 20 }, baseRosterIds: [], baseScheduleIds: [] })).status).toBe(200);
    const updated = audit.calls.filter((c) => c.action === "class.updated");
    expect(updated).toHaveLength(1);
    expect((updated[0].metadata as { fields: string[] }).fields).toEqual(["maxCapacity"]);
  });

  it("an up-to-date tab can still switch squad to rank gate and back (the business rule is unchanged)", async () => {
    as("A");
    await clearGates();
    expect((await patch(squadSave([squadMembers[0], squadMembers[1]], []))).status).toBe(200);
    expect((await patch({ requiredRankId: rankId, expected: { requiredRankId: null }, baseRosterIds: [squadMembers[1], squadMembers[0]] })).status).toBe(200);
    expect(await squadState()).toEqual({ squad: [], rank: rankId });
    expect((await patch({ roster: [{ memberId: squadMembers[0] }], requiredRankId: null, maxRankId: null, expected: { requiredRankId: rankId, maxRankId: null }, baseRosterIds: [] })).status).toBe(200);
    expect(await squadState()).toEqual({ squad: [squadMembers[0]], rank: null });
  });
});

