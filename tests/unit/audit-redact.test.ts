/**
 * lib/audit-redact.ts — a member's erasure redacts the personal values in their own Activity rows' metadata
 * (6 Nov 2026: Activity is kept permanently, so the erasure must reach it).
 */
import { describe, it, expect, vi } from "vitest";
import { redactAuditMetadata, redactSubjectFromAuditLog } from "@/lib/audit-redact";

describe("redactAuditMetadata", () => {
  it("keeps every changed field's name and nulls its values; keeps everything that is not personal", () => {
    const meta = {
      fields: ["name", "phone"],
      source: "staff",
      changes: { name: { from: "Ada Obi", to: "Ada Obi-Ray" }, phone: { from: "07700 900111", to: "07700 900222" }, dateOfBirth: { from: "1990-01-02", to: "1990-01-03" } },
      oldEmailSha256: "abc",
    };
    expect(redactAuditMetadata(meta)).toEqual({
      fields: ["name", "phone"],
      source: "staff",
      changes: { name: { from: null, to: null }, phone: { from: null, to: null }, dateOfBirth: { from: null, to: null } },
      oldEmailSha256: "abc",
      redactedForErasure: true,
    });
  });

  it("nulls a restore's before/after values and the name/email/phone keys", () => {
    expect(redactAuditMetadata({ before: { name: "Ada Obi", status: "active" }, name: "Ada Obi", email: "ada@example.test", reason: "r" })).toEqual({
      before: { name: null, status: null },
      name: null,
      email: null,
      reason: "r",
      redactedForErasure: true,
    });
  });

  it("returns null when there is nothing personal, or the row was already redacted", () => {
    expect(redactAuditMetadata({ fields: ["status"], classInstanceId: "s1" })).toBeNull();
    expect(redactAuditMetadata({ changes: { phone: { from: null, to: null } }, redactedForErasure: true })).toBeNull();
    expect(redactAuditMetadata(null)).toBeNull();
  });
});

describe("redactSubjectFromAuditLog", () => {
  it("reads only this club's rows about the member, writes metadata only, and counts without writing in a dry run", async () => {
    const rows = [
      { id: "a1", metadata: { changes: { phone: { from: "07700 900111", to: "07700 900222" } } } },
      { id: "a2", metadata: { classInstanceId: "s1", memberId: "m1" } },
    ];
    const tx = { auditLog: { findMany: vi.fn(async () => rows), updateMany: vi.fn(async () => ({ count: 1 })) } };
    expect(await redactSubjectFromAuditLog(tx as never, "t1", "m1", { dryRun: true })).toBe(1);
    expect(tx.auditLog.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.findMany).toHaveBeenCalledWith({
      where: { tenantId: "t1", OR: [{ entityId: "m1" }, { metadata: { path: ["memberId"], equals: "m1" } }, { metadata: { path: ["childId"], equals: "m1" } }] },
      select: { id: true, metadata: true },
    });
    expect(await redactSubjectFromAuditLog(tx as never, "t1", "m1")).toBe(1);
    expect(tx.auditLog.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.updateMany).toHaveBeenCalledWith({
      where: { id: "a1", tenantId: "t1" },
      data: { metadata: { changes: { phone: { from: null, to: null } }, redactedForErasure: true } },
    });
  });
});
