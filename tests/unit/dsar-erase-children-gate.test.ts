import { vi, describe, it, expect, beforeEach } from "vitest";

/**
 * Lane L-C round 3 — approved policy 1 (Noe, 19 Sep 2026).
 *
 * `POST /api/admin/dsar/erase` anonymised a parent IN PLACE and never read
 * `parentMemberId`. Two things followed, and the second is the one nobody
 * predicts:
 *
 *   1. A live child account whose guardian's consent record has been destroyed —
 *      the waiver on file was signed by a person the club can no longer identify.
 *   2. `POST /api/waiver/sign-for-child` refuses unless the PARENT carries all
 *      three emergency-contact fields, and the erase nulls exactly those three.
 *      So after an Article 17 erasure nobody can sign a waiver for that child
 *      again, and the screen says "Add your emergency contact details first" —
 *      of a member who no longer exists.
 *
 * The gate uses the vocabulary the product already has for this problem
 * (`?probe=1`, then `?strategy=`) rather than inventing a second one, and the
 * refusal names the COUNT and never the children: a data-protection refusal
 * must not itself disclose third-party personal data.
 *
 * These cases stop before the scrub transaction on purpose — they are the
 * refusal and probe paths, which is where the decision lives.
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

const { countMock, findFirstMock } = vi.hoisted(() => ({
  countMock: vi.fn(),
  findFirstMock: vi.fn(),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({ member: { count: countMock, findFirst: findFirstMock } }),
}));
vi.mock("@/lib/api-authz", () => ({
  requireApiRole: vi.fn(async () => ({
    ok: true,
    session: { user: { id: "u-owner", role: "owner", tenantId: "t-A" } },
  })),
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/token-hash", () => ({ hashToken: (s: string) => `h(${s})` }));
vi.mock("@/lib/member-delete", () => ({ deleteMemberCascade: vi.fn(async () => ({ kind: "ok", name: "x" })) }));
vi.mock("@vercel/blob", () => ({ del: vi.fn() }));
vi.mock("@/lib/blob-url", () => ({ isVercelBlobUrl: () => false }));
vi.mock("@/lib/stripe/subscriptions", () => ({
  cancelSubscriptionAtPeriodEnd: vi.fn(async () => ({ ok: true, cancelAt: null })),
}));

import { POST } from "@/app/api/admin/dsar/erase/route";

const PARENT = "m-parent";

function req(query: string): Request {
  return { url: `http://localhost:3847/api/admin/dsar/erase?memberId=${PARENT}${query}`, headers: new Headers() } as unknown as Request;
}

beforeEach(() => {
  vi.clearAllMocks();
  // The member being erased: found, not already erased.
  findFirstMock.mockResolvedValue({
    id: PARENT,
    status: "active",
    email: "parent@example.test",
    stripeSubscriptionId: null,
  });
});

describe("DSAR erase — the guardian gate", () => {
  it("probe is read-only and reports how many active children hang off the member", async () => {
    countMock.mockResolvedValue(2);
    const res = await POST(req("&probe=1"));
    const body = (await res.json()) as { activeChildren: number; strategyRequired: boolean; strategies: string[] };
    expect(res.status).toBe(200);
    expect(body.activeChildren).toBe(2);
    expect(body.strategyRequired).toBe(true);
    expect(body.strategies).toEqual(["reassign", "cascade"]);
  });

  it("refuses an erase that would leave children pointing at an erased guardian", async () => {
    countMock.mockResolvedValue(3);
    const res = await POST(req(""));
    const body = (await res.json()) as { error: string; activeChildren: number };
    expect(res.status).toBe(409);
    expect(body.activeChildren).toBe(3);
    expect(body.error).toContain("3 active child accounts");
  });

  it("names the count and never a child", async () => {
    countMock.mockResolvedValue(1);
    const res = await POST(req(""));
    const body = (await res.json()) as Record<string, unknown> & { error: string };
    expect(body.error).toContain("1 active child account");
    // Singular copy, British English, and the two doors named.
    expect(body.error).toContain("strategy=reassign");
    expect(body.error).toContain("strategy=cascade");
    // The refusal carries nothing that identifies a child: the handler only
    // ever counted them, so the body is exactly the count, the copy and the two
    // doors — no `kids` array of names, as DELETE /api/members/[id] returns.
    expect(Object.keys(body).sort()).toEqual(["activeChildren", "error", "strategies"]);
    expect(JSON.stringify(body)).not.toMatch(/childId|kids|"id":/);
  });

  it("a member with no children is not gated at all", async () => {
    countMock.mockResolvedValue(0);
    const res = await POST(req("&probe=1"));
    const body = (await res.json()) as { strategyRequired: boolean; strategies: string[] };
    expect(body.strategyRequired).toBe(false);
    expect(body.strategies).toEqual([]);
  });

  it("reassign without a target is a 400, not a silent orphaning", async () => {
    countMock.mockResolvedValue(1);
    const res = await POST(req("&strategy=reassign"));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toContain("toParentMemberId");
  });

  it("refuses to re-link the children to the member being erased", async () => {
    countMock.mockResolvedValue(1);
    const res = await POST(req(`&strategy=reassign&toParentMemberId=${PARENT}`));
    expect(res.status).toBe(400);
  });

  it("refuses a guardian who is themselves a sub-account", async () => {
    countMock.mockResolvedValue(1);
    findFirstMock
      .mockResolvedValueOnce({ id: PARENT, status: "active", email: "parent@example.test", stripeSubscriptionId: null })
      .mockResolvedValueOnce({ id: "m-kid", parentMemberId: "m-someone", accountType: "kids", status: "active" });
    const res = await POST(req("&strategy=reassign&toParentMemberId=m-kid"));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/sub-account/);
  });

  it("refuses a guardian whose own membership is cancelled", async () => {
    countMock.mockResolvedValue(1);
    findFirstMock
      .mockResolvedValueOnce({ id: PARENT, status: "active", email: "parent@example.test", stripeSubscriptionId: null })
      .mockResolvedValueOnce({ id: "m-gone", parentMemberId: null, accountType: "adult", status: "cancelled" });
    const res = await POST(req("&strategy=reassign&toParentMemberId=m-gone"));
    expect(res.status).toBe(400);
    expect((await res.json() as { error: string }).error).toMatch(/cancelled/);
  });
});
