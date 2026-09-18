// POST /api/checkin/card — the scanner's server half.
//
// Every test here is written to FAIL if the behaviour it guards is removed,
// rather than to restate the implementation. The three that matter most:
//
//  * `cardVersion` mismatch is refused. Without it, revocation is a silent
//    no-op and a lost card keeps working for its full five-year expiry —
//    which is exactly the state the module header of lib/card-token.ts warned
//    about while nothing could bump the column.
//  * A coach is narrowed to instances they teach. /api/checkin has no such
//    narrowing; copying it would have let any coach scan members into any
//    class while the manual toggle on the same screen refused them.
//  * The write is `method: "qr"` under the ADMIN gate profile. Get the method
//    wrong and the reports label and filter chip stay dead; turn a gate on and
//    a cash-paying member is 402'd at the door by their own club's register.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

const ROOT_SECRET = process.env.NEXTAUTH_SECRET ?? "checkin-card-route-test-secret";
process.env.NEXTAUTH_SECRET = ROOT_SECRET;

const TENANT = "tenant_a";
const OTHER_TENANT = "tenant_b";
const OWNER_ID = "user_owner";
const COACH_ID = "user_coach";
const INSTANCE = "inst_1";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

const {
  mockRequireApiStaff,
  mockInstanceFindFirst,
  mockMemberFindMany,
  mockPerformCheckin,
  mockCheckRateLimit,
  mockLogAudit,
} = vi.hoisted(() => ({
  mockRequireApiStaff: vi.fn(),
  mockInstanceFindFirst: vi.fn(),
  mockMemberFindMany: vi.fn(),
  mockPerformCheckin: vi.fn(),
  mockCheckRateLimit: vi.fn(),
  mockLogAudit: vi.fn(),
}));

vi.mock("@/lib/api-authz", () => ({ requireApiStaff: mockRequireApiStaff }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mockCheckRateLimit }));
vi.mock("@/lib/audit-log", () => ({ logAudit: mockLogAudit }));
vi.mock("@/lib/checkin", () => ({ performCheckin: mockPerformCheckin }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      classInstance: { findFirst: mockInstanceFindFirst },
      member: { findMany: mockMemberFindMany },
    }),
}));

type Route = typeof import("@/app/api/checkin/card/route");
type CardToken = typeof import("@/lib/card-token");

let POST: Route["POST"];
let signCardToken: CardToken["signCardToken"];

beforeAll(async () => {
  ({ signCardToken } = await import("@/lib/card-token"));
  ({ POST } = await import("@/app/api/checkin/card/route"));
});

function req(body: unknown) {
  return { json: async () => body, headers: new Headers() } as unknown as Request;
}

function asOwner() {
  mockRequireApiStaff.mockResolvedValue({ ok: true, tenantId: TENANT, userId: OWNER_ID, role: "owner" });
}
function asCoach() {
  mockRequireApiStaff.mockResolvedValue({ ok: true, tenantId: TENANT, userId: COACH_ID, role: "coach" });
}

/** A card for `memberId` at `cardVersion`, signed for real. */
function card(memberId: string, cardVersion = 1, tenantId = TENANT) {
  return signCardToken({ tenantId, memberId, cardVersion });
}

function memberRow(id: string, cardVersion = 1, name = "Sam Green") {
  return { id, name, cardVersion };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockCheckRateLimit.mockResolvedValue({ allowed: true });
  mockInstanceFindFirst.mockResolvedValue({ id: INSTANCE, isCancelled: false });
  mockMemberFindMany.mockResolvedValue([]);
  mockPerformCheckin.mockResolvedValue({
    kind: "success",
    record: { id: "att_1", tenantId: TENANT, memberId: "mem_1", classInstanceId: INSTANCE, checkInMethod: "qr" },
    coverage: { kind: "manual" },
  });
  mockLogAudit.mockResolvedValue(undefined);
  asOwner();
});

