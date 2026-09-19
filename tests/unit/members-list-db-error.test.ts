import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Lane L-C round 1, defect 3.
 *
 * `GET /api/members` used to answer a database fault with
 *
 *     } catch {
 *       return NextResponse.json({ members: [], nextCursor: null });
 *     }
 *
 * — a bare catch, no status, no log. A Neon blip, a pool exhaustion or a
 * malformed cursor arrived at the client indistinguishable from "this club has
 * no members", and the screen rendered its empty state. docs/RULES.md §2: an
 * HTTP error is never an empty state.
 *
 * The contract now: a fault answers 5xx through `apiError`, which is also what
 * mints the Sentry breadcrumb and the owner-facing reference. The HAPPY path
 * must keep its exact shape — `{ members, nextCursor }` with the flattened
 * `profilePictureUrl` — because five screens parse it.
 */

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

const { findManyMock } = vi.hoisted(() => ({ findManyMock: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: { member: { findMany: findManyMock } } }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: vi.fn().mockReturnValue("203.0.113.9"),
}));

import { GET } from "@/app/api/members/route";
import { auth } from "@/auth";

const mockAuth = vi.mocked(auth);

function asOwner() {
  mockAuth.mockResolvedValue({
    user: { id: "u1", role: "owner", tenantId: "t-A" },
  } as unknown as Awaited<ReturnType<typeof auth>>);
}

function req(qs = "") {
  return new Request(`http://localhost/api/members${qs}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  asOwner();
});

describe("GET /api/members when the database is unreachable", () => {
  it("answers 5xx, never 200", async () => {
    findManyMock.mockRejectedValueOnce(new Error("Can't reach database server at ep-hidden-salad"));
    const res = await GET(req());
    expect(res.status, "a lookup that failed must not read as a club with no members").toBeGreaterThanOrEqual(500);
  });

  it("does not hand back an empty members array on a fault", async () => {
    findManyMock.mockRejectedValueOnce(new Error("connection terminated unexpectedly"));
    const res = await GET(req());
    const body = await res.json();
    expect(body.members, "an empty roster is a lie the screen cannot tell from the truth").toBeUndefined();
  });

  it("carries a human sentence the owner can act on", async () => {
    findManyMock.mockRejectedValueOnce(new Error("pool timeout"));
    const res = await GET(req());
    const body = await res.json();
    expect(typeof body.error).toBe("string");
    expect(String(body.error).length).toBeGreaterThan(10);
  });

  it("still answers the happy path in the shape its five consumers parse", async () => {
    findManyMock.mockResolvedValueOnce([
      { id: "m1", name: "Alex", email: "a@b.c", phone: null, status: "active",
        paymentStatus: "paid", membershipType: null, joinedAt: new Date(), waiverAccepted: true,
        accountType: "adult", dateOfBirth: null, parentMemberId: null, hasKidsHint: false,
        memberRanks: [], photos: [{ url: "https://x/y.png" }] },
    ]);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.members).toHaveLength(1);
    expect(body.members[0].profilePictureUrl, "photos[] is still flattened").toBe("https://x/y.png");
    expect(body.members[0].photos, "…and the relation itself never reaches the wire").toBeUndefined();
    expect(body).toHaveProperty("nextCursor");
  });
});
