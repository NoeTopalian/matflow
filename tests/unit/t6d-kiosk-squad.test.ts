// T6d — squad (roster-only) classes at the kiosk.
//
// Owner decision 17 Oct 2026: a class with a roster is open only to the
// members on it. The kiosk picks the class first and the name second, so:
//  - the class list badges a squad class (`rosterOnly: true`) and says nothing
//    else about the roster — a boolean, never a member id (acceptance 1 + 4);
//  - the name search, told which class was tapped, lists only the rostered
//    members, so a member who is not on the squad is never offered it;
//  - a guardian appears only for a rostered child, and is then not offered
//    as "Self" unless rostered too;
//  - an id that is not a class of this club changes nothing.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

const TENANT = "tenant_a";
const KIOSK_TOKEN = "kiosk_token_abcdefghijklmnop";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const m = vi.hoisted(() => ({
  tenantFindFirst: vi.fn(),
  instanceFindMany: vi.fn(),
  instanceFindFirst: vi.fn(),
  rosterFindMany: vi.fn(),
  memberFindMany: vi.fn(),
  rateLimit: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ tenant: { findFirst: m.tenantFindFirst } }),
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      classInstance: { findMany: m.instanceFindMany, findFirst: m.instanceFindFirst },
      classRoster: { findMany: m.rosterFindMany },
      member: { findMany: m.memberFindMany },
    }),
}));
vi.mock("@/lib/token-hash", () => ({ hashToken: (t: string) => `hash_${t}` }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: m.rateLimit, getClientIp: () => "203.0.113.7" }));
vi.mock("@/lib/kiosk-token", () => ({
  signKioskMemberToken: ({ memberId }: { memberId: string }) => `signed_${memberId}`,
}));

let classesGET: typeof import("@/app/api/kiosk/[token]/classes/route")["GET"];
let membersGET: typeof import("@/app/api/kiosk/[token]/members/route")["GET"];
beforeAll(async () => {
  ({ GET: classesGET } = await import("@/app/api/kiosk/[token]/classes/route"));
  ({ GET: membersGET } = await import("@/app/api/kiosk/[token]/members/route"));
});

const params = Promise.resolve({ token: KIOSK_TOKEN });

function tenantRow() {
  return {
    id: TENANT, name: "Total BJJ", primaryColor: "#000", secondaryColor: "#111", textColor: "#fff",
    bgColor: "#000", logoUrl: null, fontFamily: null, subscriptionStatus: "active", deletedAt: null,
    timezone: "Europe/London",
  };
}

function instance(id: string, name: string, rosterCount: number) {
  return {
    id,
    date: new Date("2026-10-17T00:00:00Z"),
    startTime: "18:00",
    endTime: "19:00",
    class: { id: `class_${id}`, name, requiredRank: null, maxRank: null, _count: { rosterMembers: rosterCount } },
  };
}

function memberRow(id: string, name: string, over: Record<string, unknown> = {}) {
  return {
    id, name, accountType: "adult", parentMemberId: null, guardianConfirmedAt: null,
    waiverAccepted: true, membershipType: "Unlimited", memberRanks: [], children: [], ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.rateLimit.mockResolvedValue({ allowed: true });
  m.tenantFindFirst.mockResolvedValue(tenantRow());
  m.instanceFindMany.mockResolvedValue([]);
  m.instanceFindFirst.mockResolvedValue(null);
  m.rosterFindMany.mockResolvedValue([]);
  m.memberFindMany.mockResolvedValue([]);
});

describe("GET /api/kiosk/[token]/classes — the squad badge", () => {
  it("acceptance 1: a class with a roster carries rosterOnly: true; an open class false", async () => {
    m.instanceFindMany.mockResolvedValue([instance("i1", "Comp Squad", 3), instance("i2", "Fundamentals", 0)]);
    const body = await (await classesGET(new Request("https://x/api/kiosk/t/classes"), { params })).json();
    expect(body.classes.map((c: { name: string; rosterOnly: boolean }) => [c.name, c.rosterOnly])).toEqual([
      ["Comp Squad", true],
      ["Fundamentals", false],
    ]);
  });

  it("acceptance 4: asks for a COUNT of the roster, never the rows", async () => {
    await classesGET(new Request("https://x/api/kiosk/t/classes"), { params });
    const select = m.instanceFindMany.mock.calls[0][0].include.class.select;
    expect(select._count).toEqual({ select: { rosterMembers: true } });
    expect(select.rosterMembers).toBeUndefined();
  });

  it("acceptance 4: the response carries no member ids", async () => {
    m.instanceFindMany.mockResolvedValue([instance("i1", "Comp Squad", 2)]);
    const body = await (await classesGET(new Request("https://x/api/kiosk/t/classes"), { params })).json();
    const text = JSON.stringify(body.classes);
    expect(text).not.toMatch(/memberId|rosterMembers|_count/);
    // T6c adds `category`: a timetable label key, not member data.
    expect(Object.keys(body.classes[0]).sort()).toEqual(
      ["category", "date", "endTime", "id", "maxRank", "name", "requiredRank", "rosterOnly", "startTime"].sort(),
    );
  });
});

