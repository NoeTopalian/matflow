// The card scanner's abort-and-retry, against the real engine and database
// (review gap 4, 21 Oct 2026). The scanner aborts a request after 10 s and
// lets the coach hold the card again; the server may still commit the first
// request. Proved here: the retry is answered "duplicate", the member has ONE
// attendance row, and an allowance override is recorded once — never a second
// attendance, never a second consumption. Also measured: the route's own
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

  it("asked, then admitted once; the same confirmed card again is 'duplicate': one row, one override", async () => {
    const asked = await scan(next, token);
    expect(asked.body.results[0]).toMatchObject({ status: "needs_confirmation", reason: "allowance_reached" });
    expect(await rows()).toBe(0);

    const admitted = await scan(next, token, ["allowance_reached"]);
    expect(admitted.body.results[0].status).toBe("success");
    expect(await rows()).toBe(1);
    const overrides = audit.calls.filter((e) => e.action === "attendance.card_scan");
    expect(overrides).toHaveLength(1);
    expect((overrides[0].metadata as { overrides?: unknown[] }).overrides).toHaveLength(1);

    // The browser aborted after 10 s but the server had committed; the coach holds the card again.
    const retry = await scan(next, token, ["allowance_reached"]);
    expect(retry.body.results[0].status).toBe("duplicate");
    expect(retry.body.recorded).toBe(0);
    expect(await rows()).toBe(1);
    expect(audit.calls.filter((e) => e.action === "attendance.card_scan")).toHaveLength(1);
    // And an unconfirmed retry (a scanner that lost its answer) is a duplicate too, not a second question.
    const plain = await scan(next, token);
    expect(plain.body.results[0].status).toBe("duplicate");
    expect(await rows()).toBe(1);

    console.log(`NOTE card route timings from this machine: asked ${asked.ms} ms, admitted ${admitted.ms} ms, retry ${retry.ms} ms (scanner client timeout 10000 ms)`);
  }, 120_000);
});
