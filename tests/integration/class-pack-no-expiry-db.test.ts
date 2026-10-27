// G6 (owner decision, 27 Oct 2026): "It should be till it runs out". A class
// pack is usable until its credits are used; MemberClassPack.expiresAt NULL
// means it never expires (migration 20261027120100_class_pack_no_expiry).
//
// Against the real database, through performCheckin (the path every door
// takes to claim a pack):
//   - a pack with NULL expiry is claimed;
//   - with several usable packs, the oldest purchase is spent first;
//   - a stray active pack whose non-NULL expiry has passed is still not spent
//     (the rule as written; the migration made such a row impossible);
//   - a refunded pack is never spent;
//   - the CHECK MemberClassPack_expired_has_expiry_check refuses marking a
//     never-expiring pack "expired" (the guard for the previous build's
//     lazy-expiry write during the deploy window).

import { describe, it, beforeAll, afterAll, expect } from "vitest";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { performCheckin } from "@/lib/checkin";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

describe.skipIf(!HAS_DB)("class packs never expire (G6)", () => {
  let tenantId: string;
  let memberId: string;
  let templateId: string;
  const instances: string[] = [];

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const tenant = await tx.tenant.create({ data: { name: "G6 No Expiry", slug: `g6-no-expiry-${STAMP}` } });
      tenantId = tenant.id;
      const member = await tx.member.create({
        data: { tenantId, name: "G6 Member", email: `g6-no-expiry-${STAMP}@example.test` },
      });
      memberId = member.id;
      const cls = await tx.class.create({ data: { tenantId, name: "G6 Class", duration: 60, maxCapacity: 100 } });
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      for (let h = 6; h < 12; h++) {
        const i = await tx.classInstance.create({
          data: { classId: cls.id, date: today, startTime: `${String(h).padStart(2, "0")}:00`, endTime: `${String(h).padStart(2, "0")}:45` },
        });
        instances.push(i.id);
      }
      // Created the way the app now creates a template: no validity period.
      const template = await tx.classPack.create({ data: { tenantId, name: "Ten", totalCredits: 10, pricePence: 8000 } });
      templateId = template.id;
    });
  });

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.classPackRedemption.deleteMany({ where: { memberPack: { tenantId } } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.memberClassPack.deleteMany({ where: { tenantId } });
      await tx.classPack.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  async function resetPacks(rows: Array<{ key: string; expiresAt: Date | null; purchasedAt: Date; status?: string; credits?: number }>) {
    return withRlsBypass(async (tx) => {
      await tx.classPackRedemption.deleteMany({ where: { memberPack: { tenantId } } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.memberClassPack.deleteMany({ where: { tenantId } });
      const ids: Record<string, string> = {};
      for (const r of rows) {
        const p = await tx.memberClassPack.create({
          data: {
            tenantId, memberId, packId: templateId,
            creditsRemaining: r.credits ?? 3,
            status: r.status ?? "active",
            expiresAt: r.expiresAt,
            purchasedAt: r.purchasedAt,
          },
        });
        ids[r.key] = p.id;
      }
      return ids;
    });
  }

  // The kiosk shape the pack race test uses: the pack is redeemed when there
  // is one, and nothing else (rank, window, waiver, capacity) is judged.
  const checkIn = (classInstanceId: string) =>
    performCheckin({
      tenantId, memberId, classInstanceId, method: "kiosk",
      enforceRankGate: false, enforceTimeWindow: false, requireCoverage: false,
      enforceCapacity: false, enforceWaiverGate: false,
    });

  async function packState(id: string) {
    return withRlsBypass((tx) => tx.memberClassPack.findUnique({ where: { id }, select: { creditsRemaining: true, status: true, expiresAt: true } }));
  }

  it("a pack with NULL expiry is claimed", async () => {
    const ids = await resetPacks([{ key: "forever", expiresAt: null, purchasedAt: new Date("2026-09-01T10:00:00Z") }]);
    const r = await checkIn(instances[0]);
    expect(r.kind).toBe("success");
    if (r.kind === "success") expect(r.coverage).toMatchObject({ kind: "pack", creditsRemaining: 2 });
    expect(await packState(ids.forever)).toMatchObject({ creditsRemaining: 2, status: "active", expiresAt: null });
  });

  it("with two usable packs, the oldest purchase is spent first", async () => {
    const ids = await resetPacks([
      { key: "newer", expiresAt: null, purchasedAt: new Date("2026-10-20T10:00:00Z") },
      { key: "older", expiresAt: null, purchasedAt: new Date("2026-08-01T10:00:00Z") },
    ]);
    const r = await checkIn(instances[1]);
    expect(r.kind).toBe("success");
    expect((await packState(ids.older))?.creditsRemaining).toBe(2);
    expect((await packState(ids.newer))?.creditsRemaining).toBe(3);
  });

  it("a stray active pack whose expiry has passed is not spent; the never-expiring one is", async () => {
    const ids = await resetPacks([
      { key: "stale", expiresAt: new Date(Date.now() - 86_400_000), purchasedAt: new Date("2026-06-01T10:00:00Z") },
      { key: "forever", expiresAt: null, purchasedAt: new Date("2026-09-01T10:00:00Z") },
    ]);
    const r = await checkIn(instances[2]);
    expect(r.kind).toBe("success");
    expect((await packState(ids.stale))?.creditsRemaining).toBe(3);
    expect((await packState(ids.forever))?.creditsRemaining).toBe(2);
  });

  it("a refunded pack still stops working", async () => {
    const ids = await resetPacks([{ key: "refunded", expiresAt: null, purchasedAt: new Date("2026-09-01T10:00:00Z"), status: "refunded", credits: 0 }]);
    const r = await checkIn(instances[3]);
    // The kiosk shape records the visit without coverage; no credit is taken.
    if (r.kind === "success") expect(r.coverage?.kind).not.toBe("pack");
    expect(await packState(ids.refunded)).toMatchObject({ creditsRemaining: 0, status: "refunded" });
    const redemptions = await withRlsBypass((tx) => tx.classPackRedemption.count({ where: { memberPackId: ids.refunded } }));
    expect(redemptions).toBe(0);
  });

  it("the database refuses marking a never-expiring pack expired, and allows it for a dated one", async () => {
    const ids = await resetPacks([
      { key: "forever", expiresAt: null, purchasedAt: new Date("2026-09-01T10:00:00Z") },
      { key: "dated", expiresAt: new Date(Date.now() - 86_400_000), purchasedAt: new Date("2026-06-01T10:00:00Z") },
    ]);
    await expect(
      withRlsBypass((tx) => tx.memberClassPack.updateMany({ where: { id: ids.forever }, data: { status: "expired" } })),
    ).rejects.toThrow(/MemberClassPack_expired_has_expiry_check|check constraint/i);
    expect((await packState(ids.forever))?.status).toBe("active");
    await withRlsBypass((tx) => tx.memberClassPack.updateMany({ where: { id: ids.dated }, data: { status: "expired" } }));
    expect((await packState(ids.dated))?.status).toBe("expired");
  });

  it("a pack template can be stored with no validity period", async () => {
    const t = await withRlsBypass((tx) => tx.classPack.findUnique({ where: { id: templateId }, select: { validityDays: true } }));
    expect(t?.validityDays).toBeNull();
  });
});
