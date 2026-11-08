// T9c public club page against a real database (ticket T9c, Tests §3).
//
// Two synthetic published clubs. Club A carries its live classes plus every kind
// of class that must NOT be published: an imported history class (inactive,
// sourceImportJobId set), a paused class, a removed class, a class with no
// schedule, a class whose only schedule has ended, a class whose only schedule
// starts next month, and a roster-only class. Club B has its own live class and
// branding. A's page must list only A's live classes; B's data must never
// appear. Skipped without a database.
//
// RLS: fixtures are written through withRlsBypass and the reads go through
// withTenantContext, under whatever role DATABASE_URL connects as. On the Neon
// TEST branch that is the owner role, which bypasses RLS, so this suite proves
// the application-layer `where: { tenantId }` filters (the live control, per
// lib/public-club-page-server.ts). It proves RLS as well only when run with
// DATABASE_URL set to a NOBYPASSRLS role, as CI does for rls-foundation.test.ts
// (.github/workflows/ci.yml); this file is not yet on that CI step.
import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { loadClubContent, resolvePublishedClubId, listPublishedClubSlugs } from "@/lib/public-club-page-server";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
const PREFIX = "pubpage-";

describe.skipIf(!HAS_DB)("T9c public club page (integration)", () => {
  let tenantA = "";
  let tenantB = "";
  let coachUserId = "";
  let liveClassId = "";
  const slugA = `${PREFIX}a-${STAMP}`;
  const slugB = `${PREFIX}b-${STAMP}`;
  const slugOff = `${PREFIX}off-${STAMP}`;
  const slugSus = `${PREFIX}sus-${STAMP}`;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const a = await tx.tenant.create({
        data: { name: "Pub Page A", slug: slugA, publicPageEnabled: true, publicPageEnabledAt: new Date(), contactEmail: "private-a@pubpage.local" },
      });
      const b = await tx.tenant.create({
        data: { name: "Pub Page B", slug: slugB, publicPageEnabled: true, publicPageEnabledAt: new Date() },
      });
      await tx.tenant.create({ data: { name: "Pub Page Off", slug: slugOff } });
      await tx.tenant.create({ data: { name: "Pub Page Sus", slug: slugSus, publicPageEnabled: true, subscriptionStatus: "suspended" } });
      tenantA = a.id;
      tenantB = b.id;

      const sched = (dayOfWeek: number, startTime: string, endTime: string, extra: Record<string, unknown> = {}) => ({
        create: [{ dayOfWeek, startTime, endTime, ...extra }],
      });

      const coach = await tx.user.create({
        data: { tenantId: a.id, email: `coach-${STAMP}@pubpage.local`, name: "Coach Riley", passwordHash: "x", role: "coach" },
      });
      coachUserId = coach.id;
      const live = await tx.class.create({
        data: { tenantId: a.id, name: "A Live No-Gi", maxCapacity: 20, coachUserId: coach.id, schedules: sched(1, "18:00", "19:00") },
      });
      liveClassId = live.id;
      await tx.class.create({
        data: { tenantId: a.id, name: "A Live Kids", isKids: true, coachName: "Coach Jo", schedules: sched(6, "10:00", "10:45") },
      });
      await tx.class.create({
        data: {
          tenantId: a.id,
          name: "A Starts Next Month",
          schedules: sched(0, "09:00", "10:00", { startDate: new Date(Date.now() + 30 * 86_400_000) }),
        },
      });
      await tx.class.create({
        data: { tenantId: a.id, name: "A Imported History", isActive: false, sourceImportJobId: "job-x", schedules: sched(2, "18:00", "19:00") },
      });
      await tx.class.create({ data: { tenantId: a.id, name: "A Paused", isActive: false, schedules: sched(3, "18:00", "19:00") } });
      await tx.class.create({ data: { tenantId: a.id, name: "A Removed", deletedAt: new Date(), schedules: sched(4, "18:00", "19:00") } });
      await tx.class.create({ data: { tenantId: a.id, name: "A Unscheduled" } });
      await tx.class.create({
        data: { tenantId: a.id, name: "A Ended", schedules: sched(5, "18:00", "19:00", { endDate: new Date("2020-01-01") }) },
      });
      const rosterOnly = await tx.class.create({ data: { tenantId: a.id, name: "A Roster Only", schedules: sched(2, "07:00", "08:00") } });
      const m = await tx.member.create({ data: { tenantId: a.id, name: "Private Member", email: `pm-${STAMP}@pubpage.local` } });
      await tx.classRoster.create({ data: { tenantId: a.id, classId: rosterOnly.id, memberId: m.id } });

      await tx.membershipTier.create({
        data: { tenantId: a.id, name: "A Public Tier", description: "Staff note: legacy plan", pricePence: 6000, showOnPublicPage: true },
      });
      await tx.membershipTier.create({ data: { tenantId: a.id, name: "A Hidden Tier", pricePence: 9000 } });

      await tx.class.create({ data: { tenantId: b.id, name: "B Secret Class", schedules: sched(1, "06:00", "07:00") } });
      await tx.membershipTier.create({ data: { tenantId: b.id, name: "B Tier", pricePence: 1000, showOnPublicPage: true } });
    });
  });

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      const tenants = await tx.tenant.findMany({ where: { slug: { startsWith: PREFIX } }, select: { id: true } });
      const ids = tenants.map((t) => t.id);
      if (ids.length === 0) return;
      const scope = { tenantId: { in: ids } };
      await tx.classRoster.deleteMany({ where: scope });
      await tx.classSchedule.deleteMany({ where: { class: scope } });
      await tx.class.deleteMany({ where: scope });
      await tx.membershipTier.deleteMany({ where: scope });
      await tx.member.deleteMany({ where: scope });
      await tx.user.deleteMany({ where: scope });
      await tx.tenant.deleteMany({ where: { id: { in: ids } } });
    });
  });

  it("resolves only published, admitted clubs", async () => {
    expect(await resolvePublishedClubId(slugA)).toBe(tenantA);
    expect(await resolvePublishedClubId(slugB.toUpperCase())).toBe(tenantB);
    expect(await resolvePublishedClubId(slugOff)).toBeNull();
    expect(await resolvePublishedClubId(slugSus)).toBeNull();
    expect(await resolvePublishedClubId(`${PREFIX}nosuch-${STAMP}`)).toBeNull();
  });

  it("lists only the live classes and the ticked tier, and nothing of club B", async () => {
    const page = await loadClubContent(tenantA);
    expect(page).not.toBeNull();
    expect(page!.name).toBe("Pub Page A");
    // "A Starts Next Month" is not on this week's timetable.
    expect(page!.sessions.map((s) => s.className).sort()).toEqual(["A Live Kids", "A Live No-Gi"]);
    expect(page!.tiers.map((t) => t.name)).toEqual(["A Public Tier"]);

    // Exact shapes: no capacity, no ids, no tier description.
    for (const s of page!.sessions) {
      expect(Object.keys(s).sort()).toEqual(
        ["className", "coach", "dayOfWeek", "durationMin", "endTime", "isKids", "key", "startTime", "venue"],
      );
    }
    for (const t of page!.tiers) {
      expect(Object.keys(t).sort()).toEqual(["isKids", "key", "name", "price"]);
    }
    // Coach names come from coachUser.name or coachName only.
    const coachOf = Object.fromEntries(page!.sessions.map((s) => [s.className, s.coach]));
    expect(coachOf).toEqual({ "A Live No-Gi": "Coach Riley", "A Live Kids": "Coach Jo" });

    const json = JSON.stringify(page);
    for (const leak of [
      "B Secret Class", "B Tier", "Pub Page B", "Private Member", "private-a@pubpage.local", "A Hidden Tier",
      "Staff note", coachUserId, liveClassId, tenantA,
    ]) {
      expect(json, leak).not.toContain(leak);
    }
  });

  it("club B's page shows B only", async () => {
    const page = await loadClubContent(tenantB);
    expect(page!.sessions.map((s) => s.className)).toEqual(["B Secret Class"]);
    expect(JSON.stringify(page)).not.toContain("A Live");
  });

  it("the sitemap list carries the published clubs and not the opted-out or suspended ones", async () => {
    const slugs = (await listPublishedClubSlugs()).map((r) => r.slug);
    expect(slugs).toContain(slugA);
    expect(slugs).toContain(slugB);
    expect(slugs).not.toContain(slugOff);
    expect(slugs).not.toContain(slugSus);
  });
});
