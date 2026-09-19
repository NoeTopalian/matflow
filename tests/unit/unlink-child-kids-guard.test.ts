import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Lane L-C round 3 — the BUG this lane found while driving J23 properly.
 *
 * `DELETE /api/members/[id]/unlink-child` nulled `parentMemberId` with a bare
 * `updateMany`. For a `kids` child that row is forbidden by the database CHECK
 * `Member_kids_must_have_parent` (migration 20260515000001,
 * `accountType <> 'kids' OR parentMemberId IS NOT NULL`), so Postgres threw and
 * the handler's catch answered
 *
 *     apiError("Failed to unlink child", 500, …)
 *
 * — an owner told the club has a fault, when what happened is that the club
 * asked for something the schema does not allow. A 500 means "we did not
 * expect this". This one is expected, documented and has a correct answer.
 *
 * The contract now: a `kids` child is a 409 naming why and what to do instead,
 * nothing is written, and every legitimate unlink path is untouched.
 */

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/lib/api-error", () => ({
  apiError: (error: string, status: number) => ({ status, json: async () => ({ error }) }),
}));

const { findFirstMock, updateManyMock } = vi.hoisted(() => ({
  findFirstMock: vi.fn(),
  updateManyMock: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ member: { findFirst: findFirstMock, updateMany: updateManyMock } }),
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));

import { DELETE } from "@/app/api/members/[id]/unlink-child/route";
import { auth } from "@/auth";

const mockAuth = vi.mocked(auth);
const PARENT = "m-parent";
const CHILD = "m-child";

function req(body: unknown = { childMemberId: CHILD }): Request {
  return {
    url: `http://localhost:3847/api/members/${PARENT}/unlink-child`,
    headers: new Headers(),
    json: async () => body,
  } as unknown as Request;
}

const params = Promise.resolve({ id: PARENT });

beforeEach(() => {
  vi.clearAllMocks();
  mockAuth.mockResolvedValue({
    user: { id: "u-owner", role: "owner", tenantId: "t-A" },
  } as unknown as Awaited<ReturnType<typeof auth>>);
  updateManyMock.mockResolvedValue({ count: 1 });
});

describe("unlink-child and the kids guard", () => {
  it("refuses a kids child with a 409, not a 500", async () => {
    findFirstMock.mockResolvedValue({ id: CHILD, accountType: "kids" });
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(409);
  });

  it("…and the refusal says why and what to do instead", async () => {
    findFirstMock.mockResolvedValue({ id: CHILD, accountType: "kids" });
    const res = await DELETE(req(), { params });
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/without a guardian/i);
    expect(body.error).toMatch(/another guardian|remove the account/i);
    // British English, and no jargon from the database leaking to the owner.
    expect(body.error).not.toMatch(/CHECK|constraint|accountType|null/i);
  });

  it("…and writes nothing", async () => {
    findFirstMock.mockResolvedValue({ id: CHILD, accountType: "kids" });
    await DELETE(req(), { params });
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("a junior is unlinked exactly as before — 200 and one write", async () => {
    findFirstMock.mockResolvedValue({ id: CHILD, accountType: "junior" });
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(200);
    expect(updateManyMock).toHaveBeenCalledTimes(1);
    expect(updateManyMock.mock.calls[0][0].data).toEqual({ parentMemberId: null });
  });

  it("an adult sub-account is unlinked exactly as before", async () => {
    findFirstMock.mockResolvedValue({ id: CHILD, accountType: "adult" });
    expect((await DELETE(req(), { params })).status).toBe(200);
  });

  it("a link that does not exist is still a 404, and still writes nothing", async () => {
    findFirstMock.mockResolvedValue(null);
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(404);
    expect(updateManyMock).not.toHaveBeenCalled();
  });

  it("losing the race after the read is a 404, not a success", async () => {
    findFirstMock.mockResolvedValue({ id: CHILD, accountType: "junior" });
    updateManyMock.mockResolvedValue({ count: 0 });
    expect((await DELETE(req(), { params })).status).toBe(404);
  });

  it("the constraint reaching the catch is still a 409, never a 500", async () => {
    findFirstMock.mockResolvedValue({ id: CHILD, accountType: "junior" });
    updateManyMock.mockRejectedValue(
      new Error('new row for relation "Member" violates check constraint "Member_kids_must_have_parent"'),
    );
    const res = await DELETE(req(), { params });
    expect(res.status).toBe(409);
  });

  it("an unrelated fault is still a 500 — the guard narrows nothing else", async () => {
    findFirstMock.mockResolvedValue({ id: CHILD, accountType: "junior" });
    updateManyMock.mockRejectedValue(new Error("connection terminated unexpectedly"));
    expect((await DELETE(req(), { params })).status).toBe(500);
  });
});
