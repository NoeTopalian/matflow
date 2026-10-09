/**
 * Security lane D (9 Oct 2026, fifth pass, R REPORT-D4): guardian confirm with adoptUnverifiedEmail changes the
 * PARENT's login address, so it must write an address-change row on the PARENT (entityType Member, entityId =
 * parent, oldEmailSha256 / newEmailSha256) in the same transaction, besides the child's member.guardian.confirmed
 * row. The attendance import reads that row as the parent's own address change (SF-67).
 */
import { vi, describe, it, expect, beforeEach } from "vitest";
import { addLoginClaimSql } from "./login-claim-fake";

vi.mock("next/server", () => ({
  NextResponse: { json: (body: unknown, init?: { status?: number }) => ({ status: init?.status ?? 200, json: async () => body, headers: new Headers() }) },
}));
vi.mock("@/lib/csrf", () => ({ assertSameOrigin: vi.fn(() => null) }));
const { logAuditMock, memberFindFirst, memberUpdate, memberUpdateMany } = vi.hoisted(() => ({
  logAuditMock: vi.fn(async () => {}),
  memberFindFirst: vi.fn(),
  memberUpdate: vi.fn().mockResolvedValue({}),
  memberUpdateMany: vi.fn().mockResolvedValue({ count: 1 }),
}));
vi.mock("@/lib/audit-log", () => ({ logAudit: logAuditMock }));
vi.mock("@/lib/api-authz", () => ({ requireApiOwnerOrManager: vi.fn(async () => ({ ok: true, tenantId: "t1", userId: "u-owner", role: "owner" })) }));
vi.mock("@/lib/prisma-tenant", () => ({
  withTenantContext: (_t: string, fn: (tx: unknown) => unknown) =>
    Promise.resolve(fn(addLoginClaimSql({ member: { findFirst: memberFindFirst, update: memberUpdate, updateMany: memberUpdateMany } }))),
}));

import { emailDigest } from "@/lib/login-email";

const req = (body: unknown) =>
  new Request("http://localhost/api/members/k1/guardian", { method: "POST", headers: { "Content-Type": "application/json", origin: "http://localhost" }, body: JSON.stringify(body) });
const params = { params: Promise.resolve({ id: "k1" }) };
const kid = { id: "k1", name: "Kit", accountType: "junior", parentMemberId: "p1", guardianConfirmedAt: null, guardianSuggestedBy: "emergency_contact" };
const parent = { id: "p1", name: "Pat", email: "adult-abc@no-login.matflow.local", unverifiedEmail: "pat@example.test", accountType: "parent" };

beforeEach(() => { vi.clearAllMocks(); memberUpdateMany.mockResolvedValue({ count: 1 }); });

describe("SF-67 guardian adoption records the parent's address change", () => {
  it("adopting writes a parent-subject member.update row with oldEmailSha256/newEmailSha256, inside the transaction, and keeps the child row", async () => {
    memberFindFirst.mockResolvedValueOnce(kid).mockResolvedValueOnce(parent).mockResolvedValueOnce(null);
    const { POST } = await import("@/app/api/members/[id]/guardian/route");
    const res = await POST(req({ action: "confirm", adoptUnverifiedEmail: true }) as never, params);
    expect(res.status).toBe(200);
    const calls = logAuditMock.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);
    const parentRow = calls.find((c) => c.entityId === "p1");
    expect(parentRow).toMatchObject({ action: "member.update", entityType: "Member", entityId: "p1", tenantId: "t1" });
    expect(parentRow?.tx, "written in the adoption's transaction").toBeTruthy();
    expect(parentRow?.metadata).toMatchObject({ oldEmailSha256: emailDigest(parent.email), newEmailSha256: emailDigest(parent.unverifiedEmail) });
    expect(calls.find((c) => c.entityId === "k1")).toMatchObject({ action: "member.guardian.confirmed", metadata: expect.objectContaining({ emailAdopted: true, parentMemberId: "p1" }) });
  });

  it("confirm WITHOUT adoption writes no parent address row (control)", async () => {
    memberFindFirst.mockResolvedValueOnce(kid).mockResolvedValueOnce(parent);
    const { POST } = await import("@/app/api/members/[id]/guardian/route");
    expect((await POST(req({ action: "confirm" }) as never, params)).status).toBe(200);
    const calls = logAuditMock.mock.calls.map((c) => (c as unknown[])[0] as Record<string, unknown>);
    expect(calls.some((c) => c.entityId === "p1")).toBe(false);
  });
});

describe("SF-67 the importer reads every own-address-change format", () => {
  it("old-format { changes: { email } } rows and guardian-adoption rows (parent resolved from parentMemberId) are read", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("lib/attendance-import.ts", "utf8");
    expect(src).toContain("metadata->'changes'->'email' IS NOT NULL");
    expect(src).toContain("action = 'member.guardian.confirmed' AND metadata->>'emailAdopted' = 'true'");
    expect(src).toMatch(/md\.emailAdopted === true[\s\S]{0,120}md\.parentMemberId/);
  });
});
