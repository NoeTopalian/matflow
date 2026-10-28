// Packs per product (owner decision, 27 Oct 2026): "Class packs: the club
// chooses an expiry or no expiry per new pack product. Existing purchases keep
// their recorded terms and remaining credits; do not revive expired credits or
// extend existing purchases through a blanket never-expire change. Later
// product edits must not silently rewrite sold entitlements."
//
// Against the real database:
//   - the sale (signed Stripe webhook) records the product's term on the
//     purchase: purchasedAt + validityDays, or NULL for a no-expiry product;
//   - editing or deactivating the product (the owner's PATCH / DELETE routes)
//     leaves every sold pack exactly as it was;
//   - performCheckin (the path every door takes to claim a pack) spends a
//     no-expiry pack and a dated pack still in date, refuses a dated pack past
//     its date and a legacy "expired" pack, and never spends a refunded one;
//   - claim order: earliest expiry first, no-expiry last, then oldest purchase;
//   - the schema end state: both columns nullable, the withdrawn draft's CHECK gone;
//   - the guard (20261027140000): an expired pack must carry its date, so marking a no-expiry pack expired is
//     refused and expiring a dated pack is allowed.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextRequest: class extends Request {},
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));
const staff = vi.hoisted(() => ({ tenantId: "", userId: "" }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: vi.fn(async () => ({ ok: true, tenantId: staff.tenantId, userId: staff.userId, role: "owner" })),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: true })) }));
vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));
vi.mock("@/lib/stripe-account-status", () => ({ refreshStripeAccountStatus: vi.fn(async () => {}) }));

import Stripe from "stripe";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { performCheckin } from "@/lib/checkin";
import { POST as stripeWebhook } from "@/app/api/stripe/webhook/route";
import { PATCH as editProduct, DELETE as deactivateProduct } from "@/app/api/class-packs/[id]/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const SECRET = "whsec_packs_per_product_synthetic";
const DAY = 86_400_000;