const search = (qs: string) =>
  membersGET(new Request(`https://x/api/kiosk/${KIOSK_TOKEN}/members?${qs}`), { params });

describe("GET /api/kiosk/[token]/members — a squad class lists only its roster", () => {
  it("without a class, the search is exactly as before (no roster read, no roster filter)", async () => {
    await search("q=al");
    expect(m.instanceFindFirst).not.toHaveBeenCalled();
    expect(m.rosterFindMany).not.toHaveBeenCalled();
    expect(m.memberFindMany.mock.calls[0][0].where.OR).toBeUndefined();
  });

  it("an open class (no roster) does not filter the search", async () => {
    m.instanceFindFirst.mockResolvedValue({ classId: "class_open" });
    m.rosterFindMany.mockResolvedValue([]);
    await search("q=al&classInstanceId=inst_open");
    expect(m.memberFindMany.mock.calls[0][0].where.OR).toBeUndefined();
  });

  it("resolves the instance inside this club only, and reads the roster tenant-scoped", async () => {
    m.instanceFindFirst.mockResolvedValue({ classId: "class_squad" });
    m.rosterFindMany.mockResolvedValue([{ memberId: "mem_on" }]);
    await search("q=al&classInstanceId=inst_squad");
    expect(m.instanceFindFirst.mock.calls[0][0].where).toEqual({ id: "inst_squad", class: { tenantId: TENANT } });
    expect(m.rosterFindMany.mock.calls[0][0].where).toEqual({ tenantId: TENANT, classId: "class_squad" });
  });

  it("a squad class restricts the search to rostered members or guardians of a rostered child", async () => {
    m.instanceFindFirst.mockResolvedValue({ classId: "class_squad" });
    m.rosterFindMany.mockResolvedValue([{ memberId: "mem_on" }, { memberId: "kid_on" }]);
    await search("q=al&classInstanceId=inst_squad");
    const where = m.memberFindMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(TENANT);
    expect(where.OR[0]).toEqual({ id: { in: ["mem_on", "kid_on"] } });
    expect(where.OR[1].children.some.id).toEqual({ in: ["mem_on", "kid_on"] });
    // Only a CONFIRMED guardian link counts.
    expect(where.OR[1].children.some.guardianConfirmedAt).toEqual({ not: null });
  });

  it("a guardian listed for a rostered child is not offered as Self, and sees only the rostered child", async () => {
    m.instanceFindMany.mockResolvedValue([]);
    m.instanceFindFirst.mockResolvedValue({ classId: "class_squad" });
    m.rosterFindMany.mockResolvedValue([{ memberId: "kid_on" }]);
    m.memberFindMany.mockResolvedValue([
      memberRow("par_1", "Alex Parent", {
        children: [
          { id: "kid_on", name: "Kai", accountType: "kids", waiverAccepted: true, dateOfBirth: null },
          { id: "kid_off", name: "Kit", accountType: "kids", waiverAccepted: true, dateOfBirth: null },
        ],
      }),
    ]);
    const body = await (await search("q=al&classInstanceId=inst_squad")).json();
    expect(body.members).toHaveLength(1);
    expect(body.members[0].selfTrainable).toBe(false);
    expect(body.members[0].linkedKids.map((k: { name: string }) => k.name)).toEqual(["Kai"]);
  });

  it("a rostered member is offered as Self", async () => {
    m.instanceFindFirst.mockResolvedValue({ classId: "class_squad" });
    m.rosterFindMany.mockResolvedValue([{ memberId: "mem_on" }]);
    m.memberFindMany.mockResolvedValue([memberRow("mem_on", "Alice On")]);
    const body = await (await search("q=al&classInstanceId=inst_squad")).json();
    expect(body.members[0].selfTrainable).toBe(true);
    expect(body.members[0].kioskMemberToken).toBe("signed_mem_on");
  });

  it("an id that is not a class of this club is ignored", async () => {
    m.instanceFindFirst.mockResolvedValue(null);
    await search("q=al&classInstanceId=someone_elses_instance");
    expect(m.rosterFindMany).not.toHaveBeenCalled();
    expect(m.memberFindMany.mock.calls[0][0].where.OR).toBeUndefined();
  });

  it("an absurdly long id is not looked up", async () => {
    await search(`q=al&classInstanceId=${"x".repeat(65)}`);
    expect(m.instanceFindFirst).not.toHaveBeenCalled();
  });

  it("the response still carries no raw member ids", async () => {
    m.instanceFindFirst.mockResolvedValue({ classId: "class_squad" });
    m.rosterFindMany.mockResolvedValue([{ memberId: "mem_on" }]);
    m.memberFindMany.mockResolvedValue([memberRow("mem_on", "Alice On")]);
    const body = await (await search("q=al&classInstanceId=inst_squad")).json();
    expect(Object.keys(body.members[0])).not.toContain("id");
    expect(JSON.stringify(body)).not.toMatch(/"memberId"/);
  });
});
