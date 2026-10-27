// The card scanner's abort-and-retry, against the real engine and database
// (review gap 4, 21 Oct 2026). The scanner aborts a request after 10 s and
// lets the coach hold the card again; the server may still commit the first
// request. Proved here: the retry is answered "duplicate", the member has ONE
// attendance row, and the class-pack credit that paid past the used-up
// allowance is spent once — never a second attendance, never a second
// consumption. There is no allowance override (owner decision, 27 Oct 2026):
// an old scanner's acknowledgement admits no one. Also measured: the route's own
// time from this machine (printed as a NOTE line; the scanner's client
// timeout is 10 s).
import { describe, it, beforeAll, afterAll, expect, vi } from "vitest";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { signCardToken } from "@/lib/card-token";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/api-authz", () => ({
  requireApiStaff: vi.fn(async () => ({ ok: true, tenantId: state.tenantId, userId: state.userId, role: "coach" })),
}));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn(async () => ({ allowed: true })), getClientIp: () => "127.0.0.1" }));
const audit = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async (entry: Record<string, unknown>) => { audit.calls.push(entry); }) }));
const state = vi.hoisted(() => ({ tenantId: "", userId: "" }));

import { POST as cardRoute } from "@/app/api/checkin/card/route";

const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();
process.env.NEXTAUTH_SECRET = process.env.NEXTAUTH_SECRET ?? "card-scan-retry-synthetic-secret";

async function scan(classInstanceId: string, token: string, acknowledged?: string[]) {
  const t0 = Date.now();
  const res = (await cardRoute(
    new Request("http://test/api/checkin/card", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ classInstanceId, tokens: [token], ...(acknowledged ? { acknowledged } : {}) }),
    }),
  )) as unknown as { status: number; json: () => Promise<{ results: Array<Record<string, unknown>>; recorded: number }> };
  return { status: res.status, body: await res.json(), ms: Date.now() - t0 };
}

describe.skipIf(!HAS_DB)("card scan: abort-and-retry cannot duplicate attendance or allowance consumption", () => {
  let memberId = "";
  let used = "";
  let next = "";
  let token = "";
  let memberPackId = "";

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      state.tenantId = (await tx.tenant.create({ data: { name: `Card retry ${STAMP}`, slug: `card-retry-${STAMP}` } })).id;
      state.userId = (await tx.user.create({ data: { tenantId: state.tenantId, email: `card-retry-${STAMP}@test.local`, name: "Coach", role: "coach", passwordHash: "x" } })).id;
      const tier = (await tx.membershipTier.create({ data: { tenantId: state.tenantId, name: "One a week", classLimit: 1, classLimitBasis: "week" } })).id;
      memberId = (await tx.member.create({
        data: { tenantId: state.tenantId, name: "Retry Member", email: `card-retry-m-${STAMP}@test.local`, membershipTierId: tier, waiverAccepted: true, paymentStatus: "paid" },
      })).id;
      const cls = (await tx.class.create({ data: { tenantId: state.tenantId, name: "Retry class", duration: 60, maxCapacity: 50 } })).id;
      // Both sessions in one week (Mon 5 Jan 2032 and Tue 6 Jan 2032); the first is already attended.
      used = (await tx.classInstance.create({ data: { classId: cls, date: new Date(Date.UTC(2032, 0, 5)), startTime: "18:00", endTime: "19:00" } })).id;
      next = (await tx.classInstance.create({ data: { classId: cls, date: new Date(Date.UTC(2032, 0, 6)), startTime: "18:00", endTime: "19:00" } })).id;
      await tx.attendanceRecord.create({ data: { tenantId: state.tenantId, memberId, classInstanceId: used, checkInMethod: "admin" } });
    });
    token = signCardToken({ tenantId: state.tenantId, memberId, cardVersion: 1 });
  }, 60_000);

  afterAll(async () => {
    if (!state.tenantId) return;
    const tenantId = state.tenantId;
    await withRlsBypass(async (tx) => {
      await tx.classPackRedemption.deleteMany({ where: { memberPack: { tenantId } } });
      await tx.memberClassPack.deleteMany({ where: { tenantId } });
      await tx.classPack.deleteMany({ where: { tenantId } });
      await tx.attendanceRecord.deleteMany({ where: { tenantId } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId } } });
      await tx.class.deleteMany({ where: { tenantId } });
      await tx.member.deleteMany({ where: { tenantId } });
      await tx.membershipTier.deleteMany({ where: { tenantId } });
      await tx.user.deleteMany({ where: { tenantId } });
      await tx.tenant.deleteMany({ where: { id: tenantId } });
    });
  }, 60_000);

  const rows = () => withRlsBypass((tx) => tx.attendanceRecord.count({ where: { memberId, classInstanceId: next } }));
  const credits = async () =>
    (await withRlsBypass((tx) => tx.memberClassPack.findUnique({ where: { id: memberPackId }, select: { creditsRemaining: true } })))?.creditsRemaining;

  it("at the limit with no pack the card is refused, and an old scanner's acknowledgement admits no one", async () => {
    const asked = await scan(next, token);
    expect(asked.body.results[0]).toMatchObject({ status: "refused", reason: "allowance_reached" });
    expect(String(asked.body.results[0].message)).toMatch(/^Retry Member has used their 1 class .* and has no class-pack credit, so they can't be checked in\.$/);
    const old = await scan(next, token, ["allowance_reached"]);
    expect(old.status).toBe(200);
    expect(old.body.results[0]).toMatchObject({ status: "refused", reason: "allowance_reached" });
    expect(await rows()).toBe(0);
    expect(audit.calls.filter((e) => e.action === "attendance.card_scan")).toHaveLength(0);
  });

  it("with a pack the card is admitted once on a pack credit; the same card again is 'duplicate': one row, one credit", async () => {
    await withRlsBypass(async (tx) => {
      const template = await tx.classPack.create({ data: { tenantId: state.tenantId, name: "Five", totalCredits: 5, validityDays: 90, pricePence: 5000 } });
      memberPackId = (await tx.memberClassPack.create({
        data: { tenantId: state.tenantId, memberId, packId: template.id, creditsRemaining: 3, status: "active", expiresAt: new Date(Date.now() + 60 * 86_400_000) },
      })).id;
    });
    const admitted = await scan(next, token);
    expect(admitted.body.results[0].status).toBe("success");
    expect(await rows()).toBe(1);
    expect(await credits()).toBe(2);
    const scans = audit.calls.filter((e) => e.action === "attendance.card_scan");
    expect(scans).toHaveLength(1);
    expect(scans[0].metadata as Record<string, unknown>).not.toHaveProperty("overrides");

    // The browser aborted after 10 s but the server had committed; the coach holds the card again.
    const retry = await scan(next, token);
    expect(retry.body.results[0].status).toBe("duplicate");
    expect(retry.body.recorded).toBe(0);
    expect(await rows()).toBe(1);
    expect(await credits()).toBe(2);
    expect(audit.calls.filter((e) => e.action === "attendance.card_scan")).toHaveLength(1);
    // An old scanner resending with an acknowledgement is a duplicate too, never a second credit.
    const plain = await scan(next, token, ["allowance_reached"]);
    expect(plain.body.results[0].status).toBe("duplicate");
    expect(await rows()).toBe(1);
    expect(await credits()).toBe(2);
    console.log(`NOTE card route timings from this machine: admitted ${admitted.ms} ms, retry ${retry.ms} ms (scanner client timeout 10000 ms)`);
  }, 120_000);
});
