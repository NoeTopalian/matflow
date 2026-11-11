// Round 4 (10 Nov 2026): a belt award sent twice (a double click, two coaches
// at once, a retry after a lost reply) is recorded once. Real handler, Neon
// TEST branch, both database roles (db-tests.mjs). Synthetic club (r4r-),
// torn down here. Push delivery is not live; sendPushToMember is stubbed and
// counted, so a duplicate notification would show.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => b, headers: new Headers() }) },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async (e: Record<string, unknown>) => { audit.calls.push(e); }) }));
const push = vi.hoisted(() => ({ calls: 0 }));
vi.mock("@/lib/push", () => ({ sendPushToMember: vi.fn(async () => { push.calls++; }) }));
const mail = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async (e: Record<string, unknown>) => { mail.calls.push(e); return { ok: true }; }) }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as promoteRank } from "@/app/api/members/[id]/rank/route";
import { POST as demoteRank } from "@/app/api/members/[id]/rank/demote/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `r4r${Date.now().toString(36)}`;
vi.setConfig({ testTimeout: 120_000 });

const award = (memberId: string, body: unknown) =>
  promoteRank(
    new Request("https://test.local/", { method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: memberId }) },
  ) as unknown as Promise<{ status: number }>;

const demote = (memberId: string, body: unknown) =>
  demoteRank(
    new Request("https://test.local/", { method: "POST", headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" }, body: JSON.stringify(body) }),
    { params: Promise.resolve({ id: memberId }) },
  ) as unknown as Promise<{ status: number }>;

describe.skipIf(!HAS_DB)("rank awards are recorded once", () => {
  const club = { A: "", B: "" };
  const owner = { A: "", B: "" };
  let memberId = "";
  let white = "";
  let blue = "";
  const as = (k: "A" | "B", role = "owner") => mockAuth.mockResolvedValue({ user: { id: owner[k], tenantId: club[k], role, email: `${STAMP}-${k}@example.test` } } as never);
  const history = () => withRlsBypass(async (tx) => {
    const mr = await tx.memberRank.findMany({ where: { memberId }, select: { id: true, rankSystemId: true, stripes: true } });
    const rows = mr.length ? await tx.rankHistory.findMany({ where: { memberRankId: { in: mr.map((r) => r.id) } }, select: { fromRankId: true, toRankId: true } }) : [];
    return { ranks: mr, rows };
  });

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      for (const k of ["A", "B"] as const) {
        const t = await tx.tenant.create({ data: { name: `${STAMP} ${k}`, slug: `${STAMP}-${k.toLowerCase()}` } });
        club[k] = t.id;
        const u = await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-${k}@example.test`, passwordHash: "x", name: `Owner ${k}`, role: "owner" } });
        owner[k] = u.id;
      }
      const m = await tx.member.create({ data: { tenantId: club.A, name: `${STAMP} member`, email: `${STAMP}-m@example.test` } });
      memberId = m.id;
      white = (await tx.rankSystem.create({ data: { tenantId: club.A, discipline: "BJJ", name: "White", order: 1, color: "#ffffff" } })).id;
      blue = (await tx.rankSystem.create({ data: { tenantId: club.A, discipline: "BJJ", name: "Blue", order: 2, color: "#3b82f6" } })).id;
    });
    as("A");
    expect((await award(memberId, { rankSystemId: white, stripes: 0 })).status).toBe(201);
  });
  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      const ranks = await tx.memberRank.findMany({ where: { memberId }, select: { id: true } });
      if (ranks.length) await tx.rankHistory.deleteMany({ where: { memberRankId: { in: ranks.map((r) => r.id) } } });
      await tx.memberRank.deleteMany({ where: { memberId } });
      await tx.member.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.rankSystem.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.user.deleteMany({ where: { tenantId: { in: [club.A, club.B] } } });
      await tx.tenant.deleteMany({ where: { id: { in: [club.A, club.B] } } });
    });
  });

  it("two identical awards at once (double click): one promotion, one history row, one audit entry, one notification", async () => {
    as("A");
    audit.calls.length = 0;
    push.calls = 0;
    const before = (await history()).rows.length;
    const results = await Promise.all([award(memberId, { rankSystemId: blue, stripes: 0 }), award(memberId, { rankSystemId: blue, stripes: 0 })]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const after = await history();
    expect(after.ranks).toEqual([expect.objectContaining({ rankSystemId: blue, stripes: 0 })]);
    expect(after.rows.length - before).toBe(1);
    expect(after.rows.filter((r) => r.fromRankId === white && r.toRankId === blue)).toHaveLength(1);
    expect(audit.calls.filter((c) => c.action === "member.rank.promote")).toHaveLength(1);
    expect(push.calls).toBe(1);
  });

  it("the same award retried after a lost reply changes nothing and records nothing", async () => {
    as("A");
    audit.calls.length = 0;
    push.calls = 0;
    const before = (await history()).rows.length;
    expect((await award(memberId, { rankSystemId: blue, stripes: 0 })).status).toBe(200);
    expect((await history()).rows.length).toBe(before);
    expect(audit.calls).toHaveLength(0);
    expect(push.calls).toBe(0);
  });

  it("a different award (a stripe) is still a promotion", async () => {
    as("A");
    const before = (await history()).rows.length;
    expect((await award(memberId, { rankSystemId: blue, stripes: 1 })).status).toBe(200);
    const after = await history();
    expect(after.rows.length - before).toBe(1);
    expect(after.ranks[0].stripes).toBe(1);
  });

  it("tenant and role isolation: another club cannot award this member; a member role is refused", async () => {
    as("B");
    expect((await award(memberId, { rankSystemId: blue, stripes: 2 })).status).toBe(404);
    as("A", "member");
    expect((await award(memberId, { rankSystemId: blue, stripes: 2 })).status).toBe(403);
    expect((await history()).ranks[0].stripes).toBe(1);
  });

  it("two identical demotions at once, with the member told: one history row, one audit entry, one email", async () => {
    as("A");
    audit.calls.length = 0;
    mail.calls.length = 0;
    const before = (await history()).rows.length;
    const results = await Promise.all([
      demote(memberId, { toRankId: white, reason: "Round 4 test", notify: true }),
      demote(memberId, { toRankId: white, reason: "Round 4 test", notify: true }),
    ]);
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const after = await history();
    expect(after.ranks).toEqual([expect.objectContaining({ rankSystemId: white, stripes: 0 })]);
    expect(after.rows.length - before).toBe(1);
    expect(audit.calls.filter((c) => c.action === "member.rank.demote")).toHaveLength(1);
    expect(mail.calls.filter((c) => c.templateId === "rank_demoted")).toHaveLength(1);
  });

  // Round 4 substantiation: IDEMPOTENCY BY STATE, not a rate limit. The award
  // is compared with the rank the member holds, under the Member row lock;
  // there is no window. A legitimate later award of the same belt (after a
  // demotion) is a real change and is recorded, with one push.
  it("re-awarding a belt after a demotion is a real promotion: one history row, one push", async () => {
    as("A");
    expect((await demote(memberId, { toRankId: white })).status).toBe(200);
    push.calls = 0;
    const before = (await history()).rows.length;
    expect((await award(memberId, { rankSystemId: blue, stripes: 0 })).status).toBe(200);
    expect((await history()).rows.length - before).toBe(1);
    expect(push.calls).toBe(1); // one push queued (delivery is not live and not tested)
  });
});
