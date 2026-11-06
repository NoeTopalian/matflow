// GET /api/activity against an in-memory club: who may call it, what each
// parameter does, what a manager can never be sent, what the response may
// never contain, and how it behaves when the database is slow or failing.
// The audit rows are filtered by tests/unit/activity-where-eval.ts, a model
// of the SQL; the real database is exercised in tests/integration.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { selects, type EvalRow } from "./activity-where-eval";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({ status: init?.status ?? 200, headers: new Headers(init?.headers), json: async () => body }),
  },
}));

const h = vi.hoisted(() => ({
  gate: vi.fn(),
  rate: vi.fn(),
  decideUndo: vi.fn(),
  tx: null as unknown,
  transactions: [] as { options: unknown; statements: string[] }[],
  failTransaction: null as null | ((n: number) => unknown),
}));

vi.mock("@/lib/api-authz", () => ({ requireApiOwnerOrManager: () => h.gate() }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: (...args: unknown[]) => h.rate(...args) }));
vi.mock("@/lib/undo-registry", () => ({ decideUndo: (...args: unknown[]) => h.decideUndo(...args) }));
vi.mock("@/lib/prisma-tenant", async (original) => {
  const actual = await original<typeof import("@/lib/prisma-tenant")>();
  return {
    TenantTransactionBudgetError: actual.TenantTransactionBudgetError,
    withTenantContext: async (_tenantId: string, fn: (tx: unknown) => Promise<unknown>, options?: unknown) => {
      h.transactions.push({ options, statements: [] });
      const failure = h.failTransaction?.(h.transactions.length);
      if (failure) throw failure;
      return fn(h.tx);
    },
  };
});

import { GET } from "@/app/api/activity/route";
import { TenantTransactionBudgetError } from "@/lib/prisma-tenant";
import { ACTIVITY_TYPES, defaultTypeKeys, visibleTypeKeys, type ActivityResponse } from "@/lib/activity-types";

// ── The club ─────────────────────────────────────────────────────────────────

const CLUB = "club_a";
const OWNER = { id: "u_owner", name: "Sean Coates" };
const JACK = { id: "u_jack", name: "Jack Streeter" };

type Audit = EvalRow & { id: string; tenantId: string; entityType: string; entityId: string; createdAt: Date; userId: string | null; operatorId: string | null };
type Rec = Record<string, unknown> & { id: string };

let audit: Audit[] = [];
let seq = 0;
const at = (iso: string) => new Date(iso);
function log(action: string, over: Partial<Audit> = {}): Audit {
  const row: Audit = { id: `a${String(++seq).padStart(4, "0")}`, tenantId: CLUB, action, entityType: "Member", entityId: "m_mel", metadata: null, createdAt: at("2026-11-05T10:00:00Z"), userId: null, operatorId: null, ...over };
  audit.push(row);
  return row;
}

const records: Record<string, Rec[]> = {
  tenant: [{ id: CLUB, timezone: "Europe/London", currency: "GBP", createdAt: at("2024-06-01T09:00:00Z") }],
  member: [
    { id: "m_mel", tenantId: CLUB, name: "Melody Orekoya", email: "melody@example.test" },
    { id: "m_a", tenantId: CLUB, name: "Ada Obi", email: "ada@example.test" },
    { id: "m_other", tenantId: "club_b", name: "Other Club Person", email: "other@example.test" },
  ],
  user: [
    { id: OWNER.id, tenantId: CLUB, name: OWNER.name },
    { id: JACK.id, tenantId: CLUB, name: JACK.name },
  ],
  class: [{ id: "c_nogi", tenantId: CLUB, name: "Advanced No-Gi" }],
  classInstance: [{ id: "s_wed", date: at("2026-11-04T00:00:00Z"), startTime: "19:00", class: { id: "c_nogi", name: "Advanced No-Gi", tenantId: CLUB } }],
  payment: [{ id: "p1", tenantId: CLUB, memberId: "m_mel", amountPence: 4500, currency: "GBP", stripeInvoiceId: "in_1", paidAt: at("2026-11-03T09:00:00Z"), createdAt: at("2026-11-03T09:00:00Z") }],
  membershipTier: [{ id: "t_adult", tenantId: CLUB, name: "Adult Unlimited" }],
  order: [],
  classPack: [],
  location: [],
  rankSystem: [],
};

function matches(where: Record<string, unknown>, r: Rec): boolean {
  const one = (cond: unknown, value: unknown) => (cond && typeof cond === "object" && "in" in cond ? (cond.in as unknown[]).includes(value) : cond === value);
  return Object.entries(where).every(([key, cond]) => {
    if (key === "OR") return (cond as Record<string, unknown>[]).some((o) => matches(o, r));
    if (key === "class") return matches(cond as Record<string, unknown>, r.class as Rec);
    return one(cond, r[key]);
  });
}

