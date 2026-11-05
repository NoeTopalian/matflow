// The Activity feed against Postgres (run as the owner role and as matflow_app
// by .claude/skills/matflow-verify-local/scripts/db-tests.mjs).
//
// What only the database can prove:
//  - the hand-written NULL-safe predicates select what the in-memory rules say
//    (a member edit with no `status`, a check-in with no `acknowledged`, a row
//    with no metadata at all);
//  - the SQL model the unit tests rely on (tests/unit/activity-where-eval.ts)
//    answers as Postgres does;
//  - a manager cannot be sent an owner-only row by any parameter;
//  - names come only from this club, and an erased member's old values are in
//    nobody's response.
//
// Synthetic clubs only (slug mfv-act-…), created here and torn down to nothing.
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/rate-limit", async (original) => ({ ...(await original<typeof import("@/lib/rate-limit")>()), checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })) }));

import { auth } from "@/auth";
import { withRlsBypass, withTenantContext } from "@/lib/prisma-tenant";
import { GET } from "@/app/api/activity/route";
import { ACTIVITY_TYPES, visibleTypeKeys, type ActivityResponse } from "@/lib/activity-types";
import { typeOf, typesFinding, visibleWhere, whereForTypes } from "@/lib/activity-feed";
import { selects } from "../unit/activity-where-eval";

const STAMP = randomUUID().slice(0, 8);
const id = (name: string) => `mfv${STAMP}${name}`;
const ALL_KEYS = ACTIVITY_TYPES.map((t) => t.key);

// The rows are written "yesterday evening", so the test holds whenever it runs:
// 20:00 UTC and the 45 minutes before it are one calendar day in London all year.
const today = new Date();
const BASE = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - 1, 20, 0, 0);
const ROW_DAY = new Date(BASE).toISOString().slice(0, 10);
const DAY_BEFORE = new Date(BASE - 24 * 3_600_000).toISOString().slice(0, 10);

type Row = { id: string; tenantId: string; action: string; entityType: string; entityId: string; metadata: unknown; createdAt: Date; userId: string | null; operatorId: string | null };

