// G6 (owner decision, 27 Oct 2026): "It should be till it runs out". A class
// pack is usable until its credits are used or it is refunded. The code does
// not read MemberClassPack.expiresAt or the legacy status "expired".
//
// Against the real database, through performCheckin (the path every door
// takes to claim a pack):
//   - a pack with NULL expiry is claimed;
//   - a pack whose old expiry date has passed is claimed (a pack bought
//     through the previous build during the deploy carries such a date);
//   - a legacy "expired" pack with credits left is claimed;
//   - with several usable packs, the oldest purchase is spent first;
//   - a refunded pack is never spent;
//   - the schema end state: both columns nullable, no expiry CHECK.

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

  it("a pack whose old expiry date has passed is claimed", async () => {
    const ids = await resetPacks([{ key: "dated", expiresAt: new Date(Date.now() - 86_400_000), purchasedAt: new Date("2026-06-01T10:00:00Z") }]);
    const r = await checkIn(instances[2]);
    expect(r.kind).toBe("success");
    if (r.kind === "success") expect(r.coverage).toMatchObject({ kind: "pack", creditsRemaining: 2 });
    expect(await packState(ids.dated)).toMatchObject({ creditsRemaining: 2, status: "active" });
  });

  it("a legacy expired pack with credits left is claimed, before a newer pack, and its status is not rewritten", async () => {
    const ids = await resetPacks([
      { key: "legacy", expiresAt: new Date("2026-07-01T00:00:00Z"), purchasedAt: new Date("2026-04-01T10:00:00Z"), status: "expired" },
      { key: "newer", expiresAt: null, purchasedAt: new Date("2026-10-01T10:00:00Z") },
    ]);
    const r = await checkIn(instances[4]);
    expect(r.kind).toBe("success");
    expect(await packState(ids.legacy)).toMatchObject({ creditsRemaining: 2, status: "expired" });
    expect((await packState(ids.newer))?.creditsRemaining).toBe(3);
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

  it("schema end state: expiresAt and validityDays nullable, and no expiry CHECK on MemberClassPack", async () => {
    const cols = await withRlsBypass((tx) => tx.$queryRaw<Array<{ table_name: string; column_name: string; is_nullable: string }>>`
      select table_name, column_name, is_nullable from information_schema.columns
      where table_schema = 'public' and ((table_name = 'MemberClassPack' and column_name = 'expiresAt') or (table_name = 'ClassPack' and column_name = 'validityDays'))`);
    expect(cols).toHaveLength(2);
    for (const c of cols) expect(c.is_nullable).toBe("YES");
    const checks = await withRlsBypass((tx) => tx.$queryRaw<Array<{ conname: string }>>`
      select conname from pg_constraint where conrelid = '"MemberClassPack"'::regclass and contype = 'c'`);
    expect(checks.map((c) => c.conname)).not.toContain("MemberClassPack_expired_has_expiry_check");
  });

  it("a pack template can be stored with no validity period", async () => {
    const t = await withRlsBypass((tx) => tx.classPack.findUnique({ where: { id: templateId }, select: { validityDays: true } }));
    expect(t?.validityDays).toBeNull();
  });
});
