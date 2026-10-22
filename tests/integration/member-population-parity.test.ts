// T1 (17 Oct 2026) — server and client agree on every member population, and
// GET /api/members pages completely when many members share a joinedAt.
//
// Runs against a REAL database: the Neon TEST branch only (helpers/db-target;
// tests/setup-test-db.ts refuses production). Skipped, visibly, on any other
// target. Mocks cannot prove this: the point is that Postgres evaluating the
// Prisma fragment and the browser evaluating its twin return the same rows.
//
// Fixtures are two throwaway tenants holding every status × accountType ×
// paymentStatus combination the CHECK constraints allow, plus 250 members with
// one identical joinedAt. afterAll removes them and checks nothing is left.
import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("@/auth", () => ({ auth: vi.fn() }));

import { auth } from "@/auth";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import {
  ACTIVE_MEMBER,
  CAN_TRAIN_MEMBER,
  CURRENT_MEMBER,
  GUARDIAN_ACCOUNT,
  LEFT_MEMBER,
  ON_HOLD,
  TRAINING_MEMBER,
  isActiveMember,
  isCanTrainMember,
  isCurrentMember,
  isGuardianAccount,
  isLeftMember,
  isOnHold,
  isTrainingMember,
  type PopulationRow,
} from "@/lib/member-population";
import { GET } from "@/app/api/members/route";
import { classifyDbTarget, assertTestBranch, skipReason } from "./helpers/db-target";

const TARGET = classifyDbTarget(process.env.DATABASE_URL);
const HAS_DB = TARGET === "run" || TARGET === "refuse";
const SKIP_NOTE = skipReason(TARGET) ? ` [skipped: ${skipReason(TARGET)}]` : "";
const STAMP = `t1pop${Date.now().toString(36)}`;

const STATUSES = ["active", "inactive", "cancelled", "taster"];
const ACCOUNT_TYPES = ["adult", "junior", "kids", "parent"];
const PAYMENT_STATUSES = ["paid", "overdue", "paused", "free", "pending", "cancelled"];
const TIED_COUNT = 250;
const TIED_JOINED_AT = new Date("2026-10-03T11:39:57.000Z");

const ids = { A: "", B: "", ownerA: "" };

const PAIRS: [string, Record<string, unknown>, (m: PopulationRow) => boolean][] = [
  ["TRAINING_MEMBER", TRAINING_MEMBER, isTrainingMember],
  ["ACTIVE_MEMBER", ACTIVE_MEMBER, isActiveMember],
  ["CURRENT_MEMBER", CURRENT_MEMBER, isCurrentMember],
  ["CAN_TRAIN_MEMBER", CAN_TRAIN_MEMBER, isCanTrainMember],
  ["LEFT_MEMBER", LEFT_MEMBER, isLeftMember],
  ["GUARDIAN_ACCOUNT", GUARDIAN_ACCOUNT, isGuardianAccount],
  ["ON_HOLD", ON_HOLD, isOnHold],
];