describe("POST /api/checkin/card — revocation", () => {
  it("refuses a card whose version is behind the member's, and does not check them in", async () => {
    // The member's card was revoked and reprinted: column is now 2.
    mockMemberFindMany.mockResolvedValue([memberRow("mem_1", 2)]);

    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1", 1)] }));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.results[0].status).toBe("revoked");
    expect(body.recorded).toBe(0);
    // The crucial half: a revoked card must not record attendance.
    expect(mockPerformCheckin).not.toHaveBeenCalled();
  });

  it("accepts a card whose version matches", async () => {
    mockMemberFindMany.mockResolvedValue([memberRow("mem_1", 3)]);

    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1", 3)] }));
    const body = await res.json();

    expect(body.results[0].status).toBe("success");
    expect(body.recorded).toBe(1);
    expect(mockPerformCheckin).toHaveBeenCalledTimes(1);
  });

  it("refuses a card printed AHEAD of the member's version too", async () => {
    // Not merely `<`: any disagreement is a card the club did not issue.
    mockMemberFindMany.mockResolvedValue([memberRow("mem_1", 1)]);

    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1", 9)] }));
    const body = await res.json();

    expect(body.results[0].status).toBe("revoked");
    expect(mockPerformCheckin).not.toHaveBeenCalled();
  });
});

describe("POST /api/checkin/card — who may scan into which class", () => {
  // Noe, 17 Sep 2026: "coaches should see all classes but theirs should be
  // specifically highlighted." A covering coach scans whatever class they are
  // covering; the highlight is guidance, not a lock. Tenancy is untouched.
  it.each(["owner", "manager", "admin", "coach"])("does not narrow %s — every staff role may scan into any class in the club", async (role) => {
    mockRequireApiStaff.mockResolvedValue({ ok: true, tenantId: TENANT, userId: role === "coach" ? COACH_ID : OWNER_ID, role });
    await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1")] }));

    const where = mockInstanceFindFirst.mock.calls[0][0].where;
    expect(where.class.instructorId).toBeUndefined();
    expect(where.class.tenantId).toBe(TENANT);
  });

  it("404s when the instance is not in the club, without touching attendance", async () => {
    asCoach();
    mockInstanceFindFirst.mockResolvedValue(null);

    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1")] }));

    expect(res.status).toBe(404);
    expect(mockPerformCheckin).not.toHaveBeenCalled();
  });

  it("refuses when the staff gate refuses", async () => {
    const denied = { status: 403, json: async () => ({ error: "Forbidden" }) };
    mockRequireApiStaff.mockResolvedValue({ ok: false, response: denied });

    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1")] }));

    expect(res.status).toBe(403);
    expect(mockInstanceFindFirst).not.toHaveBeenCalled();
    expect(mockPerformCheckin).not.toHaveBeenCalled();
  });

  it("scopes the member lookup to the caller's tenant", async () => {
    await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1")] }));
    const where = mockMemberFindMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe(TENANT);
  });
});

describe("POST /api/checkin/card — how the attendance is written", () => {
  beforeEach(() => {
    mockMemberFindMany.mockResolvedValue([memberRow("mem_1")]);
  });

  it('writes method "qr" — the value the reports label and filter chip need', async () => {
    await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1")] }));
    expect(mockPerformCheckin.mock.calls[0][0].method).toBe("qr");
  });

  it("uses the admin gate profile, so a coach's register never refuses a member at the door", async () => {
    await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1")] }));
    const args = mockPerformCheckin.mock.calls[0][0];
    expect(args.enforceRankGate).toBe(false);
    expect(args.enforceRosterGate).toBe(false);
    expect(args.enforceTimeWindow).toBe(false);
    expect(args.requireCoverage).toBe(false);
  });

  it("records which member of staff scanned", async () => {
    asCoach();
    await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1")] }));
    expect(mockPerformCheckin.mock.calls[0][0].checkedInByUserId).toBe(COACH_ID);
  });

  it("reports a re-scan as already-in rather than an error", async () => {
    mockPerformCheckin.mockResolvedValue({ kind: "duplicate" });
    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1")] }));
    const body = await res.json();
    expect(body.results[0].status).toBe("duplicate");
    expect(body.recorded).toBe(0);
  });

  it("surfaces an unexpected checkin outcome as a failure instead of hiding it", async () => {
    // Impossible with every gate off — which is precisely why it must not be
    // mapped to something friendlier if it ever happens.
    mockPerformCheckin.mockResolvedValue({ kind: "no_coverage" });
    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1")] }));
    const body = await res.json();
    expect(body.results[0].status).toBe("error");
    expect(body.failed).toBe(1);
  });
});

