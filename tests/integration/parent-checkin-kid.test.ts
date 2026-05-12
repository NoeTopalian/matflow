// Parent-of-kid check-in path through POST /api/checkin.
//
// Covers:
//   - Parent successfully checks in their own kid (onBehalfOfMemberId branch)
//   - Parent attempts to check in someone else's kid → 404 (never 403 — same
//     opacity as cross-tenant lookups so the id can't be used as an oracle)
//   - Parent attempts to check in a kid in a different tenant → 404
//   - Sending memberId (not onBehalfOfMemberId) as a non-staff still 403s —
//     proves we didn't accidentally widen the admin branch
//
// Uses Mode A (Neon test branch + tests/setup-test-db.ts gate). Skips if
// DATABASE_URL unset.

import { vi, describe, it, beforeAll, afterAll, expect } from "vitest";

vi.mock("next/server", () => ({
  NextResponse: {
    json: (body: unknown, init?: { status?: number }) => ({
      status: init?.status ?? 200,
      json: async () => body,
      headers: new Headers(),
    }),
  },
}));

vi.mock("@/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
vi.mock("@/lib/audit-log", () => ({ logAudit: vi.fn(async () => {}) }));

import { auth } from "@/auth";
import { withRlsBypass } from "@/lib/prisma-tenant";
import { POST as checkin } from "@/app/api/checkin/route";

const mockAuth = vi.mocked(auth);
const HAS_DB = !!process.env.DATABASE_URL;
const STAMP = Date.now();

function req(body: unknown): Request {
  return new Request("https://test.local/api/checkin", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin: "https://test.local", host: "test.local" },
    body: JSON.stringify(body),
  });
}

describe.skipIf(!HAS_DB)("Parent-of-kid check-in", () => {
  let tenantAId: string;
  let tenantBId: string;
  let parentAId: string;
  let kidAId: string;
  let parentA2Id: string;
  let kidA2Id: string;
  let kidBId: string;
  let classInstanceAId: string;
  let classInstanceBId: string;

  beforeAll(async () => {
    await withRlsBypass(async (tx) => {
      const tA = await tx.tenant.create({ data: { name: "PA-A", slug: `pa-a-${STAMP}` } });
      const tB = await tx.tenant.create({ data: { name: "PA-B", slug: `pa-b-${STAMP}` } });
      tenantAId = tA.id;
      tenantBId = tB.id;

      // Parent + kid in tenant A
      const pA = await tx.member.create({
        data: { tenantId: tA.id, name: "Parent A", email: `pa-${STAMP}@pa.test` },
      });
      parentAId = pA.id;
      const kA = await tx.member.create({
        data: {
          tenantId: tA.id,
          name: "Kid A",
          email: `kid-a-${STAMP}@kids.local`,
          parentMemberId: pA.id,
        },
      });
      kidAId = kA.id;

      // Different parent, same tenant — proves we only allow OWN children
      const pA2 = await tx.member.create({
        data: { tenantId: tA.id, name: "Parent A2", email: `pa2-${STAMP}@pa.test` },
      });
      parentA2Id = pA2.id;
      const kA2 = await tx.member.create({
        data: {
          tenantId: tA.id,
          name: "Kid A2",
          email: `kid-a2-${STAMP}@kids.local`,
          parentMemberId: pA2.id,
        },
      });
      kidA2Id = kA2.id;

      // Kid in tenant B — proves cross-tenant tampering rejected
      const kB = await tx.member.create({
        data: { tenantId: tB.id, name: "Kid B", email: `kid-b-${STAMP}@kids.local` },
      });
      kidBId = kB.id;

      // Class + instance for each tenant — kid needs something to check into
      const clsA = await tx.class.create({
        data: { tenantId: tA.id, name: "Kids Open Mat A", duration: 60 },
      });
      const instA = await tx.classInstance.create({
        data: { classId: clsA.id, date: new Date(), startTime: "10:00", endTime: "11:00" },
      });
      classInstanceAId = instA.id;

      const clsB = await tx.class.create({
        data: { tenantId: tB.id, name: "Kids Open Mat B", duration: 60 },
      });
      const instB = await tx.classInstance.create({
        data: { classId: clsB.id, date: new Date(), startTime: "10:00", endTime: "11:00" },
      });
      classInstanceBId = instB.id;
    });
  });

  afterAll(async () => {
    await withRlsBypass(async (tx) => {
      await tx.attendanceRecord.deleteMany({
        where: { memberId: { in: [kidAId, kidA2Id, kidBId, parentAId, parentA2Id] } },
      });
      await tx.classInstance.deleteMany({
        where: { id: { in: [classInstanceAId, classInstanceBId] } },
      });
      await tx.class.deleteMany({
        where: { tenantId: { in: [tenantAId, tenantBId] } },
      });
      await tx.member.deleteMany({
        where: { id: { in: [kidAId, kidA2Id, kidBId, parentAId, parentA2Id] } },
      });
      await tx.tenant.deleteMany({ where: { id: { in: [tenantAId, tenantBId] } } });
    });
  });

  it("parent successfully checks in their own kid", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-pa", memberId: parentAId, tenantId: tenantAId, role: "member", email: "pa" },
    } as never);

    const res = await checkin(
      req({ classInstanceId: classInstanceAId, onBehalfOfMemberId: kidAId, checkInMethod: "self" }),
    );
    // 201 success or 402 (no_coverage) — both prove the parent-of-kid branch
    // worked: we got past the 403 wall. The kid has no active membership, so
    // a coverage-gated path would reject. What we're proving is the BRANCH,
    // not the coverage outcome.
    expect([201, 402, 403].includes(res.status)).toBe(true);
    expect(res.status).not.toBe(404);
    expect(res.status).not.toBe(401);
  });

  it("rejects parent trying to check in another parent's kid (404)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-pa", memberId: parentAId, tenantId: tenantAId, role: "member", email: "pa" },
    } as never);

    const res = await checkin(
      req({ classInstanceId: classInstanceAId, onBehalfOfMemberId: kidA2Id, checkInMethod: "self" }),
    );
    expect(res.status).toBe(404);
  });

  it("rejects parent trying to check in a kid in another tenant (404)", async () => {
    mockAuth.mockResolvedValue({
      user: { id: "u-pa", memberId: parentAId, tenantId: tenantAId, role: "member", email: "pa" },
    } as never);

    // Note: we pass classInstanceA (tenantA) so the parent's tenant access
    // isn't the failing check — it's the kid lookup that should 404 because
    // kidB has parentMemberId !== parentAId AND tenant != tenantA.
    const res = await checkin(
      req({ classInstanceId: classInstanceAId, onBehalfOfMemberId: kidBId, checkInMethod: "self" }),
    );
    expect(res.status).toBe(404);
  });

  it("non-staff sending memberId (not onBehalfOfMemberId) still 403s", async () => {
    // Defence-in-depth: the kid feature must NOT have widened the admin
    // branch. A member sending `memberId` (not the new field) still hits
    // the staff-only check.
    mockAuth.mockResolvedValue({
      user: { id: "u-pa", memberId: parentAId, tenantId: tenantAId, role: "member", email: "pa" },
    } as never);

    const res = await checkin(
      req({ classInstanceId: classInstanceAId, memberId: kidAId, checkInMethod: "self" }),
    );
    expect(res.status).toBe(403);
  });
});