describe.skipIf(!HAS_DB)(`T1 member populations and members pagination on TEST${SKIP_NOTE}`, () => {
  beforeAll(async () => {
    assertTestBranch(process.env.DATABASE_URL);
    await withRlsBypass(async (tx) => {
      ids.A = (await tx.tenant.create({ data: { name: `${STAMP} A`, slug: `${STAMP}-a`, onboardingCompleted: true } })).id;
      ids.B = (await tx.tenant.create({ data: { name: `${STAMP} B`, slug: `${STAMP}-b`, onboardingCompleted: true } })).id;
      ids.ownerA = (await tx.user.create({
        data: { tenantId: ids.A, email: `${STAMP}-owner@example.test`, name: "T1 owner", role: "owner", passwordHash: "synthetic-t1-not-a-hash" },
      })).id;
      for (const tenantId of [ids.A, ids.B]) {
        // A kids account must have a guardian (CHECK Member_kids_must_have_parent,
        // migration 20260515000001 — on main and in production), so the guardian
        // row is created first and every kids row points at it. The guardian is
        // itself one of the counted rows (status active, accountType parent).
        const guardianId = (await tx.member.create({
          data: {
            tenantId,
            name: `${STAMP} guardian`,
            email: `${STAMP}-${tenantId.slice(-6)}-guardian@example.test`,
            status: "active",
            accountType: "parent",
            paymentStatus: "free",
          },
        })).id;
        const rows = STATUSES.flatMap((status) =>
          ACCOUNT_TYPES.flatMap((accountType) =>
            PAYMENT_STATUSES.map((paymentStatus) => ({
              tenantId,
              name: `${STAMP} ${status} ${accountType} ${paymentStatus}`,
              email: `${STAMP}-${tenantId.slice(-6)}-${status}-${accountType}-${paymentStatus}@example.test`,
              status,
              accountType,
              paymentStatus,
              cancelledAt: status === "cancelled" ? new Date() : null,
              parentMemberId: accountType === "kids" ? guardianId : null,
            })),
          ),
        );
        await tx.member.createMany({ data: rows });
      }
      await tx.member.createMany({
        data: Array.from({ length: TIED_COUNT }, (_, i) => ({
          tenantId: ids.A,
          name: `${STAMP} tied ${String(i).padStart(3, "0")}`,
          email: `${STAMP}-tied-${i}@example.test`,
          joinedAt: TIED_JOINED_AT,
        })),
      });
    }, { timeout: 60_000 });
  }, 120_000);

  afterAll(async () => {
    const t = [ids.A, ids.B].filter(Boolean);
    if (t.length === 0) return;
    await withRlsBypass(async (tx) => {
      await tx.member.deleteMany({ where: { tenantId: { in: t } } });
      await tx.user.deleteMany({ where: { tenantId: { in: t } } });
      await tx.tenant.deleteMany({ where: { id: { in: t }, slug: { startsWith: STAMP } } });
    }, { timeout: 60_000 });
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { id: { in: t } } }),
      members: await tx.member.count({ where: { tenantId: { in: t } } }),
    }));
    expect(left).toEqual({ tenants: 0, members: 0 });
  }, 120_000);

  for (const [name, where, twin] of PAIRS) {
    it(`${name}: Postgres and the client twin select the same members, and nothing from the other tenant`, async () => {
      const [serverIds, rows] = await withTenantContext(ids.A, async (tx) => [
        (await tx.member.findMany({ where: { tenantId: ids.A, ...where }, select: { id: true } })).map((r) => r.id).sort(),
        // The getMembers row shape the Members page holds.
        await tx.member.findMany({ where: { tenantId: ids.A }, select: { id: true, tenantId: true, status: true, accountType: true, paymentStatus: true } }),
      ] as const);
      expect(rows.every((r) => r.tenantId === ids.A)).toBe(true);
      const clientIds = rows.filter(twin).map((r) => r.id).sort();
      expect(serverIds).toEqual(clientIds);
      const count = await withTenantContext(ids.A, (tx) => tx.member.count({ where: { tenantId: ids.A, ...where } }));
      expect(count).toBe(clientIds.length);
    });
  }

  it("parity query: the Active population equals status active and not a guardian", async () => {
    const [viaFilter, viaSql] = await withTenantContext(ids.A, async (tx) => [
      await tx.member.count({ where: { tenantId: ids.A, ...ACTIVE_MEMBER } }),
      Number((await tx.$queryRaw<Array<{ n: bigint }>>`SELECT COUNT(*)::bigint AS n FROM "Member" WHERE "tenantId" = ${ids.A} AND status = 'active' AND "accountType" <> 'parent'`)[0].n),
    ] as const);
    expect(viaFilter).toBe(viaSql);
  });

  it(`GET /api/members at take=100 returns all ${TIED_COUNT} members sharing one joinedAt, with no duplicates`, async () => {
    vi.mocked(auth).mockResolvedValue({ user: { id: ids.ownerA, tenantId: ids.A, role: "owner" } } as never);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const url = new URL("http://localhost/api/members");
      url.searchParams.set("take", "100");
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await GET(new Request(url));
      expect(res.status).toBe(200);
      const body = (await res.json()) as { members: { id: string; name: string }[]; nextCursor: string | null };
      seen.push(...body.members.map((m) => m.id));
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    expect(new Set(seen).size).toBe(seen.length);
    const tiedIds = await withTenantContext(ids.A, (tx) =>
      tx.member.findMany({ where: { tenantId: ids.A, joinedAt: TIED_JOINED_AT }, select: { id: true } }),
    );
    const seenSet = new Set(seen);
    expect(tiedIds.filter((m) => !seenSet.has(m.id))).toEqual([]);
    expect(tiedIds).toHaveLength(TIED_COUNT);
  });
});
