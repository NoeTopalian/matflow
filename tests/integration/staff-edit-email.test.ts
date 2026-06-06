// PATCH /api/staff/[id] — email-edit path.
//
// Covers the four behavioural cases for the new editable-email feature:
//   1. Happy path — owner renames a coach's email; DB updated.
//   2. Cross-tenant collision is fine — same email exists in another tenant,
//      no conflict raised.
//   3. Same-tenant collision rejected with 409.
//   4. Patching only `email` does not also overwrite `name` (regression
//      guard for the partial-update zod allowlist).

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

// Lane 1 iter-1 CSRF-sweep follow-up: short-circuit the guard so test
// Requests (which carry no browser-set Origin header) don't 403.
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: () => null }));


vi.mock("next/server", () => ({
  NextResponse: { json: (b: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => b, headers: new Headers() }) },
}));
vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { PATCH as patchStaff } from "@/app/api/staff/[id]/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

function jsonReq(body: unknown): Request {
  return new Request("https://test.local/", {
    method: "PATCH",
    headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!HAS_DB)("PATCH /api/staff/[id] — editable email", () => {
  let tenantAId: string;
  let tenantBId: string;
  let ownerAId: string;
  let coachAId: string;
  let coachA2Id: string;
  let coachBId: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const tA = await tx.tenant.create({ data: { name: "SE-A", slug: `se-a-${STAMP}` } });
      const tB = await tx.tenant.create({ data: { name: "SE-B", slug: `se-b-${STAMP}` } });
      tenantAId = tA.id;
      tenantBId = tB.id;
      const ownerA = await tx.user.create({
        data: {
          tenantId: tA.id,
          email: `owner-${STAMP}@se.test`,
          passwordHash: "$2a$12$not-used",
          name: "Owner A",
          role: "owner",
        },
      });
      ownerAId = ownerA.id;
      // Coach we'll rename
      const coachA = await tx.user.create({
        data: {
          tenantId: tA.id,
          email: `coach-a-${STAMP}@se.test`,
          passwordHash: "x",
          name: "Coach A",
          role: "coach",
        },
      });
      coachAId = coachA.id;
      // Second coach in tenant A — used to test same-tenant collision
      const coachA2 = await tx.user.create({
        data: {
          tenantId: tA.id,
          email: `coach-a2-${STAMP}@se.test`,
          passwordHash: "x",
          name: "Coach A2",
          role: "coach",
        },
      });
      coachA2Id = coachA2.id;
      // Coach in tenant B with a colliding email — proves cross-tenant is fine
      const coachB = await tx.user.create({
        data: {
          tenantId: tB.id,
          email: `cross-${STAMP}@se.test`,
          passwordHash: "x",
          name: "Coach B",
          role: "coach",
        },
      });
      coachBId = coachB.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass((tx) =>
      tx.user.deleteMany({
        where: { id: { in: [ownerAId, coachAId, coachA2Id, coachBId] } },
      }),
    );
    await withRlsBypass((tx) =>
      tx.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } }),
    );
  });

  it("owner can rename a coach's email (happy path)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: ownerAId, tenantId: tenantAId, role: "owner", email: "owner-a" },
    } as never);

    const newEmail = `renamed-${STAMP}@se.test`;
    const res = await patchStaff(jsonReq({ email: newEmail }), {
      params: Promise.resolve({ id: coachAId }),
    });
    expect(res.status).toBe(200);

    const fresh = await withRlsBypass((tx) =>
      tx.user.findUnique({ where: { id: coachAId }, select: { email: true, name: true } }),
    );
    expect(fresh?.email).toBe(newEmail);
    // Patching only email must not also overwrite name (regression guard)
    expect(fresh?.name).toBe("Coach A");
  });

  it("cross-tenant email collision is allowed (different tenants can share)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: ownerAId, tenantId: tenantAId, role: "owner", email: "owner-a" },
    } as never);

    // Coach B in tenantB has `cross-${STAMP}@se.test`. Setting Coach A2 to
    // the same address must succeed because the unique key is composite
    // (tenantId, email), not email alone.
    const res = await patchStaff(jsonReq({ email: `cross-${STAMP}@se.test` }), {
      params: Promise.resolve({ id: coachA2Id }),
    });
    expect(res.status).toBe(200);

    const fresh = await withRlsBypass((tx) =>
      tx.user.findUnique({ where: { id: coachA2Id }, select: { email: true } }),
    );
    expect(fresh?.email).toBe(`cross-${STAMP}@se.test`);
  });

  it("same-tenant email collision returns 409", async () => {
    mockAuth.mockResolvedValue({
      user: { id: ownerAId, tenantId: tenantAId, role: "owner", email: "owner-a" },
    } as never);

    // Coach A is now `renamed-${STAMP}@se.test`. Try to set Coach A2 to that
    // same address — same tenant, must conflict.
    const res = await patchStaff(jsonReq({ email: `renamed-${STAMP}@se.test` }), {
      params: Promise.resolve({ id: coachA2Id }),
    });
    expect(res.status).toBe(409);

    // Row must be unchanged (still the cross- email from the previous test)
    const stillCross = await withRlsBypass((tx) =>
      tx.user.findUnique({ where: { id: coachA2Id }, select: { email: true } }),
    );
    expect(stillCross?.email).toBe(`cross-${STAMP}@se.test`);
  });

  it("patching ONLY name does not touch email (regression guard the other way)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: ownerAId, tenantId: tenantAId, role: "owner", email: "owner-a" },
    } as never);

    const res = await patchStaff(jsonReq({ name: "Coach A — Renamed" }), {
      params: Promise.resolve({ id: coachAId }),
    });
    expect(res.status).toBe(200);

    const fresh = await withRlsBypass((tx) =>
      tx.user.findUnique({ where: { id: coachAId }, select: { email: true, name: true } }),
    );
    expect(fresh?.name).toBe("Coach A — Renamed");
    expect(fresh?.email).toBe(`renamed-${STAMP}@se.test`);
  });
});
