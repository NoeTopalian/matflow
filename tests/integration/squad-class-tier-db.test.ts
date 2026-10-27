// T6d — squad (roster) classes composed with the T6a membership gate, against
// real Postgres (Neon child branch).
//
// Owner decision 20 Oct 2026 (superseding 17 Oct "roster decides"): a class
// with a roster AND memberships ticked admits only a member who is on the
// roster AND on a listed tier, at every door, staff doors included. And the kiosk
// no longer offers a squad class to a member who is not on its roster: the
// class list carries `rosterOnly` and the name search for that class lists
// only rostered members.
//
// Skips when DATABASE_URL is unset (run on a Neon child branch, never prod).

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: () => "203.0.113.7",
}));

import { withRlsBypass } from "@/lib/prisma-tenant";
import { performCheckin } from "@/lib/checkin";
import { hashToken } from "@/lib/token-hash";
import { todayWindow } from "@/lib/class-time";
import { GET as kioskClassesGET } from "@/app/api/kiosk/[token]/classes/route";
import { GET as kioskMembersGET } from "@/app/api/kiosk/[token]/members/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const KIOSK_TOKEN = `squad-kiosk-token-${STAMP}`;

describe.skipIf(!HAS_DB)("squad class + membership tiers — real database", () => {
  let tenantId: string;
  let tierBeg: string;
  let tierAdv: string;
  let memberOnBeg: string; // on the roster, on a tier the class does not list
  let memberOffAdv: string; // not on the roster, on the listed tier
  let memberOnAdv: string; // on the roster AND on the listed tier
  let classId: string;
  let instanceId: string;

  const kioskArgs = (memberId: string) => ({
    tenantId, memberId, classInstanceId: instanceId, method: "kiosk" as const,
    enforceRankGate: true, enforceTimeWindow: false, requireCoverage: false,
    enforceCapacity: true, enforceWaiverGate: true, enforceHoldGate: true, enforceKidsGate: true,
    enforceVenueGate: true,
  });

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const t = await tx.tenant.create({
        data: { name: `Squad ${STAMP}`, slug: `squad-${STAMP}`, kioskTokenHash: hashToken(KIOSK_TOKEN), timezone: "Europe/London" },
      });
      tenantId = t.id;
      tierBeg = (await tx.membershipTier.create({ data: { tenantId, name: "Beginners Unlimited" } })).id;
      tierAdv = (await tx.membershipTier.create({ data: { tenantId, name: "Advanced Unlimited" } })).id;
      memberOnBeg = (await tx.member.create({
        data: { tenantId, name: `Sasha Squad ${STAMP}`, email: `squad-on-${STAMP}@test.local`, membershipTierId: tierBeg, membershipType: "Beginners Unlimited", waiverAccepted: true, paymentStatus: "paid" },
      })).id;
      memberOffAdv = (await tx.member.create({
        data: { tenantId, name: `Sasha Other ${STAMP}`, email: `squad-off-${STAMP}@test.local`, membershipTierId: tierAdv, membershipType: "Advanced Unlimited", waiverAccepted: true, paymentStatus: "paid" },
      })).id;
      memberOnAdv = (await tx.member.create({
        data: { tenantId, name: `Robin Both ${STAMP}`, email: `squad-both-${STAMP}@test.local`, membershipTierId: tierAdv, membershipType: "Advanced Unlimited", waiverAccepted: true, paymentStatus: "paid" },
      })).id;
      const c = await tx.class.create({ data: { tenantId, name: "Comp Squad", duration: 60 } });
      classId = c.id;
      // The class lists Advanced only, and has a roster holding the Beginner.
      await tx.classMembershipTier.create({ data: { tenantId, classId, tierId: tierAdv } });
      await tx.classRoster.create({ data: { tenantId, classId, memberId: memberOnBeg } });
      await tx.classRoster.create({ data: { tenantId, classId, memberId: memberOnAdv } });
      // Today's session, on the club's calendar day.
      const { start } = todayWindow(new Date(), "Europe/London");
      const day = new Date(start.getTime() + 12 * 60 * 60 * 1000);
      instanceId = (await tx.classInstance.create({ data: { classId, date: day, startTime: "23:00", endTime: "23:59" } })).id;
    });
  });

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.classRoster.deleteMany({ where: { tenantId } });
      await tx.classMembershipTier.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.membershipTier.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  const deskArgs = (memberId: string) => ({
    ...kioskArgs(memberId), method: "admin" as const, enforceRankGate: false, enforceCapacity: false,
    enforceWaiverGate: false, enforceHoldGate: false, enforceKidsGate: false, enforceVenueGate: false,
  });
  const cardArgs = (memberId: string) => ({ ...deskArgs(memberId), method: "qr" as const });

  it("a rostered member on a tier the class does not list is refused on the tier, at the kiosk, the desk and the scanner", async () => {
    for (const args of [kioskArgs(memberOnBeg), deskArgs(memberOnBeg), cardArgs(memberOnBeg)]) {
      const result = await performCheckin(args);
      expect(result).toMatchObject({ kind: "tier_not_included", className: "Comp Squad", tierName: "Beginners Unlimited" });
    }
    expect(await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { classInstanceId: instanceId, memberId: memberOnBeg } }))).toBe(0);
  });

  it("the desk and the scanner refuse a member who is not on the roster too (no staff override)", async () => {
    for (const args of [deskArgs(memberOffAdv), cardArgs(memberOffAdv)]) {
      expect((await performCheckin(args)).kind).toBe("roster_not_listed");
    }
  });

  it("a member on the roster AND the listed tier is admitted", async () => {
    const result = await performCheckin(kioskArgs(memberOnAdv));
    expect(result.kind).toBe("success");
  });

  it("a member on the listed tier who is not on the roster is refused by the roster gate", async () => {
    const result = await performCheckin(kioskArgs(memberOffAdv));
    expect(result.kind).toBe("roster_not_listed");
    expect(await withRlsBypass((tx) => tx.attendanceRecord.count({ where: { classInstanceId: instanceId, memberId: memberOffAdv } }))).toBe(0);
  });

  it("the kiosk class list badges the class, with no member ids", async () => {
    const res = await kioskClassesGET(new Request(`http://test/api/kiosk/${KIOSK_TOKEN}/classes`), {
      params: Promise.resolve({ token: KIOSK_TOKEN }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { classes: Array<{ id: string; rosterOnly: boolean }> };
    const row = body.classes.find((c) => c.id === instanceId);
    expect(row?.rosterOnly).toBe(true);
    const text = JSON.stringify(body.classes);
    expect(text).not.toContain(memberOnBeg);
    expect(text).not.toContain(memberOffAdv);
  });

  it("the kiosk name search for the squad class lists only the rostered member", async () => {
    const q = encodeURIComponent(`Sasha`);
    const res = await kioskMembersGET(
      new Request(`http://test/api/kiosk/${KIOSK_TOKEN}/members?q=${q}&classInstanceId=${instanceId}`),
      { params: Promise.resolve({ token: KIOSK_TOKEN }) },
    );
    const body = (await res.json()) as { members: Array<{ name: string }> };
    expect(body.members.map((m) => m.name)).toEqual([`Sasha Squad ${STAMP}`]);
  });

  it("without the class, the search lists both, as before", async () => {
    const res = await kioskMembersGET(
      new Request(`http://test/api/kiosk/${KIOSK_TOKEN}/members?q=Sasha`),
      { params: Promise.resolve({ token: KIOSK_TOKEN }) },
    );
    const body = (await res.json()) as { members: Array<{ name: string }> };
    expect(body.members.map((m) => m.name).sort()).toEqual([`Sasha Other ${STAMP}`, `Sasha Squad ${STAMP}`]);
  });
});