describe.skipIf(!HAS_DB)("class packs: expiry chosen per product (27 Oct 2026)", () => {
  let tenantId: string;
  let memberId: string;
  let datedProduct: string;
  let openProduct: string;
  const instances: string[] = [];
  let next = 0;
  const instance = () => instances[next++];

  beforeAll(async () => {
    process.env.STRIPE_WEBHOOK_SECRET = SECRET;
    process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "sk_test_packs_per_product_synthetic_never_used";
    await withRlsBypass(async (tx) => {
      const tenant = await tx.tenant.create({
        data: { name: "Packs per product", slug: `packs-per-product-${STAMP}`, stripeAccountId: `acct_ppp_${STAMP}` },
      });
      tenantId = tenant.id;
      staff.tenantId = tenantId;
      staff.userId = (await tx.user.create({
        data: { tenantId, email: `ppp-owner-${STAMP}@example.test`, name: "Owner", role: "owner", passwordHash: "x" },
      })).id;
      memberId = (await tx.member.create({
        data: { tenantId, name: "Pack Member", email: `ppp-member-${STAMP}@example.test` },
      })).id;
      const cls = await tx.class.create({ data: { tenantId, name: "Pack Class", duration: 60, maxCapacity: 100 } });
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      for (let h = 0; h < 20; h++) {
        const start = `${String(h).padStart(2, "0")}:00`;
        const i = await tx.classInstance.create({ data: { classId: cls.id, date: today, startTime: start, endTime: `${String(h).padStart(2, "0")}:45` } });
        instances.push(i.id);
      }
      datedProduct = (await tx.classPack.create({ data: { tenantId, name: "Ten, 30 days", totalCredits: 10, validityDays: 30, pricePence: 8000 } })).id;
      openProduct = (await tx.classPack.create({ data: { tenantId, name: "Ten, no expiry", totalCredits: 10, validityDays: null, pricePence: 9000 } })).id;
    });
  });

  afterAll(async () => {
    if (!tenantId) return;
    await withRlsBypass(async (tx) => {
      await tx.stripeEvent.deleteMany({ where: { eventId: { startsWith: `evt_ppp_${STAMP}` } } });
      await tx.classPackRedemption.deleteMany({ where: { memberPack: { tenantId } } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.payment.deleteMany({ where: { tenantId } });
      await tx.memberClassPack.deleteMany({ where: { tenantId } });
      await tx.classPack.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  });

  async function sell(productId: string, key: string) {
    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, { apiVersion: "2026-03-25.dahlia" as never });
    const payload = JSON.stringify({
      id: `evt_ppp_${STAMP}_${key}`, object: "event", type: "checkout.session.completed", account: `acct_ppp_${STAMP}`,
      livemode: false, created: Math.floor(Date.now() / 1000),
      data: { object: {
        id: `cs_ppp_${STAMP}_${key}`, object: "checkout.session", mode: "payment", payment_status: "paid",
        payment_intent: `pi_ppp_${STAMP}_${key}`, amount_total: 8000, currency: "gbp",
        metadata: { matflowKind: "class_pack", tenantId, memberId, packId: productId },
      } },
    });
    const signature = stripe.webhooks.generateTestHeaderString({ payload, secret: SECRET, timestamp: Math.floor(Date.now() / 1000) } as Parameters<typeof stripe.webhooks.generateTestHeaderString>[0]);
    const res = (await stripeWebhook(new Request("http://localhost/api/stripe/webhook", {
      method: "POST", headers: new Headers({ "content-type": "application/json", "stripe-signature": signature }), body: payload,
    }) as never)) as unknown as { status: number };
    expect(res.status).toBe(200);
    const row = await withRlsBypass((tx) => tx.memberClassPack.findUnique({ where: { stripePaymentIntentId: `pi_ppp_${STAMP}_${key}` } }));
    expect(row).not.toBeNull();
    return row!;
  }

  async function resetPacks(rows: Array<{ key: string; expiresAt: Date | null; purchasedAt: Date; status?: string; credits?: number; product?: string }>) {
    return withRlsBypass(async (tx) => {
      await tx.classPackRedemption.deleteMany({ where: { memberPack: { tenantId } } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.memberClassPack.deleteMany({ where: { tenantId } });
      const ids: Record<string, string> = {};
      for (const r of rows) {
        const p = await tx.memberClassPack.create({
          data: {
            tenantId, memberId, packId: r.product ?? datedProduct,
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

  // The kiosk shape: the pack is redeemed when there is one, and nothing else
  // (rank, window, waiver, capacity) is judged.
  const checkIn = () =>
    performCheckin({
      tenantId, memberId, classInstanceId: instance(), method: "kiosk",
      enforceRankGate: false, enforceTimeWindow: false, requireCoverage: false,
      enforceCapacity: false, enforceWaiverGate: false,
    });

  const packState = (id: string) =>
    withRlsBypass((tx) => tx.memberClassPack.findUnique({ where: { id }, select: { creditsRemaining: true, status: true, expiresAt: true, purchasedAt: true } }));
  const redemptionsOf = (id: string) => withRlsBypass((tx) => tx.classPackRedemption.count({ where: { memberPackId: id } }));

  describe("the sale records the product's term", () => {
    it("a no-expiry product produces a purchase with expiresAt NULL", async () => {
      const row = await sell(openProduct, "open");
      expect(row).toMatchObject({ expiresAt: null, creditsRemaining: 10, status: "active" });
    });

    it("a dated product produces a purchase that expires validityDays after purchasedAt", async () => {
      const row = await sell(datedProduct, "dated");
      expect(row.expiresAt).not.toBeNull();
      expect(row.expiresAt!.getTime() - row.purchasedAt.getTime()).toBe(30 * DAY);
      expect(row).toMatchObject({ creditsRemaining: 10, status: "active" });
    });
  });

  describe("editing a product never rewrites a sold pack", () => {
    it("PATCH (name, description, on-sale, and an attempted validity change) and DELETE leave sold packs as recorded", async () => {
      const ids = await resetPacks([
        { key: "dated", expiresAt: new Date(Date.now() + 10 * DAY), purchasedAt: new Date(Date.now() - 20 * DAY), credits: 4 },
        { key: "open", expiresAt: null, purchasedAt: new Date(Date.now() - 5 * DAY), credits: 7, product: openProduct },
      ]);
      const before = { dated: await packState(ids.dated), open: await packState(ids.open) };

      const params = (id: string) => ({ params: Promise.resolve({ id }) });
      const req = (body?: unknown) => new Request("http://localhost/api/class-packs/x", {
        method: body === undefined ? "DELETE" : "PATCH",
        headers: { "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      expect((await editProduct(req({ name: "Renamed", description: "New words", isActive: false, validityDays: null }), params(datedProduct))).status).toBe(200);
      expect((await editProduct(req({ name: "Renamed open", validityDays: 7 }), params(openProduct))).status).toBe(200);
      expect((await deactivateProduct(req(), params(datedProduct))).status).toBe(200);

      expect(await packState(ids.dated)).toEqual(before.dated);
      expect(await packState(ids.open)).toEqual(before.open);
      // The validity is fixed at creation: an edit does not change it.
      const products = await withRlsBypass((tx) => tx.classPack.findMany({ where: { tenantId }, select: { id: true, validityDays: true, name: true } }));
      expect(products.find((p) => p.id === datedProduct)).toMatchObject({ validityDays: 30, name: "Renamed" });
      expect(products.find((p) => p.id === openProduct)).toMatchObject({ validityDays: null, name: "Renamed open" });
    });

    it("a sold pack's own date governs, whatever the product says now", async () => {
      // Even if the product's validity were changed some other way, a purchase
      // past its recorded date stays expired, and one with no date stays open.
      await withRlsBypass((tx) => tx.classPack.update({ where: { id: datedProduct }, data: { validityDays: null } }));
      const ids = await resetPacks([{ key: "past", expiresAt: new Date(Date.now() - DAY), purchasedAt: new Date(Date.now() - 31 * DAY) }]);
      const r = await checkIn();
      if (r.kind === "success") expect(r.coverage?.kind).not.toBe("pack");
      expect(await packState(ids.past)).toMatchObject({ creditsRemaining: 3, status: "active" });
      await withRlsBypass((tx) => tx.classPack.update({ where: { id: datedProduct }, data: { validityDays: 30 } }));
    });
  });

  describe("spending", () => {
    it("a no-expiry pack is spent", async () => {
      const ids = await resetPacks([{ key: "open", expiresAt: null, purchasedAt: new Date("2026-09-01T10:00:00Z"), product: openProduct }]);
      const r = await checkIn();
      expect(r.kind).toBe("success");
      if (r.kind === "success") expect(r.coverage).toMatchObject({ kind: "pack", creditsRemaining: 2 });
      expect(await packState(ids.open)).toMatchObject({ creditsRemaining: 2, status: "active", expiresAt: null });
    });

    it("a dated pack still in date is spent", async () => {
      const ids = await resetPacks([{ key: "dated", expiresAt: new Date(Date.now() + DAY), purchasedAt: new Date(Date.now() - 29 * DAY) }]);
      const r = await checkIn();
      if (r.kind === "success") expect(r.coverage).toMatchObject({ kind: "pack", creditsRemaining: 2 });
      expect((await packState(ids.dated))?.creditsRemaining).toBe(2);
    });

    it("a dated pack past its date is refused: no credit taken, no redemption", async () => {
      const ids = await resetPacks([{ key: "past", expiresAt: new Date(Date.now() - 60_000), purchasedAt: new Date(Date.now() - 30 * DAY) }]);
      const r = await checkIn();
      if (r.kind === "success") expect(r.coverage?.kind).not.toBe("pack");
      expect(await packState(ids.past)).toMatchObject({ creditsRemaining: 3, status: "active" });
      expect(await redemptionsOf(ids.past)).toBe(0);
    });

    it("a legacy \"expired\" pack with credits is refused, even with a date still ahead; it is not revived", async () => {
      const ids = await resetPacks([
        { key: "legacyPast", expiresAt: new Date("2026-07-01T00:00:00Z"), purchasedAt: new Date("2026-04-01T10:00:00Z"), status: "expired" },
        { key: "legacyAhead", expiresAt: new Date(Date.now() + 30 * DAY), purchasedAt: new Date("2026-04-02T10:00:00Z"), status: "expired" },
      ]);
      const r = await checkIn();
      if (r.kind === "success") expect(r.coverage?.kind).not.toBe("pack");
      expect(await packState(ids.legacyPast)).toMatchObject({ creditsRemaining: 3, status: "expired" });
      expect(await packState(ids.legacyAhead)).toMatchObject({ creditsRemaining: 3, status: "expired" });
    });

    it("a refunded pack is never spent", async () => {
      const ids = await resetPacks([{ key: "refunded", expiresAt: null, purchasedAt: new Date("2026-09-01T10:00:00Z"), status: "refunded", credits: 0, product: openProduct }]);
      const r = await checkIn();
      if (r.kind === "success") expect(r.coverage?.kind).not.toBe("pack");
      expect(await packState(ids.refunded)).toMatchObject({ creditsRemaining: 0, status: "refunded" });
      expect(await redemptionsOf(ids.refunded)).toBe(0);
    });
  });

  describe("claim order", () => {
    it("earliest expiry first, ahead of an older purchase with a later date and an older no-expiry pack", async () => {
      const ids = await resetPacks([
        { key: "openOldest", expiresAt: null, purchasedAt: new Date(Date.now() - 90 * DAY), product: openProduct },
        { key: "late", expiresAt: new Date(Date.now() + 20 * DAY), purchasedAt: new Date(Date.now() - 60 * DAY) },
        { key: "soon", expiresAt: new Date(Date.now() + 2 * DAY), purchasedAt: new Date(Date.now() - 10 * DAY) },
      ]);
      await checkIn();
      expect((await packState(ids.soon))?.creditsRemaining).toBe(2);
      expect((await packState(ids.late))?.creditsRemaining).toBe(3);
      expect((await packState(ids.openOldest))?.creditsRemaining).toBe(3);
    });

    it("no-expiry packs come after every dated pack, then the oldest purchase first", async () => {
      const ids = await resetPacks([
        { key: "openNewer", expiresAt: null, purchasedAt: new Date(Date.now() - 5 * DAY), product: openProduct, credits: 1 },
        { key: "openOlder", expiresAt: null, purchasedAt: new Date(Date.now() - 50 * DAY), product: openProduct, credits: 1 },
        { key: "dated", expiresAt: new Date(Date.now() + 300 * DAY), purchasedAt: new Date(Date.now() - DAY), credits: 1 },
      ]);
      const spent: string[] = [];
      for (let n = 0; n < 3; n++) {
        await checkIn();
        for (const key of ["dated", "openOlder", "openNewer"]) {
          if (!spent.includes(key) && (await packState(ids[key]))?.creditsRemaining === 0) spent.push(key);
        }
        expect(spent).toHaveLength(n + 1);
      }
      expect(spent).toEqual(["dated", "openOlder", "openNewer"]);
    });
  });

  it("schema end state: expiresAt and validityDays nullable; the withdrawn draft's CHECK gone, the expired-needs-date guard present", async () => {
    const cols = await withRlsBypass((tx) => tx.$queryRaw<Array<{ table_name: string; column_name: string; is_nullable: string }>>`
      select table_name, column_name, is_nullable from information_schema.columns
      where table_schema = 'public' and ((table_name = 'MemberClassPack' and column_name = 'expiresAt') or (table_name = 'ClassPack' and column_name = 'validityDays'))`);
    expect(cols).toHaveLength(2);
    for (const c of cols) expect(c.is_nullable).toBe("YES");
    const checks = await withRlsBypass((tx) => tx.$queryRaw<Array<{ conname: string }>>`
      select conname from pg_constraint where conrelid = '"MemberClassPack"'::regclass and contype = 'c'`);
    expect(checks.map((c) => c.conname)).not.toContain("MemberClassPack_expired_has_expiry_check");
    expect(checks.map((c) => c.conname)).toContain("MemberClassPack_expired_needs_date_check");
  });

  // 20261027140000: the build before this release marks a pack "expired" when `expiresAt < now`, and `null < now`
  // is true in JavaScript. The CHECK refuses that write for a no-expiry pack, so an older deployment still serving
  // (deploy window, Vercel Skew Protection) cannot take a member's no-expiry pack away. Dated packs may still expire.
  describe("guard: an expired pack must carry its date", () => {
    const refused = (e: unknown) => /MemberClassPack_expired_needs_date_check|23514|check constraint/i.test(String((e as Error)?.message ?? e));

    it("marking a no-expiry pack expired is refused (the older build's updateMany) and the pack stays active", async () => {
      const ids = await resetPacks([{ key: "open", expiresAt: null, purchasedAt: new Date(Date.now() - DAY), product: openProduct, credits: 6 }]);
      const err = await withRlsBypass((tx) => tx.memberClassPack.updateMany({ where: { id: { in: [ids.open] } }, data: { status: "expired" } }))
        .then(() => null, (e: unknown) => e);
      expect(err).not.toBeNull();
      expect(refused(err)).toBe(true);
      expect(await packState(ids.open)).toMatchObject({ status: "active", creditsRemaining: 6, expiresAt: null });
    });

    it("inserting an expired pack with no date is refused (raw SQL)", async () => {
      const id = `ppp-raw-${STAMP}`;
      const err = await withRlsBypass((tx) => tx.$executeRaw`
        INSERT INTO "MemberClassPack" (id, "tenantId", "memberId", "packId", "creditsRemaining", "expiresAt", status)
        VALUES (${id}, ${tenantId}, ${memberId}, ${openProduct}, 3, NULL, 'expired')`)
        .then(() => null, (e: unknown) => e);
      expect(err).not.toBeNull();
      expect(refused(err)).toBe(true);
      expect(await withRlsBypass((tx) => tx.memberClassPack.count({ where: { id } }))).toBe(0);
    });

    it("marking a dated pack past its date expired is allowed", async () => {
      const past = new Date(Date.now() - DAY);
      const ids = await resetPacks([{ key: "past", expiresAt: past, purchasedAt: new Date(Date.now() - 31 * DAY), credits: 2 }]);
      const r = await withRlsBypass((tx) => tx.memberClassPack.updateMany({ where: { id: ids.past }, data: { status: "expired" } }));
      expect(r.count).toBe(1);
      expect(await packState(ids.past)).toMatchObject({ status: "expired", creditsRemaining: 2, expiresAt: past });
    });
  });
});