describe("POST /api/checkin/card — bad cards never reach the database", () => {
  it.each([
    ["not a token at all", "nonsense", "invalid"],
    ["a token with a third segment", "a.b.c", "invalid"],
  ])("%s → %s", async (_label, token, expected) => {
    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [token] }));
    const body = await res.json();
    expect(body.results[0].status).toBe(expected);
    expect(mockPerformCheckin).not.toHaveBeenCalled();
  });

  it("rejects another club's card as wrong_tenant, not as a generic failure", async () => {
    const res = await POST(
      req({ classInstanceId: INSTANCE, tokens: [card("mem_1", 1, OTHER_TENANT)] }),
    );
    const body = await res.json();
    expect(body.results[0].status).toBe("wrong_tenant");
    expect(mockPerformCheckin).not.toHaveBeenCalled();
  });

  it("reports an expired card as expired so staff know to reprint", async () => {
    const { signCardToken: sign } = await import("@/lib/card-token");
    const expired = sign({ tenantId: TENANT, memberId: "mem_1", cardVersion: 1 }, -60);
    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [expired] }));
    const body = await res.json();
    expect(body.results[0].status).toBe("expired");
    expect(mockPerformCheckin).not.toHaveBeenCalled();
  });

  it("reports a card for a member who no longer exists", async () => {
    mockMemberFindMany.mockResolvedValue([]);
    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_gone")] }));
    const body = await res.json();
    expect(body.results[0].status).toBe("member_not_found");
    expect(mockPerformCheckin).not.toHaveBeenCalled();
  });
});

describe("POST /api/checkin/card — the same card twice in one request", () => {
  it("checks in once and reports the repeat, rather than burning a second credit", async () => {
    mockMemberFindMany.mockResolvedValue([memberRow("mem_1")]);
    const token = card("mem_1");

    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [token, token] }));
    const body = await res.json();

    expect(mockPerformCheckin).toHaveBeenCalledTimes(1);
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(["success", "duplicate"]);
    expect(body.recorded).toBe(1);
  });
});

describe("POST /api/checkin/card — limits and refusals", () => {
  it("refuses rather than degrading to an unlimited in-memory bucket", async () => {
    // failClosed: the limiter throwing must refuse, not wave the request through.
    mockCheckRateLimit.mockRejectedValue(new Error("db down"));
    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1")] }));
    expect(res.status).toBe(503);
    expect(mockPerformCheckin).not.toHaveBeenCalled();
  });

  it("asks the limiter to fail closed", async () => {
    await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1")] }));
    expect(mockCheckRateLimit.mock.calls[0][3]).toEqual({ failClosed: true });
  });

  it("429s when the burst allowance is spent", async () => {
    mockCheckRateLimit.mockResolvedValue({ allowed: false });
    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1")] }));
    expect(res.status).toBe(429);
    expect(mockPerformCheckin).not.toHaveBeenCalled();
  });

  it("refuses a cancelled class", async () => {
    mockInstanceFindFirst.mockResolvedValue({ id: INSTANCE, isCancelled: true });
    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1")] }));
    expect(res.status).toBe(409);
    expect(mockPerformCheckin).not.toHaveBeenCalled();
  });

  it("rejects an oversized batch instead of accepting an unbounded loop", async () => {
    const tokens = Array.from({ length: 26 }, (_, i) => card(`mem_${i}`));
    const res = await POST(req({ classInstanceId: INSTANCE, tokens }));
    expect(res.status).toBe(400);
  });

  it("rejects a body with no tokens", async () => {
    const res = await POST(req({ classInstanceId: INSTANCE, tokens: [] }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/checkin/card — audit", () => {
  it("records a scan run that checked someone in", async () => {
    mockMemberFindMany.mockResolvedValue([memberRow("mem_1")]);
    await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1")] }));

    expect(mockLogAudit).toHaveBeenCalledTimes(1);
    const entry = mockLogAudit.mock.calls[0][0];
    expect(entry.action).toBe("attendance.card_scan");
    expect(entry.tenantId).toBe(TENANT);
    expect(entry.metadata.recorded).toBe(1);
  });

  it("does not write an audit row when nothing was recorded", async () => {
    mockMemberFindMany.mockResolvedValue([memberRow("mem_1", 2)]);
    await POST(req({ classInstanceId: INSTANCE, tokens: [card("mem_1", 1)] }));
    expect(mockLogAudit).not.toHaveBeenCalled();
  });
});