describe.skipIf(!process.env.TEST_DATABASE_URL)("Activity feed — the database agrees", () => {
  const A = id("clubA");
  const B = id("clubB");
  const OWNER = id("owner");
  const MANAGER = id("manager");
  const JACK = id("jack");
  const OPERATOR = id("operator");
  const m = { mel: id("mel"), faisal: id("faisal"), kid: id("kid"), ada: id("ada"), erased: id("erased"), gone: id("gone"), other: id("otherB") };
  const cls = id("class");
  const session = id("session");
  const sessionB = id("sessionB");
  const tierAdult = id("tierAdult");
  const tierOld = id("tierOld");
  const payment = id("payment");
  const paymentB = id("paymentB");
  const invoice = `in_${STAMP}`;

  const rows: Row[] = [];
  let minute = 0;
  /** Each row a minute older than the last, so the order is known. */
  function add(action: string, over: Partial<Row> = {}, tenantId = A): Row {
    const row: Row = { id: id(`a${String(rows.length).padStart(3, "0")}`), tenantId, action, entityType: "Member", entityId: m.mel, metadata: null, createdAt: new Date(BASE - minute++ * 60_000), userId: null, operatorId: null, ...over };
    rows.push(row);
    return row;
  }
  const named: Record<string, Row> = {};

  const as = (role: "owner" | "manager", tenantId = A) => vi.mocked(auth).mockResolvedValue({ user: { id: role === "owner" ? OWNER : MANAGER, role, tenantId } } as never);
  async function get(query = ""): Promise<ActivityResponse> {
    const res = await GET(new Request(`https://test.local/api/activity${query}`));
    expect(res.status, query).toBe(200);
    return (await res.json()) as ActivityResponse;
  }
  /** Every page, following the cursor. */
  async function all(query: string): Promise<ActivityResponse["entries"]> {
    const out: ActivityResponse["entries"] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page++) {
      const body = await get(`${query}${query ? "&" : "?"}${cursor ? `cursor=${cursor}` : "take=50"}`);
      out.push(...body.entries);
      cursor = body.nextCursor;
      if (!cursor) break;
    }
    return out;
  }
  const inA = () => rows.filter((r) => r.tenantId === A);

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.tenant.createMany({ data: [{ id: A, name: `Synthetic activity A ${STAMP}`, slug: `mfv-act-a-${STAMP}`, timezone: "Europe/London" }, { id: B, name: `Synthetic activity B ${STAMP}`, slug: `mfv-act-b-${STAMP}`, timezone: "Europe/London" }] });
      await tx.operator.create({ data: { id: OPERATOR, email: `mfv-op-${STAMP}@example.test`, name: "Synthetic Operator", passwordHash: "x" } });
      await tx.user.createMany({
        data: [
          { id: OWNER, tenantId: A, email: `owner-${STAMP}@example.test`, passwordHash: "x", name: "Olive Owner", role: "owner" },
          { id: MANAGER, tenantId: A, email: `manager-${STAMP}@example.test`, passwordHash: "x", name: "Mina Manager", role: "manager" },
          { id: JACK, tenantId: A, email: `jack-${STAMP}@example.test`, passwordHash: "x", name: "Jack Streeter", role: "coach" },
        ],
      });
      await tx.membershipTier.createMany({ data: [{ id: tierAdult, tenantId: A, name: "Adult Unlimited" }, { id: tierOld, tenantId: A, name: "Twice a week (OLD)" }] });
      await tx.member.createMany({
        data: [
          { id: m.mel, tenantId: A, email: `mel-${STAMP}@example.test`, name: "Melody Orekoya" },
          { id: m.faisal, tenantId: A, email: `faisal-${STAMP}@example.test`, name: "Faisal Alshukri" },
          { id: m.kid, tenantId: A, email: `kid-${STAMP}@example.test`, name: "Zara Alshukri" },
          { id: m.ada, tenantId: A, email: `ada-${STAMP}@example.test`, name: "Ada Obi" },
          { id: m.erased, tenantId: A, email: `erase-me-${STAMP}@example.test`, name: "Erin Erased", phone: "07700 900555" },
          { id: m.other, tenantId: B, email: `other-${STAMP}@example.test`, name: "Other Club Person" },
        ],
      });
      await tx.class.createMany({ data: [{ id: cls, tenantId: A, name: "Advanced No-Gi" }, { id: id("classB"), tenantId: B, name: "Other Club Class" }] });
      await tx.classInstance.createMany({ data: [{ id: session, classId: cls, date: new Date("2026-11-04T00:00:00Z"), startTime: "19:00" }, { id: sessionB, classId: id("classB"), date: new Date("2026-11-04T00:00:00Z"), startTime: "18:00" }] });
      await tx.payment.createMany({
        data: [
          { id: payment, tenantId: A, memberId: m.mel, amountPence: 4500, currency: "GBP", status: "succeeded", stripeInvoiceId: invoice, paidAt: new Date("2026-11-03T09:00:00Z") },
          { id: paymentB, tenantId: B, memberId: m.other, amountPence: 99900, currency: "GBP", status: "succeeded" },
        ],
      });
    });

    const byJack = { userId: JACK };
    const byOwner = { userId: OWNER };
    const checkin = { entityType: "AttendanceRecord", entityId: id("rec") };
    named.self = add("attendance.self_checkin", { ...checkin, metadata: { classInstanceId: session, memberId: m.mel, method: "self", actorId: m.mel } });
    named.parent = add("attendance.self_checkin", { ...checkin, metadata: { classInstanceId: session, memberId: m.kid, method: "self", onBehalfOf: m.kid, actorId: m.faisal } });
    named.kiosk = add("attendance.kiosk_checkin", { ...checkin, metadata: { memberId: m.ada, classInstanceId: session, coverage: "membership", actorId: m.ada } });
    named.scan = add("attendance.card_scan", { entityType: "ClassInstance", entityId: session, ...byJack, metadata: { classInstanceId: session, scanned: 3, recorded: 3, memberIds: [m.ada, m.faisal, m.mel] } });
    named.markWarned = add("attendance.mark", { ...checkin, ...byJack, metadata: { classInstanceId: session, memberId: m.mel, method: "admin", created: true, acknowledged: ["waiver_unsigned"] } });
    named.markPlain = add("attendance.mark", { ...checkin, ...byJack, metadata: { classInstanceId: session, memberId: m.mel, method: "admin", created: true } });
    named.markOtherFlag = add("attendance.mark", { ...checkin, ...byJack, metadata: { classInstanceId: session, memberId: m.mel, acknowledged: ["rank_gate"] } });
    named.markEmptyFlags = add("attendance.mark", { ...checkin, ...byJack, metadata: { classInstanceId: session, memberId: m.mel, acknowledged: [] } });
    named.markNoMeta = add("attendance.mark", { ...checkin, ...byJack });
    named.tier = add("member.update", { ...byJack, metadata: { fields: ["membershipTierId"], changes: { membershipTierId: { from: tierOld, to: tierAdult } } } });
    named.cancel = add("member.update", { ...byJack, entityId: m.faisal, metadata: { changes: { status: { from: "active", to: "cancelled" }, membershipTierId: { from: tierAdult, to: null } } } });
    named.phone = add("member.update", { ...byJack, metadata: { fields: ["phone"], changes: { phone: { from: "07700 900111", to: "07700 900222" } } } });
    named.statusOther = add("member.update", { ...byJack, metadata: { changes: { status: { from: "taster", to: "active" } } } });
    named.statusNull = add("member.update", { ...byJack, metadata: { changes: { status: { from: "active", to: null } } } });
    named.editNoMeta = add("member.update", { ...byJack });
    named.paid = add("member.payment.succeeded", { metadata: { stripeInvoiceId: invoice, amountPence: 4500, currency: "gbp" } });
    named.refund = add("payment.refund", { entityType: "Payment", entityId: payment, ...byOwner, metadata: { amountPence: 500, fullyRefunded: false } });
    named.chargeOk = add("payment.adhoc.charge", { ...byJack, metadata: { amountPence: 1500, description: "Private lesson", outcome: "succeeded" } });
    named.chargeDeclined = add("payment.adhoc.charge", { ...byJack, metadata: { amountPence: 1500, description: "Private lesson", outcome: "declined" } });
    named.chargeUnknown = add("payment.adhoc.charge", { ...byJack, metadata: { amountPence: 1500, description: "Private lesson", outcome: "unknown" } });
    named.chargeOld = add("payment.adhoc.charge", { ...byJack, metadata: { amountPence: 1500, description: "Private lesson" } });
    named.chargeNullOutcome = add("payment.adhoc.charge", { ...byJack, metadata: { amountPence: 1500, outcome: null } });
    named.orderPaid = add("order.mark_paid", { entityType: "Order", entityId: id("order"), ...byOwner, metadata: { reason: "Paid at the desk", previousStatus: "pending" } });
    named.goneEdit = add("member.update", { ...byJack, entityId: m.gone, metadata: { changes: { phone: { from: "07700 900333", to: "07700 900444" } } } });
    named.goneDelete = add("member.delete", { ...byOwner, entityId: m.gone, metadata: { name: "Jane Smith", kidsAffected: 0 } });
    named.erasedEdit = add("member.update", { ...byJack, entityId: m.erased, metadata: { changes: { phone: { from: "07700 900555", to: "07700 900666" }, name: { from: "Erin Before", to: "Erin Erased" } } } });
    named.pause = add("class.updated", { entityType: "Class", entityId: cls, ...byOwner, metadata: { fields: ["isActive"], lifecycle: "paused" } });
    named.roster = add("class.roster.add", { entityType: "ClassRoster", entityId: id("roster"), ...byJack, metadata: { classId: cls, memberId: m.mel } });
    named.dispute = add("stripe.dispute.needs_response", { entityType: "Payment", entityId: payment, metadata: {} });
    // Shapes no writer produces today. Each must still be found by exactly one type, and must not break a sentence.
    named.ackString = add("attendance.mark", { ...checkin, ...byJack, metadata: { classInstanceId: session, memberId: m.mel, acknowledged: "on_hold" } });
    named.ackObject = add("attendance.mark", { ...checkin, ...byJack, metadata: { classInstanceId: session, memberId: m.mel, acknowledged: { on_hold: true } } });
    named.ackNull = add("attendance.mark", { ...checkin, ...byJack, metadata: { classInstanceId: session, memberId: m.mel, acknowledged: null } });
    named.changesScalar = add("member.update", { ...byJack, metadata: { changes: "phone" } });
    named.statusScalar = add("member.update", { ...byJack, metadata: { changes: { status: "cancelled" } } });
    named.statusNumber = add("member.update", { ...byJack, metadata: { changes: { status: { to: 7 } } } });
    named.tierNull = add("member.update", { ...byJack, metadata: { changes: { membershipTierId: null } } });
    named.metaArray = add("member.update", { ...byJack, metadata: [1, 2] });
    named.outcomeNumber = add("payment.adhoc.charge", { ...byJack, metadata: { amountPence: 1500, outcome: 0 } });
    named.outcomeObject = add("payment.adhoc.charge", { ...byJack, metadata: { amountPence: 1500, outcome: { code: "declined" } } });
    named.actingAsNull = add("member.update", { ...byJack, metadata: { actingAs: null, changes: { phone: { from: "1", to: "2" } } } });
    named.actingAsNumber = add("member.update", { ...byJack, metadata: { actingAs: 7 } });
    // Owner-only types.
    named.undo = add("undo.member.update", { ...byOwner, metadata: { undoneAuditId: id("nothing") } });
    named.staff = add("staff.update", { entityType: "User", entityId: JACK, ...byOwner, metadata: { changes: { role: { from: "admin", to: "coach" } } } });
    named.signIn = add("auth.logout_all", { entityType: "User", entityId: OWNER, ...byOwner });
    named.settings = add("tenant.settings.update", { entityType: "Tenant", entityId: A, ...byOwner, metadata: { fields: ["name"] } });
    named.dsar = add("member.dsar_export", { ...byOwner });
    named.imported = add("import.commit", { entityType: "ImportJob", entityId: id("job"), ...byOwner, metadata: { fileName: "members.csv", created: 3 } });
    named.plan = add("membership.tier.update", { entityType: "MembershipTier", entityId: tierAdult, ...byOwner, metadata: { before: { pricePence: 4000 }, after: { pricePence: 4500 } } });
    named.operatorRow = add("admin.tenant.review_locked", { entityType: "Tenant", entityId: A, operatorId: OPERATOR });
    named.unmapped = add(`mfv.unmapped_${STAMP}`, { entityType: "Widget", entityId: id("widget") });
    // Ordinary actions made during a MatFlow support session.
    named.supportByColumn = add("member.update", { ...byOwner, operatorId: OPERATOR, metadata: { changes: { name: { from: "A", to: "B" } } } });
    named.supportByMeta = add("member.update", { ...byOwner, metadata: { actingAs: OPERATOR, changes: { name: { from: "B", to: "C" } } } });
    // A row of club A whose metadata points at club B's records.
    named.pointsAtB = add("attendance.self_checkin", { ...checkin, metadata: { classInstanceId: sessionB, memberId: m.other, paymentId: paymentB, actorId: m.other } });
    // Club B's own rows.
    add("member.update", { entityId: m.other, metadata: { changes: { name: { from: "X", to: "Other Club Person" } } } }, B);
    for (let i = 0; i < 120; i++) rows.push({ id: id(`tie${String(i).padStart(3, "0")}`), tenantId: B, action: "attendance.self_checkin", entityType: "AttendanceRecord", entityId: id("recB"), metadata: { memberId: m.other, actorId: m.other }, createdAt: new Date(BASE - 3 * 24 * 3_600_000), userId: null, operatorId: null });

    for (let i = 0; i < rows.length; i += 60) {
      const chunk = rows.slice(i, i + 60).map((r) => ({ ...r, metadata: r.metadata === null ? undefined : (r.metadata as object) }));
      await withRlsBypass((tx) => tx.auditLog.createMany({ data: chunk }));
    }
    // Erase one member the way the erase route leaves them; delete nobody else (m.gone never had a row).
    await withRlsBypass((tx) => tx.member.update({ where: { id: m.erased }, data: { name: "Deleted member", email: `deleted-${m.erased}@deleted.invalid`, phone: null } }));
  }, 180_000);

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      const tenants = [A, B];
      await tx.auditLog.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.payment.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.classInstance.deleteMany({ where: { class: { tenantId: { in: tenants } } } });
      await tx.class.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.member.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.membershipTier.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.user.deleteMany({ where: { tenantId: { in: tenants } } });
      await tx.operator.deleteMany({ where: { id: OPERATOR } });
      await tx.tenant.deleteMany({ where: { id: { in: tenants } } });
    });
    const left = await withRlsBypass(async (tx) => (await tx.tenant.count({ where: { id: { in: [A, B] } } })) + (await tx.auditLog.count({ where: { tenantId: { in: [A, B] } } })));
    expect(left).toBe(0);
  }, 120_000);

  it("every row is found by the type it shows (and the one declared overlap) — and the SQL model used by the unit tests agrees with Postgres", async () => {
    const foundBy = new Map<string, string[]>(inA().map((r) => [r.id, []]));
    const disagreements: string[] = [];
    for (const key of ALL_KEYS) {
      const where = whereForTypes([key], "owner");
      const found = new Set((await withTenantContext(A, (tx) => tx.auditLog.findMany({ where: { AND: [{ tenantId: A }, where] }, select: { id: true } }))).map((r) => r.id));
      for (const row of inA()) {
        if (found.has(row.id)) foundBy.get(row.id)!.push(key);
        if (selects(where, row) !== found.has(row.id)) disagreements.push(`${key}: ${row.action} ${JSON.stringify(row.metadata)} — model ${selects(where, row)}, Postgres ${found.has(row.id)}`);
      }
    }
    expect(disagreements).toEqual([]);
    const wrong = inA().filter((r) => [...foundBy.get(r.id)!].sort().join() !== [...typesFinding(r)].sort().join()).map((r) => `${r.action} ${JSON.stringify(r.metadata)}: shows ${typeOf(r)}, found by [${foundBy.get(r.id)}]`);
    expect(wrong).toEqual([]);
    // No row is found by no filter at all.
    expect(inA().filter((r) => foundBy.get(r.id)!.length === 0).map((r) => r.action)).toEqual([]);
    // The cases the NULL-safe predicates exist for.
    expect(foundBy.get(named.phone.id)).toEqual(["member_updated"]);
    expect(foundBy.get(named.editNoMeta.id)).toEqual(["member_updated"]);
    expect(foundBy.get(named.statusNull.id)).toEqual(["member_updated"]);
    expect(foundBy.get(named.markPlain.id)).toEqual(["checkin"]);
    expect(foundBy.get(named.markNoMeta.id)).toEqual(["checkin"]);
    expect(foundBy.get(named.markEmptyFlags.id)).toEqual(["checkin"]);
    // A warned check-in shows as that, and is still a check-in.
    expect(foundBy.get(named.markWarned.id)).toEqual(["checkin_exception", "checkin"]);
    expect(foundBy.get(named.cancel.id)).toEqual(["cancellation"]);
    expect(foundBy.get(named.tier.id)).toEqual(["membership_changed"]);
    expect(foundBy.get(named.chargeOld.id)).toEqual(["payment"]);
    expect(foundBy.get(named.chargeNullOutcome.id)).toEqual(["payment"]);
    expect(foundBy.get(named.chargeDeclined.id)).toEqual(["payment_failed"]);
    expect(foundBy.get(named.chargeUnknown.id)).toEqual(["payment_failed"]);
    expect(foundBy.get(named.dispute.id)).toEqual(["payment_failed"]);
    expect(foundBy.get(named.unmapped.id)).toEqual(["other"]);
    // Odd shapes land where the in-memory rules put them.
    expect(foundBy.get(named.ackString.id)).toEqual(["checkin"]);
    expect(foundBy.get(named.ackObject.id)).toEqual(["checkin"]);
    expect(foundBy.get(named.ackNull.id)).toEqual(["checkin"]);
    expect(foundBy.get(named.changesScalar.id)).toEqual(["member_updated"]);
    expect(foundBy.get(named.statusScalar.id)).toEqual(["member_updated"]);
    expect(foundBy.get(named.statusNumber.id)).toEqual(["member_updated"]);
    expect(foundBy.get(named.tierNull.id)).toEqual(["member_updated"]);
    expect(foundBy.get(named.metaArray.id)).toEqual(["member_updated"]);
    expect(foundBy.get(named.outcomeNumber.id)).toEqual(["payment_failed"]);
    expect(foundBy.get(named.outcomeObject.id)).toEqual(["payment_failed"]);
  }, 240_000);

  it("the manager restriction selects club-life rows only, and never one made by or through MatFlow support", async () => {
    const where = visibleWhere("manager");
    const found = new Set((await withTenantContext(A, (tx) => tx.auditLog.findMany({ where: { AND: [{ tenantId: A }, where] }, select: { id: true } }))).map((r) => r.id));
    const managerTypes = new Set(visibleTypeKeys("manager"));
    for (const row of inA()) {
      // Any marker at all counts (fails closed); a JSON null is no marker.
      const support = row.operatorId != null || (row.metadata as { actingAs?: unknown } | null)?.actingAs != null;
      expect(found.has(row.id), `${row.action} ${JSON.stringify(row.metadata)}`).toBe(managerTypes.has(typeOf(row)) && !support);
      expect(selects(where, row), `model: ${row.action}`).toBe(found.has(row.id));
    }
    for (const row of [named.supportByColumn, named.supportByMeta, named.operatorRow, named.unmapped, named.undo, named.staff, named.signIn, named.settings, named.dsar, named.imported, named.plan]) expect(found.has(row.id), row.action).toBe(false);
    // A row with no metadata, or a null marker, is not a support session; an odd marker is treated as one.
    expect(found.has(named.editNoMeta.id)).toBe(true);
    expect(found.has(named.actingAsNull.id)).toBe(true);
    expect(found.has(named.actingAsNumber.id)).toBe(false);
  }, 120_000);

  it("the owner's feed is every row of this club and none of another's, as sentences with links", async () => {
    as("owner");
    const entries = await all("?types=all");
    expect(entries.map((e) => e.id).sort()).toEqual(inA().map((r) => r.id).sort());
    const plain = (row: Row) => entries.find((e) => e.id === row.id)!;
    expect(plain(named.self).plain).toBe("Melody Orekoya checked in to Advanced No-Gi · Wed 4 Nov, 19:00");
    expect(plain(named.parent).plain).toBe("Faisal Alshukri checked Zara Alshukri in to Advanced No-Gi · Wed 4 Nov, 19:00");
    expect(plain(named.scan).plain).toBe("Jack Streeter scanned 3 members in to Advanced No-Gi · Wed 4 Nov, 19:00");
    expect(plain(named.scan).detailPlain).toBe("Ada Obi, Faisal Alshukri, Melody Orekoya");
    expect(plain(named.tier).plain).toBe("Jack Streeter moved Melody Orekoya from Twice a week (OLD) to Adult Unlimited");
    expect(plain(named.cancel).plain).toBe("Jack Streeter cancelled Faisal Alshukri's membership");
    expect(plain(named.paid).plain).toBe("Melody Orekoya paid £45.00");
    expect(plain(named.paid).source.label).toBe("Stripe");
    expect(plain(named.refund).plain).toBe("Olive Owner refunded £5.00 to Melody Orekoya");
    expect(plain(named.chargeDeclined).plain).toBe("Jack Streeter's £15.00 charge to Melody Orekoya's card was declined");
    expect(plain(named.pause).plain).toBe("Olive Owner paused Advanced No-Gi");
    expect(plain(named.orderPaid).plain).toBe("Olive Owner marked a shop order as paid");
    expect(plain(named.supportByColumn).source).toMatchObject({ label: "MatFlow support", support: true });
    expect(plain(named.supportByMeta).source).toMatchObject({ label: "MatFlow support", support: true });
    // A deleted member keeps the name recorded on their deletion; old values are shown to nobody.
    expect(plain(named.goneEdit).plain).toBe("Jack Streeter updated Jane Smith (deleted)'s details");
    expect(plain(named.goneEdit).detailPlain).toBe("Fields: Phone");
    expect(plain(named.goneDelete).plain).toBe("Olive Owner deleted Jane Smith");
    const hrefs = plain(named.paid).parts.flatMap((p) => ("subject" in p && p.subject.href ? [p.subject.href] : []));
    expect(hrefs).toEqual([`/dashboard/members/${m.mel}`, `/dashboard/members/${m.mel}?tab=payments&paymentId=${payment}`]);
  }, 240_000);

  it("a manager is sent no owner-only row, whatever is asked for", async () => {
    as("manager");
    const forbidden = new Set([named.undo, named.staff, named.signIn, named.settings, named.dsar, named.imported, named.plan, named.operatorRow, named.unmapped, named.supportByColumn, named.supportByMeta, named.actingAsNumber].map((r) => r.id));
    const queries = ["?types=all", `?types=${ALL_KEYS.join(",")}`, "?types=staff,support,undo,other,settings", "?types=staff_changes", `?types=all&userId=${OWNER}`, `?types=all&memberId=${m.mel}`, `?types=all&tierId=${tierAdult}`, `?types=all&paymentId=${payment}`, `?types=all&classId=${cls}`, "?types=all&embed=1", `?types=all&day=${ROW_DAY}`, `?types=all&cursor=${named.staff.id}`, `?types=all&cursor=${named.undo.id}&userId=${OWNER}`];
    for (const query of queries) {
      const entries = await all(query);
      for (const e of entries) expect(forbidden.has(e.id), `${query}: ${e.plain}`).toBe(false);
      expect(JSON.stringify(entries), query).not.toContain('"undo"');
    }
    const everything = await all("?types=all");
    const expected = inA().filter((r) => visibleTypeKeys("manager").includes(typeOf(r)) && !forbidden.has(r.id));
    expect(everything.map((e) => e.id).sort()).toEqual(expected.map((r) => r.id).sort());
    // Which fields changed, never what they held; a plan is named but not linked.
    const edit = everything.find((e) => e.id === named.phone.id)!;
    expect(edit.detailPlain).toBe("Fields: Phone");
    expect(JSON.stringify(everything)).not.toContain("07700");
    const tierParts = everything.find((e) => e.id === named.tier.id)!.parts;
    expect(tierParts.some((p) => "subject" in p && p.subject.name === "Adult Unlimited" && p.subject.href === null)).toBe(true);
  }, 240_000);

  it("the member filter finds rows on their record, rows that name them, a card-scan batch, a parent acting for a child, and their payments", async () => {
    as("owner");
    const mine = (await all(`?types=all&memberId=${m.mel}`)).map((e) => e.id);
    for (const row of [named.self, named.scan, named.markWarned, named.markPlain, named.tier, named.phone, named.paid, named.refund, named.chargeDeclined, named.roster, named.dispute, named.supportByColumn]) expect(mine, row.action).toContain(row.id);
    for (const row of [named.parent, named.kiosk, named.cancel, named.pause, named.settings, named.goneEdit, named.pointsAtB]) expect(mine, row.action).not.toContain(row.id);
    const scan = (await get(`?types=checkin&memberId=${m.mel}`)).entries.find((e) => e.id === named.scan.id)!;
    expect(scan.plain).toBe("Melody Orekoya was scanned in to Advanced No-Gi · Wed 4 Nov, 19:00");
    // The parent sees the check-in they made for their child; so does the child.
    expect((await all(`?types=all&memberId=${m.faisal}`)).map((e) => e.id)).toEqual(expect.arrayContaining([named.parent.id, named.scan.id, named.cancel.id]));
    expect((await all(`?types=all&memberId=${m.kid}`)).map((e) => e.id)).toEqual([named.parent.id]);
  }, 240_000);

  it("class, plan, payment and staff filters; and filters combine with AND", async () => {
    as("owner");
    expect((await all(`?types=all&classId=${cls}`)).map((e) => e.id).sort()).toEqual([named.pause.id, named.roster.id].sort());
    expect((await all(`?types=all&tierId=${tierAdult}`)).map((e) => e.id).sort()).toEqual([named.tier.id, named.cancel.id, named.plan.id].sort());
    expect((await all(`?types=all&tierId=${tierOld}`)).map((e) => e.id)).toEqual([named.tier.id]);
    expect((await all(`?types=all&paymentId=${payment}`)).map((e) => e.id).sort()).toEqual([named.paid.id, named.refund.id, named.dispute.id].sort());
    const byJack = await all(`?types=all&userId=${JACK}`);
    expect(byJack.map((e) => e.id).sort()).toEqual(inA().filter((r) => r.userId === JACK).map((r) => r.id).sort());
    const combined = await all(`?types=checkin,checkin_exception,member_updated&memberId=${m.mel}&userId=${JACK}`);
    const expected = inA().filter((r) => r.userId === JACK && ["checkin", "checkin_exception", "member_updated"].includes(typeOf(r)) && (r.entityId === m.mel || JSON.stringify(r.metadata ?? {}).includes(m.mel)));
    expect(combined.map((e) => e.id).sort()).toEqual(expected.map((r) => r.id).sort());
    expect(combined.length).toBeGreaterThan(5);
    // …and with a day as well: the same rows on the day they were written, none the day before.
    const query = `?types=checkin,checkin_exception,member_updated&memberId=${m.mel}&userId=${JACK}`;
    expect((await all(`${query}&day=${ROW_DAY}`)).map((e) => e.id).sort()).toEqual(expected.map((r) => r.id).sort());
    expect(await all(`${query}&day=${DAY_BEFORE}`)).toEqual([]);
  }, 240_000);

  it("120 rows written in the same instant page at 50 to exactly 120 different rows", async () => {
    as("owner", B);
    const entries = await all("?types=checkin");
    expect(entries).toHaveLength(120);
    expect(new Set(entries.map((e) => e.id)).size).toBe(120);
  }, 240_000);

  it("a cursor that is another club's row, or no row at all, gives the same empty page", async () => {
    as("owner");
    const theirs = rows.find((r) => r.tenantId === B)!.id;
    const fromTheirs = await get(`?types=all&cursor=${theirs}`);
    const fromNothing = await get(`?types=all&cursor=${id("nocursor")}`);
    expect(fromTheirs.entries).toEqual([]);
    expect(fromTheirs.nextCursor).toBeNull();
    expect(JSON.stringify(fromTheirs)).toBe(JSON.stringify(fromNothing));
    // …and a cursor of this club continues from it, newest first, without repeats.
    const first = await get("?types=all&take=10");
    const second = await get(`?types=all&take=10&cursor=${first.nextCursor}`);
    expect(second.entries).toHaveLength(10);
    expect(second.entries.some((e) => first.entries.some((f) => f.id === e.id))).toBe(false);
    expect(inA().map((r) => r.id).slice(10, 20)).toEqual(second.entries.map((e) => e.id));
  }, 120_000);

  it("a row that points at another club's records names nothing of theirs", async () => {
    as("owner");
    const body = await get("?types=all");
    const entry = (await all("?types=all")).find((e) => e.id === named.pointsAtB.id)!;
    expect(entry.plain).toBe("A deleted member checked in to a deleted session");
    expect(entry.parts.every((p) => !("subject" in p) || p.subject.href === null)).toBe(true);
    const text = JSON.stringify(await all("?types=all")) + JSON.stringify(body);
    for (const leak of ["Other Club", m.other, sessionB, paymentB, "999.00"]) expect(text, leak).not.toContain(leak);
  }, 240_000);

  it("an erased member's old values are in nobody's response", async () => {
    for (const role of ["owner", "manager"] as const) {
      as(role);
      const text = JSON.stringify(await all("?types=all"));
      for (const secret of ["07700 900555", "07700 900666", "Erin Before", "Erin Erased", "erase-me", "deleted.invalid"]) expect(text, `${role}: ${secret}`).not.toContain(secret);
      const entry = (await all("?types=all")).find((e) => e.id === named.erasedEdit.id)!;
      expect(entry.plain).toBe("Jack Streeter updated Deleted member's details");
      // jsonb keeps its own key order, so the fields come back sorted, not as written.
      expect([...(entry.changes ?? [])].sort((x, y) => x.label.localeCompare(y.label))).toEqual([{ label: "Name", from: null, to: null }, { label: "Phone", from: null, to: null }]);
    }
    as("owner");
    expect((await get(`?memberId=${m.erased}`)).filters.member).toEqual({ id: m.erased, name: "Deleted member" });
  }, 240_000);

  it("another club's id and an id that never existed get the same answer", async () => {
    as("owner");
    for (const [param, foreign] of [["memberId", m.other], ["tierId", id("tierB")], ["paymentId", paymentB], ["classId", id("classB")]] as const) {
      const theirs = await get(`?types=all&${param}=${foreign}`);
      const nobody = await get(`?types=all&${param}=${id("nobody")}`);
      expect(theirs.entries).toEqual([]);
      const strip = (b: ActivityResponse) => JSON.stringify(b).replaceAll(foreign, "ID").replaceAll(id("nobody"), "ID");
      expect(strip(theirs), param).toBe(strip(nobody));
    }
  }, 120_000);

  it("a day bounds the feed on the club's clock", async () => {
    as("owner");
    const before = await get(`?types=all&day=${DAY_BEFORE}`);
    expect(before.filters.dayKey).toBe(DAY_BEFORE);
    expect(before.entries).toEqual([]);
    const onTheDay = await get(`?types=all&day=${ROW_DAY}&take=5`);
    expect(onTheDay.entries).toHaveLength(5);
    expect(onTheDay.entries[0].id).toBe(named.self.id);
    expect(onTheDay.entries.every((e) => e.dayKey === ROW_DAY)).toBe(true);
    expect(onTheDay.nextCursor).toBe(onTheDay.entries[4].id);
  }, 120_000);
});