function makeTx() {
  const note = (name: string) => h.transactions[h.transactions.length - 1]?.statements.push(name);
  const model = (name: string) => ({
    findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (note(name), records[name].find((r) => matches(where, r)) ?? null)),
    findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (note(name), records[name].find((r) => matches(where, r)) ?? null)),
    findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => (note(name), records[name].filter((r) => matches(where, r)))),
  });
  const auditLog = {
    findFirst: vi.fn(async (args: { where: unknown }) => (note("auditLog.cursor"), audit.find((r) => selects(args.where, r)) ?? null)),
    findMany: vi.fn(async (args: { where: unknown; orderBy?: unknown; take?: number; cursor?: unknown }) => {
      note("auditLog");
      // The route pages by an explicit comparison; Prisma's own cursor (whose lookup is not club-scoped) must not come back.
      if (args.cursor) throw new Error("the route must not use Prisma's cursor");
      const rows = audit.filter((r) => selects(args.where, r)).sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime() || (x.id < y.id ? 1 : -1));
      const staff = records.user;
      return rows.slice(0, args.take ?? rows.length).map((r) => ({ ...r, user: r.userId ? (staff.find((u) => u.id === r.userId) ?? null) : null }));
    }),
  };
  return { tenant: model("tenant"), member: model("member"), user: model("user"), class: model("class"), classInstance: model("classInstance"), payment: model("payment"), membershipTier: model("membershipTier"), order: model("order"), classPack: model("classPack"), location: model("location"), rankSystem: model("rankSystem"), auditLog };
}

let tx: ReturnType<typeof makeTx>;
const asOwner = () => h.gate.mockResolvedValue({ ok: true, tenantId: CLUB, userId: OWNER.id, role: "owner", session: {} });
const asManager = () => h.gate.mockResolvedValue({ ok: true, tenantId: CLUB, userId: "u_manager", role: "manager", session: {} });

async function get(query = "") {
  const res = await GET(new Request(`http://localhost/api/activity${query}`));
  return { res, body: (await res.json()) as ActivityResponse & { ok?: boolean; code?: string; error?: string } };
}

