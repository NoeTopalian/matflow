// C1 — `membershipTierId` is accepted, tenant-checked, and persisted ALONGSIDE
// the legacy `membershipType` string.
//
// The legacy free-text column cannot be dropped: revenue reporting still
// string-matches on it. So the contract is "both, always, and derived from the
// tier row" — never the client's own label, which would drift the first time
// an owner renamed a tier.
//
// The tenant check is the other half. RLS is currently decorative in this
// product (the app connects as a BYPASSRLS role), so the `where: { id,
// tenantId }` in lib/membership-tier.ts is the only thing stopping one gym
// from attaching its members to another gym's price list.

import { vi, describe, it, expect, beforeEach } from "vitest";

vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
  withRlsBypass: async <T,>(fn: (tx: unknown) => Promise<T>): Promise<T> => {
    const { prisma } = await import("@/lib/prisma");
    return fn(prisma);
  },
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    member: {
      findFirst: vi.fn(),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
    membershipTier: {
      findFirst: vi.fn(),
    },
    magicLinkToken: { create: vi.fn().mockResolvedValue({}) },
    // Attribution (M1): the create route now records the funnel start event in
    // the same transaction, so the mocked tx needs this writer.
    memberStatusEvent: { create: vi.fn().mockResolvedValue({ id: "evt" }) },
  },
}));

vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: vi.fn().mockResolvedValue({ allowed: true }) }));
vi.mock("@/lib/api-error", () => ({
  apiError: vi.fn((message: string, status: number) => ({
    status,
    json: async () => ({ error: message }),
  })),
}));

import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { memberCreateSchema, memberUpdateSchema } from "@/lib/schemas/member";
import { resolveMembershipTier, membershipTierWrite } from "@/lib/membership-tier";

const TENANT = "tenant_home";
const TIER = { id: "tier_adult", name: "Adult Unlimited", billingCycle: "monthly" };

function req(body: unknown) {
  return new Request("https://matflow.studio/api/members", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "https://matflow.studio" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(auth).mockResolvedValue({
    user: { id: "user_1", tenantId: TENANT, role: "owner", tenantSlug: "home" },
  } as never);
});

describe("membershipTierId — zod", () => {
  it("is accepted on create alongside the legacy label", () => {
    const parsed = memberCreateSchema.safeParse({
      name: "Sam Carter",
      email: "sam@example.com",
      membershipType: "Adult Unlimited",
      membershipTierId: "tier_adult",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.membershipTierId).toBe("tier_adult");
      expect(parsed.data.membershipType).toBe("Adult Unlimited");
    }
  });

  it("is accepted on update, and null means detach", () => {
    const parsed = memberUpdateSchema.safeParse({ membershipTierId: null });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.membershipTierId).toBeNull();
  });

  it("stays optional, so every existing caller keeps working", () => {
    expect(memberCreateSchema.safeParse({ name: "Sam", email: "s@e.com" }).success).toBe(true);
    expect(memberUpdateSchema.safeParse({ name: "Sam" }).success).toBe(true);
  });

  it("rejects an empty id rather than storing one", () => {
    expect(memberCreateSchema.safeParse({ name: "Sam", email: "s@e.com", membershipTierId: "" }).success).toBe(false);
  });
});

describe("resolveMembershipTier", () => {
  it("scopes the lookup to the caller's tenant", async () => {
    vi.mocked(prisma.membershipTier.findFirst).mockResolvedValue(TIER as never);
    await resolveMembershipTier(TENANT, "tier_adult");

    const args = vi.mocked(prisma.membershipTier.findFirst).mock.calls[0][0];
    const where = args?.where;
    // Both halves are load-bearing: the id alone would resolve another gym's
    // tier, and RLS will not stop it.
    expect(where).toMatchObject({ id: "tier_adult", tenantId: TENANT });
  });

  it("returns null for a tier that is not this gym's", async () => {
    vi.mocked(prisma.membershipTier.findFirst).mockResolvedValue(null as never);
    expect(await resolveMembershipTier(TENANT, "tier_of_another_gym")).toBeNull();
  });
});

