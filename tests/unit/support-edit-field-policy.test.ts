/**
 * Edit-session field policy (external review, 13 Oct 2026).
 *
 * PR #31's route-level allowlist admitted three endpoints whose handlers reach
 * beyond "routine": member PATCH (status → live Stripe cancellation,
 * paymentStatus, membership, email), member POST (confirmed guardian link,
 * invite-token minting) and settings PATCH (payment rail, self-billing,
 * billing/privacy contacts, waiver content). This file pins the fix:
 * refuseSupportEditFields checks RAW body keys against
 * SUPPORT_EDIT_FIELD_POLICY before any parsing, mutation or provider call, and
 * a mixed request never partially applies. Reproduced failing on c0580ea
 * (see scratchpad ledger), green on the candidate.
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
vi.mock("next/cache", () => ({ revalidateTag: vi.fn() }));

const m = vi.hoisted(() => ({
  memberFindFirst: vi.fn(async () => null as unknown),
  memberFindMany: vi.fn(async () => []),
  memberCount: vi.fn(async () => 0),
  memberCreate: vi.fn(async () => ({ id: "m-new" })),
  memberUpdateMany: vi.fn(async () => ({ count: 1 })),
  magicLinkCreate: vi.fn(async () => ({})),
  tenantFindUnique: vi.fn(async () => ({ name: "Club", stripeAccountId: null })),
  tenantUpdateMany: vi.fn(async () => ({ count: 1 })),
  tenantUpdate: vi.fn(async () => ({})),
  stripeCancel: vi.fn(async () => ({ ok: true, cancelAt: null })),
  mintToken: vi.fn(() => "tok"),
  sendEmail: vi.fn(async () => ({ ok: true })),
  logAudit: vi.fn(async () => {}),
}));

vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: async <T,>(_t: string, fn: (tx: unknown) => Promise<T>): Promise<T> =>
    fn({
      member: { findFirst: m.memberFindFirst, findMany: m.memberFindMany, count: m.memberCount, create: m.memberCreate, updateMany: m.memberUpdateMany },
      magicLinkToken: { create: m.magicLinkCreate, updateMany: vi.fn() },
      tenant: { findUnique: m.tenantFindUnique, updateMany: m.tenantUpdateMany, update: m.tenantUpdate },
      memberStatusEvent: { create: vi.fn(async () => ({ id: "evt" })) },
      $queryRaw: vi.fn(async () => []),
      $executeRaw: vi.fn(async () => 0),
    }),
  withRlsBypass: vi.fn(),
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));
vi.mock("@/lib/audit-log", () => ({ logAudit: m.logAudit }));
vi.mock("@/lib/audit-snapshot", () => ({ updateMetadata: vi.fn(async () => ({})) }));
vi.mock("@/lib/email", () => ({ sendEmail: m.sendEmail }));
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit: vi.fn(async () => ({ allowed: true, retryAfterSeconds: 0 })),
  getClientIp: () => "203.0.113.9",
}));
vi.mock("@/lib/membership-tier", () => ({
  resolveMembershipTier: vi.fn(async () => null),
  membershipTierWrite: () => ({}),
}));
vi.mock("@/lib/stripe/subscriptions", () => ({ cancelSubscriptionAtPeriodEnd: m.stripeCancel }));
vi.mock("@/lib/auth-token-binding", () => ({ mintSubjectBoundToken: m.mintToken }));
vi.mock("@/lib/api-authz", () => ({
  requireApiOwner: vi.fn(async () => ({ ok: true, tenantId: "t-A", userId: "u1" })),
  requireApiOwnerOrManager: vi.fn(async () => ({ ok: true, tenantId: "t-A", userId: "u1" })),
}));
vi.mock("@/lib/login-email", () => ({
  LoginIdentityTaken: class LoginIdentityTaken extends Error {},
  claimLoginIdentity: vi.fn(async () => ({ kind: "none" })),
  emailDigest: vi.fn(() => "digest"),
  retireEmailBoundTokens: vi.fn(async () => {}),
}));

import { PATCH as memberPatch } from "@/app/api/members/[id]/route";
import { POST as memberPost } from "@/app/api/members/route";
import { PATCH as settingsPatch } from "@/app/api/settings/route";
import { auth } from "@/auth";
import {
  refuseSupportEditFields,
  SUPPORT_EDIT_FIELD_POLICY,
} from "@/lib/support-session";
import { memberUpdateSchema, memberCreateSchema } from "@/lib/schemas/member";

const mockAuth = vi.mocked(auth);

const baseUser = { id: "u-owner", tenantId: "t-A", role: "owner", email: "o@x.test", name: "O" };
const editSession = { user: { ...baseUser, impersonatedBy: "op_1", supportScope: "edit" } };
const viewSession = { user: { ...baseUser, impersonatedBy: "op_1", supportScope: "view" } };
const ownerSession = { user: baseUser };

function req(url: string, body: unknown): Request {
  return {
    url,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Request;
}
const params = { params: Promise.resolve({ id: "m-1" }) };

function noWrites() {
  expect(m.memberUpdateMany).not.toHaveBeenCalled();
  expect(m.memberCreate).not.toHaveBeenCalled();
  expect(m.tenantUpdateMany).not.toHaveBeenCalled();
  expect(m.tenantUpdate).not.toHaveBeenCalled();
  expect(m.stripeCancel).not.toHaveBeenCalled();
  expect(m.mintToken).not.toHaveBeenCalled();
  expect(m.magicLinkCreate).not.toHaveBeenCalled();
  expect(m.sendEmail).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── The helper itself ───────────────────────────────────────────────────────

describe("refuseSupportEditFields semantics", () => {
  const allowed = ["name", "phone"] as const;

  it("non-support sessions pass through untouched", () => {
    expect(refuseSupportEditFields(ownerSession, { status: "cancelled" }, allowed)).toBeNull();
    expect(refuseSupportEditFields(null, { status: "cancelled" }, allowed)).toBeNull();
  });

  it("a view session is refused before any field check", async () => {
    const r = refuseSupportEditFields(viewSession, { name: "x" }, allowed);
    expect(r).not.toBeNull();
    expect(r!.status).toBe(403);
  });

  it("edit scope: allowed keys pass, any prohibited key refuses the whole body", async () => {
    expect(refuseSupportEditFields(editSession, { name: "x", phone: "1" }, allowed)).toBeNull();
    const alone = refuseSupportEditFields(editSession, { status: "cancelled" }, allowed);
    expect(alone!.status).toBe(403);
    const mixed = refuseSupportEditFields(editSession, { name: "x", status: "cancelled" }, allowed);
    expect(mixed!.status).toBe(403);
    const body = await mixed!.json() as { refusedFields: string[]; error: string };
    expect(body.refusedFields).toEqual(["status"]);
    expect(body.error).toContain("stays with the club owner");
  });

  it("unknown, nested and non-object bodies refuse by construction", () => {
    expect(refuseSupportEditFields(editSession, { nested: { status: "x" } }, allowed)!.status).toBe(403);
    expect(refuseSupportEditFields(editSession, { __proto__x: 1 }, allowed)!.status).toBe(403);
    expect(refuseSupportEditFields(editSession, [1, 2], allowed)!.status).toBe(403);
    expect(refuseSupportEditFields(editSession, "str", allowed)!.status).toBe(403);
    expect(refuseSupportEditFields(editSession, null, allowed)!.status).toBe(403);
  });

  it("empty body passes (no prohibited key present)", () => {
    expect(refuseSupportEditFields(editSession, {}, allowed)).toBeNull();
  });
});

// ─── Completeness ratchet: every schema field is classified ─────────────────

describe("field classification covers the whole schema (ratchet)", () => {
  const REFUSED = {
    "member.update": [
      "email", "status", "paymentStatus", "membershipType", "membershipTierId",
      "trialRunById", "creditedToUserId", "creditedToMemberId", "creditedToLabel",
    ],
    "member.create": [
      "parentMemberId", "accountType",
      "trialRunById", "creditedToUserId", "creditedToMemberId", "creditedToLabel",
    ],
  };

  function schemaKeys(schema: unknown): string[] {
    // Both member schemas are z.object(...).refine(...) — the inner object
    // carries the shape.
    const def = (schema as { _def?: { schema?: unknown } })._def;
    const inner = (def?.schema ?? schema) as { shape?: Record<string, unknown> };
    return Object.keys(inner.shape ?? {});
  }

  it("member.update: allowed ∪ refused = memberUpdateSchema keys, disjoint", () => {
    const allowed = [...SUPPORT_EDIT_FIELD_POLICY["member.update"]];
    const refused = REFUSED["member.update"];
    expect(allowed.filter((k) => refused.includes(k))).toEqual([]);
    expect([...allowed, ...refused].sort()).toEqual(schemaKeys(memberUpdateSchema).sort());
  });

  it("member.create: allowed ∪ refused = memberCreateSchema keys, disjoint", () => {
    const allowed = [...SUPPORT_EDIT_FIELD_POLICY["member.create"]];
    const refused = REFUSED["member.create"];
    expect(allowed.filter((k) => refused.includes(k))).toEqual([]);
    expect([...allowed, ...refused].sort()).toEqual(schemaKeys(memberCreateSchema).sort());
  });

  it("settings.update: every allowed key exists in the settings schema, and the money/legal keys are not allowed", async () => {
    // The settings updateSchema is file-local; pin the refused families by
    // name. If a field is renamed this fails and the classification must be
    // revisited.
    const allowed = SUPPORT_EDIT_FIELD_POLICY["settings.update"] as readonly string[];
    for (const k of [
      "paymentRail", "acceptsBacs", "memberSelfBilling",
      "billingContactEmail", "billingContactUrl", "contactEmail",
      "privacyContactEmail", "privacyPolicyUrl",
      "waiverTitle", "waiverContent", "kidsWaiverTitle", "kidsWaiverContent",
      "onboardingCompleted", "onboardingAnswers",
    ]) {
      expect(allowed, `${k} must stay refused`).not.toContain(k);
    }
  });
});

// ─── Route-level: the three bypass paths are closed ─────────────────────────

describe("F1 — PATCH /api/members/[id] under an edit session", () => {
  it("status=cancelled alone → 403, no Stripe call, no write", async () => {
    mockAuth.mockResolvedValue(editSession as never);
    const res = await memberPatch(req("https://x/api/members/m-1", { status: "cancelled" }), params);
    expect(res.status).toBe(403);
    noWrites();
  });

  it("prohibited field mixed with a legitimate edit → 403, NOTHING applied", async () => {
    mockAuth.mockResolvedValue(editSession as never);
    const res = await memberPatch(req("https://x/api/members/m-1", { name: "New Name", paymentStatus: "free" }), params);
    expect(res.status).toBe(403);
    noWrites();
  });

  it("email and membership changes refuse", async () => {
    mockAuth.mockResolvedValue(editSession as never);
    for (const body of [{ email: "new@x.test" }, { membershipTierId: "tier-1" }, { membershipType: "Unlimited" }, { creditedToUserId: "u2" }]) {
      const res = await memberPatch(req("https://x/api/members/m-1", body), params);
      expect(res.status, JSON.stringify(body)).toBe(403);
    }
    noWrites();
  });

  it("totp keys smuggled in the raw body refuse (checked before stripTotpFields)", async () => {
    mockAuth.mockResolvedValue(editSession as never);
    const res = await memberPatch(req("https://x/api/members/m-1", { name: "x", totpEnabled: false }), params);
    expect(res.status).toBe(403);
    noWrites();
  });

  it("an ordinary owner session still changes status (behaviour preserved)", async () => {
    mockAuth.mockResolvedValue(ownerSession as never);
    m.memberFindFirst.mockResolvedValueOnce({ email: "a@x.test", status: "active", stripeSubscriptionId: null } as never);
    const res = await memberPatch(req("https://x/api/members/m-1", { status: "inactive" }), params);
    expect([200, 404, 409]).toContain(res.status); // guard passed; outcome owned by route logic
    expect(m.memberFindFirst).toHaveBeenCalled();
  });
});

describe("F2 — POST /api/members under an edit session", () => {
  it("parentMemberId alone → 403, no member created, no guardian link", async () => {
    mockAuth.mockResolvedValue(editSession as never);
    const res = await memberPost(req("https://x/api/members", { name: "Kid", parentMemberId: "m-parent" }));
    expect(res.status).toBe(403);
    noWrites();
  });

  it("accountType is refused (kid/guardian creation denied outright)", async () => {
    mockAuth.mockResolvedValue(editSession as never);
    const res = await memberPost(req("https://x/api/members", { name: "Kid", accountType: "kids" }));
    expect(res.status).toBe(403);
    noWrites();
  });

  it("adult create with a real email: created, but NO token minted, NO MagicLinkToken row, NO email, inviteUrl null", async () => {
    mockAuth.mockResolvedValue(editSession as never);
    m.memberFindFirst.mockResolvedValue(null as never); // no replay, no duplicate
    const res = await memberPost(req("https://x/api/members", { name: "Alex Adult", email: "alex@example.test" }));
    expect([200, 201]).toContain(res.status);
    const body = await res.json() as { inviteUrl: string | null; inviteEmailNote?: string | null };
    expect(body.inviteUrl).toBeNull();
    expect(body.inviteEmailNote ?? "").toContain("owner can invite");
    expect(m.memberCreate).toHaveBeenCalledTimes(1);
    expect(m.mintToken).not.toHaveBeenCalled();
    expect(m.magicLinkCreate).not.toHaveBeenCalled();
    expect(m.sendEmail).not.toHaveBeenCalled();
  });

  it("an ordinary owner session still mints the invite (behaviour preserved)", async () => {
    mockAuth.mockResolvedValue(ownerSession as never);
    m.memberFindFirst.mockResolvedValue(null as never);
    const res = await memberPost(req("https://x/api/members", { name: "Beth Adult", email: "beth@example.test" }));
    expect([200, 201]).toContain(res.status);
    expect(m.mintToken).toHaveBeenCalledTimes(1);
    expect(m.magicLinkCreate).toHaveBeenCalledTimes(1);
  });
});

describe("F3 — PATCH /api/settings under an edit session", () => {
  it("paymentRail / memberSelfBilling / waiverContent / contactEmail refuse, alone and mixed", async () => {
    mockAuth.mockResolvedValue(editSession as never);
    for (const body of [
      { paymentRail: "stripe" },
      { memberSelfBilling: true },
      { waiverContent: "new legal text" },
      { contactEmail: "mallory@x.test" },
      { name: "Nice Club", acceptsBacs: true }, // mixed
    ]) {
      const res = await settingsPatch(req("https://x/api/settings", body));
      expect(res.status, JSON.stringify(body)).toBe(403);
    }
    noWrites();
  });

  it("branding-only body passes the guard", async () => {
    mockAuth.mockResolvedValue(editSession as never);
    const res = await settingsPatch(req("https://x/api/settings", { name: "Nice Club", primaryColor: "#112233" }));
    expect(res.status).not.toBe(403);
  });

  it("an ordinary owner session still changes paymentRail (behaviour preserved)", async () => {
    mockAuth.mockResolvedValue(ownerSession as never);
    const res = await settingsPatch(req("https://x/api/settings", { paymentRail: "pay_at_desk" }));
    expect(res.status).not.toBe(403);
  });
});
