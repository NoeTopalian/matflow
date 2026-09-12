// POST /api/apply — a lead that nobody hears about is a lost customer.
//
// The route used to fire both emails through `Promise.allSettled`, discard the
// results, and return `{ ok: true }`. So a prospective gym could apply and
// nobody at MatFlow would ever learn they had — with no error anywhere, because
// nothing was ever checked. For a business whose entire problem is winning its
// first gyms, that is the most expensive silent failure in the product.
//
// The two emails are deliberately NOT equal. The applicant's confirmation is a
// courtesy and its failure is survivable, because the GymApplication row is
// already committed. The internal notification is the one that decides whether
// a human ever sees the lead.

import { vi, describe, it, expect, beforeEach, beforeAll } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

const { mockSendEmail, mockCreate, mockCheckRateLimit } = vi.hoisted(() => ({
  mockSendEmail: vi.fn(),
  mockCreate: vi.fn(),
  mockCheckRateLimit: vi.fn(),
}));

vi.mock("@/lib/email", () => ({ sendEmail: mockSendEmail }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: mockCheckRateLimit,
  getClientIp: () => "203.0.113.42",
}));
vi.mock("@/lib/prisma-tenant", () => ({
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ gymApplication: { create: mockCreate } }),
}));

type Route = typeof import("@/app/api/apply/route");
let POST: Route["POST"];

beforeAll(async () => {
  ({ POST } = await import("@/app/api/apply/route"));
});

const BODY = {
  gymName: "Total BJJ",
  ownerName: "Sean Coates",
  email: "sean@example.com",
  phone: "07000 000000",
  sport: "BJJ",
  memberCount: "200",
  message: "Looking to move off spreadsheets.",
};

function req(body: unknown = BODY) {
  return {
    json: async () => body,
    headers: new Headers(),
  } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.MATFLOW_APPLICATIONS_TO = "team@matflow.studio";
  mockCheckRateLimit.mockResolvedValue({ allowed: true });
  mockCreate.mockResolvedValue({ id: "app_1" });
  mockSendEmail.mockResolvedValue({ ok: true, logId: "log_1" });
});

describe("apply — when nobody can be told", () => {
  it("does NOT report success when every internal notification fails", async () => {
    // Mail is effectively disabled: every send reports failure.
    mockSendEmail.mockResolvedValue({ ok: false, logId: "log_1" });

    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(502);
    expect(body.ok).toBe(false);
  });

  it("still tells the applicant their application was saved, and how to reach a human", async () => {
    // The row IS committed, so claiming total failure would be its own lie —
    // and would invite a resubmission that files the same gym twice.
    mockSendEmail.mockResolvedValue({ ok: false, logId: "log_1" });

    const res = await POST(req());
    const body = await res.json();

    expect(body.saved).toBe(true);
    expect(body.id).toBe("app_1");
    expect(body.error).toContain("hello@matflow.studio");
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  it("does not report success when the internal send throws outright", async () => {
    mockSendEmail.mockRejectedValue(new Error("resend unreachable"));
    const res = await POST(req());
    expect(res.status).toBe(502);
  });
});

describe("apply — when a human was reached", () => {
  it("succeeds when the internal notification lands", async () => {
    const res = await POST(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.id).toBe("app_1");
  });

  it("still succeeds when only the applicant's courtesy email fails", async () => {
    // First call is the applicant confirmation, the rest are internal.
    mockSendEmail
      .mockResolvedValueOnce({ ok: false, logId: "log_a" })
      .mockResolvedValue({ ok: true, logId: "log_b" });

    const res = await POST(req());
    const body = await res.json();

    // The lead is safe and a human was told; failing the submission here would
    // push a customer away over a receipt they did not need.
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
  });

  it("succeeds if ANY of several internal recipients is reached", async () => {
    process.env.MATFLOW_APPLICATIONS_TO = "a@matflow.studio,b@matflow.studio";
    mockSendEmail
      .mockResolvedValueOnce({ ok: true, logId: "applicant" }) // applicant
      .mockResolvedValueOnce({ ok: false, logId: "a" }) // first internal fails
      .mockResolvedValueOnce({ ok: true, logId: "b" }); // second lands

    const res = await POST(req());
    expect(res.status).toBe(200);
  });
});