describe("membershipTierWrite", () => {
  it("writes BOTH columns when a tier was resolved, label derived from the tier", () => {
    expect(membershipTierWrite(TIER)).toEqual({
      membershipTierId: "tier_adult",
      membershipType: "Adult Unlimited",
    });
  });

  it("detaches without touching the legacy label", () => {
    expect(membershipTierWrite(null)).toEqual({ membershipTierId: null });
  });

  it("leaves both columns alone when no tier field was sent", () => {
    expect(membershipTierWrite(undefined)).toEqual({});
  });

  // ── Seeding the first due date ─────────────────────────────────────────────
  // Overdue is derived from Member.nextDueAt (lib/overdue.ts). Without a first
  // date, a club's members are all null and nobody is ever seen as behind — the
  // derivation would be live and permanently silent.

  const NOW = new Date("2026-09-12T10:00:00Z");

  it("seeds a first due date when a member on a recurring tier has none", () => {
    const out = membershipTierWrite(TIER, { currentNextDueAt: null, now: NOW });
    expect(out.nextDueAt?.toISOString().slice(0, 10)).toBe("2026-10-12");
  });

  it("NEVER resets a schedule the member is already on", () => {
    // Changing someone's tier must not silently move a due date they are
    // already working to.
    const existing = new Date("2026-09-20T10:00:00Z");
    const out = membershipTierWrite(TIER, { currentNextDueAt: existing, now: NOW });
    expect(out.nextDueAt).toBeUndefined();
  });

  it("seeds nothing for a non-recurring tier", () => {
    const oneOff = { ...TIER, billingCycle: "none" };
    expect(membershipTierWrite(oneOff, { currentNextDueAt: null, now: NOW }).nextDueAt).toBeUndefined();
  });

  it("seeds nothing when the caller passes no date context", () => {
    // Callers that have not been taught about due dates must keep their old
    // behaviour exactly, rather than acquiring a side effect by accident.
    expect(membershipTierWrite(TIER)).toEqual({
      membershipTierId: "tier_adult",
      membershipType: "Adult Unlimited",
    });
  });

  it("detaching does not clear an existing due date", () => {
    // A member who owes for last month still owes it; wiping the date on an
    // unrelated edit would erase a debt rather than settle it.
    expect(membershipTierWrite(null, { currentNextDueAt: new Date(), now: NOW })).toEqual({
      membershipTierId: null,
    });
  });
});

describe("POST /api/members", () => {
  it("persists the FK and the derived legacy label together", async () => {
    vi.mocked(prisma.membershipTier.findFirst).mockResolvedValue(TIER as never);
    vi.mocked(prisma.member.create).mockResolvedValue({ id: "mem_1", email: "sam@example.com" } as never);

    const { POST } = await import("@/app/api/members/route");
    const res = await POST(req({
      name: "Sam Carter",
      email: "sam@example.com",
      // A stale label from the client must NOT survive: the tier's own name
      // wins, or the two columns drift.
      membershipType: "Something Else",
      membershipTierId: "tier_adult",
    }));

    expect(res.status).toBeLessThan(400);
    const data = vi.mocked(prisma.member.create).mock.calls[0][0].data;
    expect(data.membershipTierId).toBe("tier_adult");
    expect(data.membershipType).toBe("Adult Unlimited");
    expect(data.tenantId).toBe(TENANT);
  });

  it("refuses a tier id that belongs to another gym, and writes nothing", async () => {
    vi.mocked(prisma.membershipTier.findFirst).mockResolvedValue(null as never);

    const { POST } = await import("@/app/api/members/route");
    const res = await POST(req({
      name: "Sam Carter",
      email: "sam@example.com",
      membershipTierId: "tier_of_another_gym",
    }));

    expect(res.status).toBe(400);
    expect(prisma.member.create).not.toHaveBeenCalled();
  });

  it("leaves the legacy-only path untouched when no tier is sent", async () => {
    vi.mocked(prisma.member.create).mockResolvedValue({ id: "mem_2", email: "leo@example.com" } as never);

    const { POST } = await import("@/app/api/members/route");
    await POST(req({ name: "Leo", email: "leo@example.com", membershipType: "Legacy Plan" }));

    expect(prisma.membershipTier.findFirst).not.toHaveBeenCalled();
    const data = vi.mocked(prisma.member.create).mock.calls[0][0].data;
    expect(data.membershipType).toBe("Legacy Plan");
    expect(data.membershipTierId).toBeUndefined();
  });
});