/** A year of the kinds of row that matter, including one of every owner-only type. */
function seed() {
  log("attendance.self_checkin", { entityType: "AttendanceRecord", entityId: "rec1", metadata: { classInstanceId: "s_wed", memberId: "m_mel", actorId: "m_mel" }, createdAt: at("2026-11-05T09:00:00Z") });
  log("member.update", { userId: JACK.id, metadata: { changes: { phone: { from: "07700 900111", to: "07700 900222" } } }, createdAt: at("2026-11-05T08:00:00Z") });
  log("member.payment.succeeded", { metadata: { stripeInvoiceId: "in_1", amountPence: 4500, currency: "gbp" }, createdAt: at("2026-11-04T12:00:00Z") });
  log("attendance.card_scan", { entityType: "ClassInstance", entityId: "s_wed", userId: JACK.id, metadata: { classInstanceId: "s_wed", memberIds: ["m_a", "m_mel"] }, createdAt: at("2026-11-04T19:05:00Z") });
  log("payment.refund", { entityType: "Payment", entityId: "p1", userId: OWNER.id, metadata: { amountPence: 500, fullyRefunded: false }, createdAt: at("2026-11-04T13:00:00Z") });
  // Owner-only.
  log("staff.update", { entityType: "User", entityId: JACK.id, userId: OWNER.id, metadata: { changes: { role: { from: "coach", to: "manager" } } }, createdAt: at("2026-11-03T10:00:00Z") });
  log("auth.logout_all", { entityType: "User", entityId: OWNER.id, userId: OWNER.id, createdAt: at("2026-11-03T09:00:00Z") });
  log("tenant.settings.update", { entityType: "Tenant", entityId: CLUB, userId: OWNER.id, metadata: { fields: ["name"] }, createdAt: at("2026-11-03T08:00:00Z") });
  log("member.dsar_export", { userId: OWNER.id, createdAt: at("2026-11-03T07:00:00Z") });
  log("admin.impersonate.edit_start", { entityType: "Tenant", entityId: CLUB, operatorId: "op_1", createdAt: at("2026-11-02T10:00:00Z") });
  log("undo.member.update", { userId: OWNER.id, metadata: { undoneAuditId: "a_zzz" }, createdAt: at("2026-11-02T09:00:00Z") });
  log("import.commit", { entityType: "ImportJob", entityId: "job1", userId: OWNER.id, metadata: { fileName: "members.csv", created: 3 }, createdAt: at("2026-11-02T08:00:00Z") });
  log("membership.tier.update", { entityType: "MembershipTier", entityId: "t_adult", userId: OWNER.id, metadata: { before: { pricePence: 4000 }, after: { pricePence: 4500 } }, createdAt: at("2026-11-02T07:00:00Z") });
  log("brand.new_unmapped_action", { entityType: "Widget", entityId: "w1", createdAt: at("2026-11-02T06:00:00Z") });
  // An ordinary action, but made during a MatFlow support session.
  log("member.update", { userId: OWNER.id, operatorId: "op_1", metadata: { actingAs: "op_1", changes: { name: { from: "A", to: "B" } } }, createdAt: at("2026-11-01T10:00:00Z") });
  log("member.update", { userId: OWNER.id, metadata: { actingAs: "op_1", changes: { name: { from: "B", to: "C" } } }, createdAt: at("2026-11-01T09:00:00Z") });
  // Another club's row must never appear, whatever is asked.
  log("member.update", { tenantId: "club_b", entityId: "m_other", metadata: { changes: { name: { from: "X", to: "Other Club Secret" } } }, createdAt: at("2026-11-05T09:30:00Z") });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(at("2026-11-05T12:00:00Z"));
  audit = [];
  seq = 0;
  h.transactions.length = 0;
  h.failTransaction = null;
  tx = makeTx();
  h.tx = tx;
  h.gate.mockReset();
  h.rate.mockReset().mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  h.decideUndo.mockReset().mockImplementation((row: { action: string }, undone: boolean) => (undone ? { ok: false, reason: "Already undone." } : row.action === "member.update" ? { ok: true } : { ok: false, reason: "This is a record of something that happened, not a change." }));
  asOwner();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("who may call it", () => {
  it("returns the gate's refusal untouched and reads nothing (a coach gets 403)", async () => {
    const refusal = { status: 403, headers: new Headers(), json: async () => ({ error: "Forbidden" }) };
    h.gate.mockResolvedValue({ ok: false, response: refusal });
    const res = await GET(new Request("http://localhost/api/activity"));
    expect(res).toBe(refusal);
    expect(h.rate).not.toHaveBeenCalled();
    expect(h.transactions).toHaveLength(0);
  });

  it("limits each person to 120 requests a minute, and reads nothing once over", async () => {
    h.rate.mockResolvedValue({ allowed: false, retryAfterSeconds: 17 });
    const { res, body } = await get();
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("17");
    expect(body).toEqual({ ok: false, code: "rate_limited", error: "Too many requests. Try again in a moment." });
    expect(h.rate).toHaveBeenCalledWith(`activity:${CLUB}:${OWNER.id}`, 120, 60_000);
    expect(h.transactions).toHaveLength(0);
  });

  it("is never cached", async () => {
    seed();
    expect((await get()).res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("the owner's feed", () => {
  beforeEach(seed);

  it("is this club's rows, newest first, as sentences", async () => {
    const { res, body } = await get("?types=all");
    expect(res.status).toBe(200);
    expect(body.enriched).toBe(true);
    expect(body.entries).toHaveLength(16);
    expect(body.entries[0].plain).toBe("Melody Orekoya checked in to Advanced No-Gi · Wed 4 Nov, 19:00");
    expect(body.entries[1].plain).toBe("Jack Streeter updated Melody Orekoya's details");
    expect(JSON.stringify(body)).not.toContain("Other Club");
    // The earliest day offered is the club's first day: activity is kept permanently (docs/RULES.md).
    expect(body.clock).toEqual({ timeZone: "Europe/London", todayKey: "2026-11-05", minDayKey: "2024-06-01" });
    expect(body.nextCursor).toBeNull();
  });

  it("orders by time then id, and asks for one row more than the page", async () => {
    await get("?take=10");
    const args = tx.auditLog.findMany.mock.calls[0][0] as { orderBy: unknown; take: number };
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(args.take).toBe(11);
  });

  it("offers Undo with 'since here' on a reversible row, and says why not on the rest", async () => {
    const { body } = await get("?types=all");
    const edit = body.entries.find((e) => e.plain === "Jack Streeter updated Melody Orekoya's details");
    expect(edit?.undo).toEqual({ ok: true, sinceHere: { userId: JACK.id, name: JACK.name } });
    expect(body.entries[0].undo).toEqual({ ok: false, reason: "This is a record of something that happened, not a change." });
    expect(body.entries.every((e) => e.undo !== undefined)).toBe(true);
  });

  it("marks a row that has already been undone", async () => {
    const original = audit.find((r) => r.action === "member.update" && r.userId === JACK.id)!;
    log("undo.member.update", { userId: OWNER.id, metadata: { undoneAuditId: original.id }, createdAt: at("2026-11-05T08:30:00Z") });
    const { body } = await get("?types=all");
    const edit = body.entries.find((e) => e.id === original.id);
    expect(edit).toMatchObject({ undone: true, undo: { ok: false, reason: "Already undone." } });
  });

  it("skips the undo lookup when nothing on the page could be undone", async () => {
    await get("?types=checkin");
    expect(tx.auditLog.findMany.mock.calls.filter(([a]) => JSON.stringify((a as { where: unknown }).where).includes("undo."))).toHaveLength(0);
    expect(h.transactions[0].statements).toEqual(["tenant", "auditLog"]);
  });

  it("an embedded timeline gets no undo decision and costs no undo lookup", async () => {
    const { body } = await get("?types=all&embed=1");
    expect(body.entries.every((e) => !("undo" in e))).toBe(true);
    expect(h.decideUndo).not.toHaveBeenCalled();
    expect(h.transactions[0].statements).toEqual(["tenant", "auditLog"]);
  });
});

describe("the manager's feed", () => {
  beforeEach(() => {
    seed();
    asManager();
  });

  const OWNER_ONLY_ACTIONS = ["staff.update", "auth.logout_all", "tenant.settings.update", "member.dsar_export", "admin.impersonate.edit_start", "undo.member.update", "import.commit", "membership.tier.update", "brand.new_unmapped_action"];

  it("is club life only, by any combination of parameters", async () => {
    const ownerOnlyIds = new Set(audit.filter((r) => OWNER_ONLY_ACTIONS.includes(r.action) || r.operatorId || (r.metadata as { actingAs?: string } | null)?.actingAs).map((r) => r.id));
    expect(ownerOnlyIds.size).toBe(11);
    const everyType = ACTIVITY_TYPES.map((t) => t.key).join(",");
    const someRow = audit[3].id;
    for (const query of ["", "?types=all", "?types=staff", `?types=${everyType}`, "?types=staff_changes", `?userId=${OWNER.id}`, `?types=all&userId=${OWNER.id}`, "?types=other,undo,support", "?types=all&memberId=m_mel", "?types=all&day=2026-11-03", `?types=all&cursor=${someRow}`, "?types=all&paymentId=p1", "?types=all&classId=c_nogi", "?types=all&embed=1", "?types=all&tierId=t_adult", `?types=${everyType}&embed=1&day=2026-11-02&userId=${OWNER.id}`]) {
      const { res, body } = await get(query);
      expect(res.status, query).toBe(200);
      for (const e of body.entries) expect(ownerOnlyIds.has(e.id), `${query}: ${e.plain}`).toBe(false);
    }
    const all = (await get("?types=all")).body;
    expect(all.entries.map((e) => e.type).sort()).toEqual(["checkin", "checkin", "member_updated", "payment", "refund"]);
  });

  it("says which requested types it left out", async () => {
    const { body } = await get("?types=checkin,staff,support");
    expect(body.droppedTypes).toEqual(["staff", "support"]);
    expect(body.filters.types).toEqual({ view: null, keys: ["checkin"] });
    const none = (await get("?types=staff")).body;
    expect(none.droppedTypes).toEqual(["staff"]);
    expect(none.filters.types).toEqual({ view: "club", keys: defaultTypeKeys("manager") });
  });

  it("has no undo anywhere, never asks whether a row could be undone, and shows no old values", async () => {
    const { body } = await get("?types=all");
    expect(JSON.stringify(body)).not.toContain('"undo"');
    expect(h.decideUndo).not.toHaveBeenCalled();
    expect(h.transactions[0].statements).toEqual(["tenant", "auditLog"]);
    expect(JSON.stringify(body)).not.toContain("07700");
    const edit = body.entries.find((e) => e.type === "member_updated");
    expect(edit?.detailPlain).toBe("Fields: Phone");
  });
});

describe("parameters never break the page", () => {
  beforeEach(seed);

  it("reads a view, a list, and a list with rubbish in it", async () => {
    expect((await get()).body.filters.types).toEqual({ view: "club", keys: defaultTypeKeys("owner") });
    expect((await get("?types=money")).body.filters.types.view).toBe("money");
    const mixed = (await get("?types=checkin,bogus")).body;
    expect(mixed.filters.types).toEqual({ view: null, keys: ["checkin"] });
    expect(mixed.ignoredTypes).toEqual(["bogus"]);
    expect(mixed.entries.map((e) => e.type)).toEqual(["checkin", "checkin"]);
    const rubbish = (await get("?types=bogus")).body;
    expect(rubbish.filters.types.view).toBe("club");
    expect(rubbish.ignoredTypes).toEqual(["bogus"]);
  });

  it("takes forty keys at most and reads nothing from an over-long value", async () => {
    const many = Array.from({ length: 45 }, (_, i) => `x${i}`).join(",");
    const { res, body } = await get(`?types=checkin,${many}`);
    expect(res.status).toBe(200);
    expect(body.filters.types.keys).toEqual(["checkin"]);
    const long = await get(`?types=${"checkin,".repeat(700)}`);
    expect(long.res.status).toBe(200);
    expect(long.body.filters.types).toEqual({ view: "club", keys: defaultTypeKeys("owner") });
  });

  it("an id that is not a record of this club returns nothing, without running the audit query", async () => {
    for (const query of ["?memberId=m_other", "?memberId=cmzzzzzzzzzzzzzzzzzzzzzzz", "?classId=c_missing", "?paymentId=p_missing", "?tierId=t_missing", "?userId=u_missing"]) {
      tx.auditLog.findMany.mockClear();
      const { res, body } = await get(query);
      expect(res.status, query).toBe(200);
      expect(body.entries, query).toEqual([]);
      expect(body.nextCursor).toBeNull();
      expect(tx.auditLog.findMany, query).not.toHaveBeenCalled();
    }
    expect((await get("?memberId=m_other")).body.filters.member).toEqual({ id: "m_other", name: null });
    // Another club's member and an id that never existed are indistinguishable — for the owner, for a manager, and for a staff id.
    for (const role of ["owner", "manager"] as const) {
      if (role === "manager") asManager();
      const foreign = (await get("?types=all&memberId=m_other")).body;
      const random = (await get("?types=all&memberId=m_nobody")).body;
      expect({ ...foreign, filters: { ...foreign.filters, member: null } }).toEqual({ ...random, filters: { ...random.filters, member: null } });
      const missingStaff = (await get("?types=all&userId=u_nobody")).body;
      const otherStaff = (await get("?types=all&userId=u_elsewhere")).body;
      expect({ ...missingStaff, filters: { ...missingStaff.filters, staff: null } }).toEqual({ ...otherStaff, filters: { ...otherStaff.filters, staff: null } });
    }
  });

  it("a malformed id is ignored, not treated as a filter", async () => {
    const { body } = await get("?types=all&memberId=not%20an%20id&classId=%27%20OR%201=1");
    expect(body.filters.member).toBeNull();
    expect(body.filters.class).toBeNull();
    expect(body.entries).toHaveLength(16);
  });

  it("filters by member: their record, their check-ins, a card-scan batch they were in, and their payments", async () => {
    const { body } = await get("?types=all&memberId=m_mel");
    expect(body.filters.member).toEqual({ id: "m_mel", name: "Melody Orekoya" });
    const plain = body.entries.map((e) => e.plain);
    expect(plain).toContain("Melody Orekoya was scanned in to Advanced No-Gi · Wed 4 Nov, 19:00");
    expect(plain).toContain("Sean Coates refunded £5.00 to Melody Orekoya");
    expect(plain).toContain("Melody Orekoya paid £45.00");
    expect(plain).not.toContain("Changed club settings");
    const ada = (await get("?types=all&memberId=m_a")).body;
    expect(ada.entries.map((e) => e.plain)).toEqual(["Ada Obi was scanned in to Advanced No-Gi · Wed 4 Nov, 19:00"]);
  });

  it("filters by class, payment, plan and staff member, and echoes each by name", async () => {
    expect((await get("?types=all&classId=c_nogi")).body.filters.class).toEqual({ id: "c_nogi", name: "Advanced No-Gi" });
    const trail = (await get("?types=all&paymentId=p1")).body;
    expect(trail.filters.payment).toEqual({ id: "p1", label: "£45.00 · 3 Nov 2026" });
    expect(trail.entries.map((e) => e.type).sort()).toEqual(["payment", "refund"]);
    const plan = (await get("?types=all&tierId=t_adult")).body;
    expect(plan.filters.tier).toEqual({ id: "t_adult", name: "Adult Unlimited" });
    expect(plan.entries.map((e) => e.type)).toEqual(["plan_setup"]);
    const byJack = (await get(`?types=all&userId=${JACK.id}`)).body;
    expect(byJack.filters.staff).toEqual({ id: JACK.id, name: JACK.name });
    expect(byJack.entries).toHaveLength(2);
  });

  it("filters combine with AND", async () => {
    const { body } = await get(`?types=checkin,member_updated&memberId=m_mel&userId=${JACK.id}&day=2026-11-04`);
    expect(body.entries.map((e) => e.plain)).toEqual(["Melody Orekoya was scanned in to Advanced No-Gi · Wed 4 Nov, 19:00"]);
  });

  it("a day is an upper bound on the club's clock; the feed continues backwards from it", async () => {
    const { body } = await get("?types=all&day=2026-11-03");
    expect(body.filters.dayKey).toBe("2026-11-03");
    expect(body.entries[0].dayKey).toBe("2026-11-03");
    expect(body.entries.every((e) => e.dayKey <= "2026-11-03")).toBe(true);
    expect(body.entries.length).toBeGreaterThan(4);
  });

  it("clamps a future day to today, keeps a day before the club began as asked (nothing is older), ignores a malformed one", async () => {
    expect((await get("?day=2027-01-01")).body.filters.dayKey).toBe("2026-11-05");
    const old = (await get("?types=all&day=2020-01-01")).body;
    expect(old.filters.dayKey).toBe("2020-01-01");
    expect(old.entries).toEqual([]);
    expect(old.clock).not.toHaveProperty("clamped");
    for (const bad of ["2026-02-30", "yesterday", "2026-11-5", ""]) expect((await get(`?day=${bad}`)).body.filters.dayKey, bad).toBeNull();
  });

  it("serves at most fifty rows a page", async () => {
    for (const [query, expected] of [["?take=5000", 51], ["?take=-3", 51], ["?take=abc", 51], ["?take=20", 21]] as const) {
      tx.auditLog.findMany.mockClear();
      await get(query);
      // The first audit read of a request is the page itself.
      expect((tx.auditLog.findMany.mock.calls[0][0] as { take: number }).take, query).toBe(expected);
    }
  });
});

describe("the cursor", () => {
  beforeEach(seed);

  it("continues from a row of this club", async () => {
    const first = (await get("?types=all&take=5")).body;
    expect(first.entries).toHaveLength(5);
    const second = (await get(`?types=all&take=5&cursor=${first.nextCursor}`)).body;
    expect(second.entries).toHaveLength(5);
    expect(second.entries.some((e) => first.entries.some((f) => f.id === e.id))).toBe(false);
    expect(second.entries[0].at <= first.entries[4].at).toBe(true);
    expect(h.transactions[h.transactions.length - 2].statements.slice(0, 3)).toEqual(["tenant", "auditLog.cursor", "auditLog"]);
  });

  it("another club's row id and an id that is no row at all both give an empty page, without reading the log", async () => {
    const theirs = audit.find((r) => r.tenantId === "club_b")!.id;
    const answers = [];
    for (const cursor of [theirs, "a9999", "not-a-row"]) {
      tx.auditLog.findMany.mockClear();
      const { res, body } = await get(`?types=all&cursor=${cursor}`);
      expect(res.status).toBe(200);
      expect(body.entries).toEqual([]);
      expect(body.nextCursor).toBeNull();
      expect(tx.auditLog.findMany).not.toHaveBeenCalled();
      answers.push(JSON.stringify(body));
    }
    expect(new Set(answers).size).toBe(1);
    // The lookup itself is scoped to the club.
    expect((tx.auditLog.findFirst.mock.calls[0][0] as { where: unknown }).where).toEqual({ id: theirs, tenantId: CLUB });
  });
});

describe("bounds on what one request can cost", () => {
  beforeEach(seed);

  it("never names a user of another club, whatever an old row points at", async () => {
    records.user.push({ id: "u_foreign", tenantId: "club_b", name: "Other Club Coach" });
    try {
      log("member.update", { userId: "u_foreign", metadata: { changes: { phone: { from: "1", to: "2" } } }, createdAt: at("2026-11-05T11:00:00Z") });
      const { body } = await get("?types=all");
      expect(body.entries[0].plain).toBe("A former staff member updated Melody Orekoya's details");
      expect(JSON.stringify(body)).not.toContain("Other Club Coach");
    } finally {
      records.user.pop();
    }
  });

  it("has no age floor: a row 400 days old is returned, and Jump to date accepts that day", async () => {
    // Activity is kept permanently (Noe, 6 Nov 2026). 400 days before 5 Nov 2026 is 1 Oct 2025.
    const old = log("member.update", { userId: JACK.id, metadata: { changes: { phone: { from: "1", to: "2" } } }, createdAt: at("2025-10-01T10:00:00Z") });
    const { body } = await get("?types=all");
    expect(body.entries).toHaveLength(17);
    expect(body.entries[16].id).toBe(old.id);
    expect(body.entries[16].dayKey).toBe("2025-10-01");
    // No createdAt floor is ANDed into the page query.
    expect(JSON.stringify((tx.auditLog.findMany.mock.calls[0][0] as { where: unknown }).where)).not.toContain("gte");

    const jumped = (await get("?types=all&day=2025-10-01")).body;
    expect(jumped.filters.dayKey).toBe("2025-10-01");
    expect(jumped.entries.map((e) => e.id)).toEqual([old.id]);
    expect(jumped.clock.minDayKey <= "2025-10-01").toBe(true);
  });

  it("caps the already-undone lookup", async () => {
    await get("?types=all");
    const undoLookup = tx.auditLog.findMany.mock.calls.map(([a]) => a as { where: unknown; take?: number }).find((a) => JSON.stringify(a.where).includes("undo."));
    expect(undoLookup?.take).toBe(1000);
  });
});

describe("paging", () => {
  it("120 rows written in the same instant page at 50 to exactly 120 different rows", async () => {
    for (let i = 0; i < 120; i++) log("attendance.self_checkin", { entityType: "AttendanceRecord", entityId: `rec${i}`, metadata: { classInstanceId: "s_wed", memberId: "m_mel", actorId: "m_mel" } });
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const { body } = await get(`?types=all${cursor ? `&cursor=${cursor}` : ""}`);
      seen.push(...body.entries.map((e) => e.id));
      cursor = body.nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(120);
    expect(new Set(seen).size).toBe(120);
  });

  it("a final page that is exactly full has no next cursor", async () => {
    for (let i = 0; i < 50; i++) log("attendance.self_checkin", { entityType: "AttendanceRecord", entityId: `rec${i}`, metadata: { classInstanceId: "s_wed", memberId: "m_mel", actorId: "m_mel" } });
    expect((await get("?types=all")).body.nextCursor).toBeNull();
    log("attendance.self_checkin", { entityType: "AttendanceRecord", entityId: "rec50", metadata: { classInstanceId: "s_wed", memberId: "m_mel", actorId: "m_mel" } });
    const { body } = await get("?types=all");
    expect(body.entries).toHaveLength(50);
    expect(body.nextCursor).toBe(body.entries[49].id);
  });

  it("a page of fifty check-ins costs two name lookups, in a transaction of their own with a five-second budget", async () => {
    for (let i = 0; i < 50; i++) log("attendance.self_checkin", { entityType: "AttendanceRecord", entityId: `rec${i}`, metadata: { classInstanceId: "s_wed", memberId: "m_mel", actorId: "m_mel" } });
    await get("?types=all");
    expect(h.transactions).toHaveLength(2);
    expect(h.transactions[0].statements).toEqual(["tenant", "auditLog"]);
    expect(h.transactions[1].statements).toEqual(["classInstance", "member"]);
    expect(h.transactions[1].options).toEqual({ timeout: 5_000 });
  });

  it("an empty page makes no name lookup at all", async () => {
    const { body } = await get("?types=all");
    expect(body.entries).toEqual([]);
    expect(body.enriched).toBe(true);
    expect(h.transactions).toHaveLength(1);
  });
});

describe("when something fails", () => {
  beforeEach(seed);

  it("names that cannot be loaded do not fail the page: 200, plain sentences, and it says so", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    h.failTransaction = (n) => (n === 2 ? new Error("connection terminated with secret-looking text") : null);
    const { res, body } = await get("?types=all");
    expect(res.status).toBe(200);
    expect(body.enriched).toBe(false);
    expect(body.entries).toHaveLength(16);
    expect(body.entries[1].plain).toBe("Updated a member's details");
    expect(body.entries[1].parts).toEqual([{ text: "Updated a member's details" }]);
    expect(body.entries[1].source).toEqual({ label: "Staff", staff: JACK, support: false });
    expect(body.entries[1].undo).toEqual({ ok: true, sinceHere: { userId: JACK.id, name: JACK.name } });
    expect(JSON.stringify(body)).not.toContain("07700");
    // The log line carries counts and the error's class, never its message.
    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][1])).not.toContain("secret-looking");
  });

  it("a query the database gave up on is a 504 that tells the person what to do", async () => {
    const failures = [Object.assign(new Error("canceling statement due to statement timeout"), { meta: { code: "57014" } }), Object.assign(new Error("Raw query failed. Code: `57014`"), {}), new TenantTransactionBudgetError(15_000, 15_200), Object.assign(new Error("Transaction API error"), { code: "P2028" })];
    for (const failure of failures) {
      h.transactions.length = 0;
      h.failTransaction = (n) => (n === 1 ? failure : null);
      const { res, body } = await get("?types=all");
      expect(res.status, failure.message).toBe(504);
      expect(body).toEqual({ ok: false, code: "timeout", error: "That's too much to load at once. Jump to a date or narrow the filters." });
    }
  });

  it("any other failure is a 500 with a reference, never an empty list", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    h.failTransaction = (n) => (n === 1 ? new Error("relation does not exist") : null);
    const { res, body } = await get();
    expect(res.status).toBe(500);
    expect(body.error).toBe("Couldn't load activity.");
    expect(body.entries).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain("relation");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

describe("what the response may contain", () => {
  beforeEach(seed);

  const ALLOWED_TOP = ["clock", "droppedTypes", "enriched", "entries", "filters", "ignoredTypes", "nextCursor"];
  const ALLOWED_ENTRY = ["at", "changes", "dayKey", "detail", "detailPlain", "id", "parts", "plain", "source", "type", "undo", "undone"];

  it("only the documented keys, for both roles", async () => {
    for (const role of ["owner", "manager"] as const) {
      if (role === "manager") asManager();
      const { body } = await get("?types=all");
      expect(Object.keys(body).sort(), role).toEqual(ALLOWED_TOP);
      expect(body.entries.length).toBeGreaterThan(3);
      for (const e of body.entries) {
        for (const key of Object.keys(e)) expect(ALLOWED_ENTRY, `${role}: ${key}`).toContain(key);
        expect(Object.keys(e.source).sort()).toEqual(["label", "staff", "support"]);
        // Nothing nested carries a key of its own invention either.
        for (const part of [...e.parts, ...(e.detail ?? [])]) {
          const keys = Object.keys(part).sort();
          expect(["text"].join() === keys.join() || ["subject"].join() === keys.join() || ["possessive", "subject"].join() === keys.join(), keys.join()).toBe(true);
          if ("subject" in part) for (const key of Object.keys(part.subject)) expect(["kind", "name", "href", "gone"], key).toContain(key);
        }
        for (const change of e.changes ?? []) expect(Object.keys(change).sort()).toEqual(["from", "label", "to"]);
        if (e.source.staff) expect(Object.keys(e.source.staff).sort()).toEqual(["id", "name"]);
        if (role === "manager") expect("undo" in e).toBe(false);
      }
      expect(body.entries.map((e) => e.type).every((t) => visibleTypeKeys(role).includes(t))).toBe(true);
    }
  });

  it("none of a row's private fields or values, for the owner either", async () => {
    log("member.create", { userId: OWNER.id, operatorId: "op_secret", metadata: { name: "Melody Orekoya", email: "melody@example.test", actingAs: "op_secret", requestId: "req_abc", ipAddress: "203.0.113.9", userAgent: "Mozilla/5.0" } });
    const text = JSON.stringify((await get("?types=all")).body);
    for (const banned of ['"metadata"', "ipAddress", "userAgent", "operatorId", "requestId", "actingAs", '"email"', "tenantId", "example.test", "op_secret", "op_1", "203.0.113", "Mozilla"]) expect(text, banned).not.toContain(banned);
  });
});

describe("money on the page", () => {
  it("a payment recorded with a currency code nobody recognises does not fail the page or its own trail", async () => {
    records.payment.push({ id: "p_odd", tenantId: CLUB, memberId: "m_mel", amountPence: 2000, currency: "1AB", stripeInvoiceId: null, paidAt: at("2026-11-04T09:00:00Z"), createdAt: at("2026-11-04T09:00:00Z") });
    try {
      log("payment.manual", { entityType: "Payment", entityId: "p_odd", userId: JACK.id, metadata: { memberId: "m_mel", method: "cash", amountPence: 2000 } });
      const page = await get("?types=all");
      expect(page.res.status).toBe(200);
      expect(page.body.entries[0].plain).toBe("Jack Streeter recorded a 20.00 1AB payment from Melody Orekoya");
      const trail = await get("?types=all&paymentId=p_odd");
      expect(trail.res.status).toBe(200);
      expect(trail.body.filters.payment).toEqual({ id: "p_odd", label: "20.00 1AB · 4 Nov 2026" });
    } finally {
      records.payment.pop();
    }
  });

  it("an amount with no currency on its row is in the club's currency", async () => {
    records.tenant[0].currency = "EUR";
    try {
      log("payment.adhoc.charge", { userId: JACK.id, metadata: { amountPence: 1500, outcome: "succeeded" } });
      expect((await get("?types=all")).body.entries[0].plain).toBe("Jack Streeter charged Melody Orekoya's card €15.00");
    } finally {
      records.tenant[0].currency = "GBP";
    }
  });

  it("a member far down a card-scan batch is named on their own timeline", async () => {
    log("attendance.card_scan", { entityType: "ClassInstance", entityId: "s_wed", userId: JACK.id, metadata: { classInstanceId: "s_wed", memberIds: ["x1", "x2", "x3", "x4", "x5", "x6", "x7", "m_mel"] } });
    const { body } = await get("?types=checkin&memberId=m_mel");
    expect(body.entries[0].plain).toBe("Melody Orekoya was scanned in to Advanced No-Gi · Wed 4 Nov, 19:00");
  });
});
