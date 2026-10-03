/**
 * GET /api/members?guardianReview=1 — the guardian review queue's data
 * (3 Oct 2026). An import SUGGESTS parent links (shared email / emergency
 * contact); this lists them so the owner can confirm or reject each one
 * without opening every child's profile.
 *
 * Pinned here:
 *  - the predicate is exactly "parent link set, not confirmed", tenant-scoped,
 *    and the count uses the same predicate as the rows;
 *  - only owner and manager may list it (a coach or admin would only see
 *    controls the confirm route refuses) — refused before any read;
 *  - the guardian's address never reaches the wire, only whether they can
 *    sign in (a synthesised no-login address cannot);
 *  - a database fault is a 5xx, never an empty queue.
 */
import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number; headers?: Record<string, string> }) => ({
      status: init?.status ?? 200,
      headers: init?.headers ?? {},
      json: async () => body,
    }),
  },
}));

const { findManyMock, countMock } = vi.hoisted(() => ({ findManyMock: vi.fn(), countMock: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: { member: { findMany: findManyMock, count: countMock } } }));
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

function as(role: string) {
  mockAuth.mockResolvedValue({
    user: { id: "u1", role, tenantId: "t-A" },
  } as unknown as Awaited<ReturnType<typeof auth>>);
}

const req = (qs = "?guardianReview=1") => new Request(`http://localhost/api/members${qs}`);

const row = (over: Record<string, unknown> = {}) => ({
  id: "kid-1",
  name: "Kit",
  accountType: "kids",
  dateOfBirth: new Date("2017-05-01T00:00:00Z"),
  status: "active",
  guardianSuggestedBy: "emergency_contact",
  parent: { id: "par-1", name: "Pat", email: "guardian-abc@no-login.matflow.local" },
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  as("owner");
});

describe("GET /api/members?guardianReview=1", () => {
  it("lists only unconfirmed parent links in this tenant, and counts with the same predicate", async () => {
    findManyMock.mockResolvedValueOnce([row()]);
    countMock.mockResolvedValueOnce(219);
    const res = await GET(req());
    expect(res.status).toBe(200);
    const where = findManyMock.mock.calls[0][0].where;
    expect(where).toEqual({ tenantId: "t-A", parentMemberId: { not: null }, guardianConfirmedAt: null });
    expect(countMock.mock.calls[0][0].where).toEqual(where);
    const body = await res.json();
    expect(body.total).toBe(219);
    expect(body.suggestions).toEqual([
      {
        childId: "kid-1",
        childName: "Kit",
        childAccountType: "kids",
        childDateOfBirth: "2017-05-01T00:00:00.000Z",
        childStatus: "active",
        guardianId: "par-1",
        guardianName: "Pat",
        guardianCanSignIn: false,
        source: "emergency_contact",
        sourceLabel: "Emergency contact",
      },
    ]);
  });

  it("never sends the guardian's address — only whether they can sign in", async () => {
    findManyMock.mockResolvedValueOnce([
      row({ id: "kid-2", guardianSuggestedBy: "shared_email", parent: { id: "par-2", name: "Sam", email: "sam@example.test" } }),
    ]);
    countMock.mockResolvedValueOnce(1);
    const body = await (await GET(req())).json();
    expect(body.suggestions[0].guardianCanSignIn).toBe(true);
    expect(body.suggestions[0].sourceLabel).toBe("Shared email address");
    expect(JSON.stringify(body)).not.toContain("sam@example.test");
  });

  it("a manager may list it", async () => {
    as("manager");
    findManyMock.mockResolvedValueOnce([]);
    countMock.mockResolvedValueOnce(0);
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect((await res.json()).suggestions).toEqual([]);
  });

  it.each(["coach", "admin"])("a %s is refused before anything is read", async (role) => {
    as(role);
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(findManyMock).not.toHaveBeenCalled();
    expect(countMock).not.toHaveBeenCalled();
  });

  it("a member session is refused (the staff gate still runs first)", async () => {
    as("member");
    const res = await GET(req());
    expect(res.status).toBe(403);
    expect(findManyMock).not.toHaveBeenCalled();
  });

  it("a database fault is a 5xx with a sentence, never an empty queue", async () => {
    findManyMock.mockRejectedValueOnce(new Error("Can't reach database server"));
    const res = await GET(req());
    expect(res.status).toBeGreaterThanOrEqual(500);
    const body = await res.json();
    expect(body.suggestions).toBeUndefined();
    expect(typeof body.error).toBe("string");
  });

  it("passes the cursor through and returns the next one when the page is full", async () => {
    findManyMock.mockResolvedValueOnce([row({ id: "kid-9" })]);
    countMock.mockResolvedValueOnce(5);
    const body = await (await GET(req("?guardianReview=1&take=1&cursor=kid-8"))).json();
    const args = findManyMock.mock.calls[0][0];
    expect(args.cursor).toEqual({ id: "kid-8" });
    expect(args.skip).toBe(1);
    expect(args.take).toBe(1);
    expect(body.nextCursor).toBe("kid-9");
  });

  it("without the flag the ordinary list is unchanged (no guardian predicate)", async () => {
    findManyMock.mockResolvedValueOnce([]);
    await GET(req(""));
    expect(findManyMock.mock.calls[0][0].where).toEqual({ tenantId: "t-A" });
    expect(countMock).not.toHaveBeenCalled();
  });
});
