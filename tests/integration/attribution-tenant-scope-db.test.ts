// Attribution FK ids must stay inside the tenant (reviewer A-1, 2026-11-02).
//
// A staff writer of tenant A must not be able to store a trialRunById /
// creditedToUserId (a User) or creditedToMemberId (a Member) that belongs to
// tenant B, on create or on update. The property is state, not status code:
// after a rejected call the row must carry NO foreign FK. Positive cases prove
// a legitimate in-tenant id still works, so the guard is not over-broad.
//
// Synthetic clubs only; removed in afterAll. Skips without a DB. Run with both
// TEST-branch runners (owner role and restricted matflow_app role).

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }),
  },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/rate-limit", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/rate-limit")>();
  return { ...mod, checkRateLimit: vi.fn(async () => ({ allowed: true, remaining: 99, retryAfterSeconds: 0 })) };
});
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => ({ ok: false, logId: "mail-dark" })) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));
const gate = { tenantId: "", userId: "" };
vi.mock("@/lib/api-authz", () => ({
  requireApiOwnerOrManager: vi.fn(async () => ({ ok: true, tenantId: gate.tenantId, userId: gate.userId, session: { user: { id: gate.userId, tenantId: gate.tenantId, role: "owner" } } })),
  requireApiOwner: vi.fn(async () => ({ ok: true, tenantId: gate.tenantId, userId: gate.userId, session: { user: { id: gate.userId, tenantId: gate.tenantId, role: "owner" } } })),
}));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as createMember } from "@/app/api/members/route";
import { PATCH as patchMember } from "@/app/api/members/[id]/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = `attr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const tenantIds: string[] = [];

type Club = { tenantId: string; ownerId: string; coachId: string; memberId: string };
async function mkClub(label: string): Promise<Club> {
  return withRlsBypass(async (tx) => {
    const t = await tx.tenant.create({ data: { name: `${STAMP} ${label}`, slug: `${STAMP}-${label}`, onboardingCompleted: true } });
    tenantIds.push(t.id);
    const owner = await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-${label}-owner@example.test`, name: "Owner", role: "owner", passwordHash: "x" } });
    const coach = await tx.user.create({ data: { tenantId: t.id, email: `${STAMP}-${label}-coach@example.test`, name: "Coach", role: "coach", passwordHash: "x" } });
    const member = await tx.member.create({ data: { tenantId: t.id, name: `${label} Member`, email: `${STAMP}-${label}-m@example.test` } });
    return { tenantId: t.id, ownerId: owner.id, coachId: coach.id, memberId: member.id };
  });
}

function asOwner(c: Club) {
  mockAuth.mockResolvedValue({ user: { id: c.ownerId, tenantId: c.tenantId, role: "owner", email: "owner" } } as never);
  gate.tenantId = c.tenantId;
  gate.userId = c.ownerId;
}
function post(body: unknown): Request {
  return new Request("https://test.local/api/members", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify(body),
  });
}
function patch(body: unknown): Request {
  return new Request("https://test.local/api/members/x", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify(body),
  });
}
const params = (id: string) => ({ params: Promise.resolve({ id }) });
type Res = { status: number; json: () => Promise<unknown> };

const memberRow = (id: string) =>
  withRlsBypass((tx) => tx.member.findUnique({ where: { id }, select: { trialRunById: true, creditedToUserId: true, creditedToMemberId: true } }));

describe.skipIf(!HAS_DB)("attribution FK ids stay inside the tenant", () => {
  let a: Club;
  let b: Club;

  beforeAll(async () => {
    a = await mkClub("a");
    b = await mkClub("b");
  });

  afterAll(async () => {
    // Minimal fixtures (no attendance/packs/stripe): clear members then users
    // then the tenants, by tenant id. SetNull FKs make member order irrelevant.
    for (const id of tenantIds) {
      await withRlsBypass(async (tx) => {
        await tx.member.updateMany({ where: { tenantId: id }, data: { creditedToMemberId: null } });
        await tx.member.deleteMany({ where: { tenantId: id } });
        await tx.user.deleteMany({ where: { tenantId: id } });
        await tx.tenant.deleteMany({ where: { id } });
      });
    }
  });

  it("rejects CREATE with a cross-tenant creditedToMemberId and writes no such member", async () => {
    asOwner(a);
    const res = (await createMember(post({ name: `${STAMP} x1`, status: "taster", creditedToMemberId: b.memberId }))) as Res;
    expect(res.status).toBe(400);
    const leaked = await withRlsBypass((tx) => tx.member.count({ where: { tenantId: a.tenantId, creditedToMemberId: b.memberId } }));
    expect(leaked).toBe(0);
  });

  it("rejects CREATE with a cross-tenant trialRunById (another club's coach)", async () => {
    asOwner(a);
    const res = (await createMember(post({ name: `${STAMP} x2`, status: "taster", trialRunById: b.coachId }))) as Res;
    expect(res.status).toBe(400);
    const leaked = await withRlsBypass((tx) => tx.member.count({ where: { tenantId: a.tenantId, trialRunById: b.coachId } }));
    expect(leaked).toBe(0);
  });

  it("accepts CREATE with an in-tenant creditedToMemberId and stores it", async () => {
    asOwner(a);
    const res = (await createMember(post({ name: `${STAMP} ok`, status: "taster", creditedToMemberId: a.memberId }))) as Res;
    expect(res.status).toBeLessThan(400);
    const body = (await res.json()) as { id: string };
    expect((await memberRow(body.id))?.creditedToMemberId).toBe(a.memberId);
  });

  it("rejects PATCH that sets a cross-tenant trialRunById and leaves the FK unchanged", async () => {
    // A real member in A with no attribution yet.
    const target = await withRlsBypass((tx) => tx.member.create({ data: { tenantId: a.tenantId, name: `${STAMP} tgt`, email: `${STAMP}-tgt@example.test` } }));
    asOwner(a);
    const res = (await patchMember(patch({ trialRunById: b.coachId }), params(target.id))) as Res;
    expect(res.status).toBe(400);
    expect((await memberRow(target.id))?.trialRunById).toBeNull();
  });

  it("accepts PATCH that sets an in-tenant trialRunById", async () => {
    const target = await withRlsBypass((tx) => tx.member.create({ data: { tenantId: a.tenantId, name: `${STAMP} tgt2`, email: `${STAMP}-tgt2@example.test` } }));
    asOwner(a);
    const res = (await patchMember(patch({ trialRunById: a.coachId }), params(target.id))) as Res;
    expect(res.status).toBeLessThan(400);
    expect((await memberRow(target.id))?.trialRunById).toBe(a.coachId);
  });
});
