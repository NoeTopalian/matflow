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
import { getMemberListCounts } from "@/lib/member-list-counts-server";
import { MEMBER_LIST_COUNT_KEYS, countMemberRows } from "@/lib/member-list-counts";
import { clubMonthWindow } from "@/lib/club-month";
import { shownPaymentStatus } from "@/lib/overdue";
import { getReportsData } from "@/lib/reports";
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

// ─── Review L5 (23 Oct 2026): totals above the 1,500-row display cap ─────────
//
// The Members page loads at most 1,500 rows (MEMBERS_SSR_TAKE). Its totals are
// now counted on the server over the FULL population (getMemberListCounts).
// One throwaway tenant (club zone Pacific/Auckland) holds 1,600 members of
// mixed status, account type and payment state; the server totals must equal
// (a) the browser predicates over ALL 1,600 rows, (b) plain SQL over all
// rows, and (c) Reports for the same populations, and must differ from what
// the first 1,500 rows alone give. createMany in batches of 500 keeps the
// fixture to four round trips.

const CAP = 1500; // app/dashboard/members/page.tsx MEMBERS_SSR_TAKE
const BIG = 1600;
const capIds = { C: "", guardian: "" };

describe.skipIf(!HAS_DB)(`L5 Members totals above the ${CAP}-row cap on TEST${SKIP_NOTE}`, () => {
  beforeAll(async () => {
    assertTestBranch(process.env.DATABASE_URL);
    const month = clubMonthWindow(new Date(), "Pacific/Auckland");
    const inMonth = new Date(new Date(month.monthStart).getTime() + 60_000);
    await withRlsBypass(async (tx) => {
      capIds.C = (await tx.tenant.create({ data: { name: `${STAMP} C`, slug: `${STAMP}-c`, onboardingCompleted: true, timezone: "Pacific/Auckland" } })).id;
      capIds.guardian = (await tx.member.create({
        data: { tenantId: capIds.C, name: `${STAMP} c guardian`, email: `${STAMP}-c-guardian@example.test`, status: "active", accountType: "parent", paymentStatus: "free" },
      })).id;
      const statuses = ["active", "active", "active", "inactive", "taster", "cancelled"];
      const types = ["adult", "adult", "junior", "kids", "parent"];
      const pays = ["paid", "paid", "overdue", "paused", "pending", "free"];
      const rows = Array.from({ length: BIG }, (_, i) => {
        const status = statuses[i % statuses.length];
        const accountType = types[i % types.length];
        return {
          tenantId: capIds.C,
          // Zero-padded, so "the first 1,500 by name" is the first 1,500 indices.
          name: `${STAMP} c ${String(i).padStart(4, "0")}`,
          email: `${STAMP}-c-${i}@example.test`,
          status,
          accountType,
          paymentStatus: pays[i % pays.length],
          // Every 7th due date has passed (derived overdue where it applies), every 11th is ahead.
          nextDueAt: i % 7 === 0 ? new Date(Date.now() - 5 * 86_400_000) : i % 11 === 0 ? new Date(Date.now() + 5 * 86_400_000) : null,
          billedBy: i % 13 === 0 ? "teamup" : "matflow",
          waiverAccepted: i % 2 === 0,
          phone: i % 3 === 0 ? null : "+447700900123",
          parentMemberId: accountType === "kids" ? capIds.guardian : null,
          // A third joined in this club month; the rest long ago.
          joinedAt: i % 3 === 1 ? inMonth : new Date("2025-01-15T00:00:00Z"),
          cancelledAt: status === "cancelled" ? (i % 2 === 0 ? inMonth : new Date("2025-06-01T00:00:00Z")) : null,
        };
      });
      for (let from = 0; from < rows.length; from += 500) {
        await tx.member.createMany({ data: rows.slice(from, from + 500) });
      }
    }, { timeout: 120_000 });
  }, 180_000);

  afterAll(async () => {
    if (!capIds.C) return;
    await withRlsBypass(async (tx) => {
      await tx.member.deleteMany({ where: { tenantId: capIds.C } });
      await tx.tenant.deleteMany({ where: { id: capIds.C, slug: { startsWith: STAMP } } });
    }, { timeout: 60_000 });
    const left = await withRlsBypass(async (tx) => ({
      tenants: await tx.tenant.count({ where: { id: capIds.C } }),
      members: await tx.member.count({ where: { tenantId: capIds.C } }),
    }));
    expect(left).toEqual({ tenants: 0, members: 0 });
  }, 120_000);

  it("server totals equal the browser predicates over ALL rows, plain SQL and Reports; the first 1,500 rows alone fall short", async () => {
    const now = new Date();
    const month = clubMonthWindow(now, "Pacific/Auckland");
    const server = await getMemberListCounts(capIds.C, now, month);

    // Every row, uncapped, in the shape the Members page holds.
    const all = await withTenantContext(capIds.C, (tx) =>
      tx.member.findMany({
        where: { tenantId: capIds.C },
        orderBy: { name: "asc" },
        select: {
          name: true, status: true, accountType: true, paymentStatus: true, nextDueAt: true, stripeSubscriptionId: true,
          billedBy: true, waiverAccepted: true, phone: true, parentMemberId: true, joinedAt: true, cancelledAt: true,
          attendances: { orderBy: { checkInTime: "desc" }, take: 1, select: { checkInTime: true } },
        },
      }),
    );
    expect(all.length).toBe(BIG + 1);
    const listRows = all.map((m) => ({
      status: m.status,
      accountType: m.accountType,
      paymentStatus: shownPaymentStatus(m, now),
      waiverAccepted: m.waiverAccepted,
      phone: m.phone,
      parentMemberId: m.parentMemberId,
      joinedAt: m.joinedAt.toISOString(),
      cancelledAt: m.cancelledAt ? m.cancelledAt.toISOString() : null,
      lastVisitAt: m.attendances[0]?.checkInTime.toISOString() ?? null,
    }));

    // (a) The browser predicates over every row.
    const browser = countMemberRows(listRows, now, month);
    for (const key of MEMBER_LIST_COUNT_KEYS) expect(server[key], key).toBe(browser[key]);

    // (b) Plain SQL over every row, for the named populations. The columns
    // are timestamp(3) holding a UTC wall clock, so the ISO bounds are cast
    // to timestamp (the trailing Z is dropped, the wall clock kept).
    const sql = async (predicate: string, ...params: string[]) =>
      Number((await withTenantContext(capIds.C, (tx) =>
        tx.$queryRawUnsafe<Array<{ n: bigint }>>(`SELECT COUNT(*)::bigint AS n FROM "Member" WHERE "tenantId" = $1 AND ${predicate}`, capIds.C, ...params),
      ))[0].n);
    const TRAINING = `"accountType" <> 'parent'`;
    expect(server.active).toBe(await sql(`status = 'active' AND ${TRAINING}`));
    expect(server.all).toBe(await sql(`status <> 'cancelled' AND ${TRAINING}`));
    expect(server.inactive).toBe(await sql(`status = 'inactive' AND ${TRAINING}`));
    expect(server.taster).toBe(await sql(`status = 'taster' AND ${TRAINING}`));
    expect(server.cancelled).toBe(await sql(`status = 'cancelled' AND ${TRAINING}`));
    expect(server.guardians).toBe(await sql(`status <> 'cancelled' AND "accountType" = 'parent'`));
    expect(server.activeOnHold).toBe(await sql(`status = 'active' AND ${TRAINING} AND "paymentStatus" = 'paused'`));
    expect(server.newThisMonth).toBe(
      await sql(`${TRAINING} AND "joinedAt" >= $2::timestamp AND "joinedAt" < $3::timestamp`, month.monthStart, month.nextMonthStart),
    );
    expect(server.churnedThisMonth).toBe(
      await sql(`status = 'cancelled' AND ${TRAINING} AND "cancelledAt" >= $2::timestamp AND "cancelledAt" < $3::timestamp`, month.monthStart, month.nextMonthStart),
    );

    // (c) Reports counts the same populations the same way.
    const reports = await getReportsData(capIds.C);
    expect(reports.period.monthKey).toBe(month.monthKey);
    expect(reports.summary.activeMembers).toBe(server.active);
    expect(reports.summary.currentMembers).toBe(server.all);
    expect(reports.summary.inactiveMembers).toBe(server.inactive);
    expect(reports.summary.tasterMembers).toBe(server.taster);
    expect(reports.summary.cancelledMembers).toBe(server.cancelled);
    expect(reports.summary.activeOnHoldMembers).toBe(server.activeOnHold);
    expect(reports.summary.newMembersThisMonth).toBe(server.newThisMonth);
    expect(reports.churn.cancelled).toBe(server.churnedThisMonth);

    // The cap is real: the first 1,500 rows alone undercount.
    const capped = countMemberRows(listRows.slice(0, CAP), now, month);
    expect(capped.all).toBeLessThan(server.all);
    expect(capped.active).toBeLessThan(server.active);
  }, 120_000);
});
