/**
 * lib/audit-redact.ts — a member's erasure redacts the personal values in their own Activity rows' metadata
 * (6 Nov 2026: Activity is kept permanently, so the erasure must reach it).
 */
import { describe, it, expect, vi } from "vitest";
import { ERASED_ENTITY_ID, redactAuditMetadata, redactSubjectsFromAuditLog, type AddressRowDecision } from "@/lib/audit-redact";

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

describe("redactSubjectsFromAuditLog", () => {
  const byIdWhere = (ids: string[]) => ({
    tenantId: "t1",
    OR: [{ entityId: { in: ids } }, ...ids.flatMap((id) => [{ metadata: { path: ["memberId"], equals: id } }, { metadata: { path: ["childId"], equals: id } }])],
  });

  it("reads only this club's rows about the member, writes metadata only, and counts without writing in a dry run", async () => {
    const rows = [
      { id: "a1", metadata: { changes: { phone: { from: "07700 900111", to: "07700 900222" } } } },
      { id: "a2", metadata: { classInstanceId: "s1", memberId: "m1" } },
    ];
    const tx = { auditLog: { findMany: vi.fn(async () => rows), updateMany: vi.fn(async () => ({ count: 1 })) } };
    expect(await redactSubjectsFromAuditLog(tx as never, "t1", [{ memberId: "m1" }], { dryRun: true })).toBe(1);
    expect(tx.auditLog.updateMany).not.toHaveBeenCalled();
    expect(tx.auditLog.findMany).toHaveBeenCalledWith({ where: byIdWhere(["m1"]), select: { id: true, metadata: true } });
    expect(await redactSubjectsFromAuditLog(tx as never, "t1", [{ memberId: "m1" }])).toBe(1);
    expect(tx.auditLog.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.updateMany).toHaveBeenCalledWith({
      where: { id: "a1", tenantId: "t1" },
      data: { metadata: { changes: { phone: { from: null, to: null } }, redactedForErasure: true } },
    });
  });

  it("a kiosk row keyed by an address only the subject held is repointed to them; one another member also held gets the neutral \"erased\"; any other address is left", async () => {
    const byAddress = [
      { id: "k1", entityId: "Cara.Old@example.test", metadata: { signerName: "Cara Lee", method: "kiosk_waiver_link" } },
      { id: "k2", entityId: "ben@example.test", metadata: { signerName: "Ben Ray", method: "kiosk_waiver_link" } },
      { id: "k3", entityId: "cara@example.test", metadata: null },
      { id: "k4", entityId: "shared@example.test", metadata: { signerName: "Eve Earlier", method: "kiosk_waiver_link" } },
    ];
    const findMany = vi.fn(async (args: { where: { entityId?: unknown } }) => (args.where.entityId ? byAddress : []));
    const tx = { auditLog: { findMany, updateMany: vi.fn(async () => ({ count: 1 })) } };
    const decisions: Record<string, AddressRowDecision> = { "cara.old@example.test": "repoint", "cara@example.test": "repoint", "shared@example.test": "neutral" };
    const subjects = [{ memberId: "m1", addressRow: (a: string) => decisions[a.toLowerCase()] ?? null }];
    expect(await redactSubjectsFromAuditLog(tx as never, "t1", subjects, { dryRun: true })).toBe(3);
    expect(tx.auditLog.updateMany).not.toHaveBeenCalled();
    expect(findMany).toHaveBeenCalledWith({ where: { tenantId: "t1", entityId: { contains: "@" } }, select: { id: true, entityId: true, metadata: true } });
    expect(await redactSubjectsFromAuditLog(tx as never, "t1", subjects)).toBe(3);
    expect(tx.auditLog.updateMany).toHaveBeenCalledTimes(3);
    expect(tx.auditLog.updateMany).toHaveBeenCalledWith({
      where: { id: "k1", tenantId: "t1" },
      data: { metadata: { signerName: null, method: "kiosk_waiver_link", redactedForErasure: true }, entityId: "m1" },
    });
    // No metadata to redact: only the address is replaced.
    expect(tx.auditLog.updateMany).toHaveBeenCalledWith({ where: { id: "k3", tenantId: "t1" }, data: { entityId: "m1" } });
    // Another member also held the address: redacted, and pointed at no one rather than at the wrong member.
    expect(tx.auditLog.updateMany).toHaveBeenCalledWith({
      where: { id: "k4", tenantId: "t1" },
      data: { metadata: { signerName: null, method: "kiosk_waiver_link", redactedForErasure: true }, entityId: ERASED_ENTITY_ID },
    });
    expect(ERASED_ENTITY_ID).toBe("erased");
  });

  it("a row found both by id and by address is written and counted once", async () => {
    const row = { id: "both", entityId: "cara@example.test", metadata: { memberId: "m1", signerName: "Cara Lee" } };
    const findMany = vi.fn(async (args: { where: { entityId?: unknown } }) => (args.where.entityId ? [row] : [{ id: row.id, metadata: row.metadata }]));
    const tx = { auditLog: { findMany, updateMany: vi.fn(async () => ({ count: 1 })) } };
    const subjects = [{ memberId: "m1", addressRow: (): AddressRowDecision => "repoint" }];
    expect(await redactSubjectsFromAuditLog(tx as never, "t1", subjects, { dryRun: true })).toBe(1);
    expect(await redactSubjectsFromAuditLog(tx as never, "t1", subjects)).toBe(1);
    expect(tx.auditLog.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.updateMany).toHaveBeenCalledWith({
      where: { id: "both", tenantId: "t1" },
      data: { metadata: { memberId: "m1", signerName: null, redactedForErasure: true }, entityId: "m1" },
    });
  });

  it("a guardian and a child erased together: one read by id for both, and a row naming both is counted and written once", async () => {
    const row = { id: "both", metadata: { memberId: "m_parent", childId: "m_kid", childName: "Kid Obi" } };
    const tx = { auditLog: { findMany: vi.fn(async () => [row]), updateMany: vi.fn(async () => ({ count: 1 })) } };
    const subjects = [{ memberId: "m_parent" }, { memberId: "m_kid" }];
    expect(await redactSubjectsFromAuditLog(tx as never, "t1", subjects, { dryRun: true })).toBe(1);
    expect(tx.auditLog.findMany).toHaveBeenCalledTimes(1);
    expect(tx.auditLog.findMany).toHaveBeenCalledWith({ where: byIdWhere(["m_parent", "m_kid"]), select: { id: true, metadata: true } });
    expect(await redactSubjectsFromAuditLog(tx as never, "t1", subjects)).toBe(1);
    expect(tx.auditLog.updateMany).toHaveBeenCalledTimes(1);
  });

  it("an address two of the subjects claim is neutral, never repointed to either", async () => {
    const row = { id: "k", entityId: "family@example.test", metadata: { signerName: "Someone", method: "kiosk_waiver_link" } };
    const findMany = vi.fn(async (args: { where: { entityId?: unknown } }) => (args.where.entityId ? [row] : []));
    const tx = { auditLog: { findMany, updateMany: vi.fn(async () => ({ count: 1 })) } };
    const both = (): AddressRowDecision => "repoint";
    await redactSubjectsFromAuditLog(tx as never, "t1", [{ memberId: "m_parent", addressRow: both }, { memberId: "m_kid", addressRow: both }]);
    expect(tx.auditLog.updateMany).toHaveBeenCalledWith({
      where: { id: "k", tenantId: "t1" },
      data: { metadata: { signerName: null, method: "kiosk_waiver_link", redactedForErasure: true }, entityId: ERASED_ENTITY_ID },
    });
  });

  it("without addressRow, no address-keyed rows are read; no subjects, no reads", async () => {
    const tx = { auditLog: { findMany: vi.fn(async () => []), updateMany: vi.fn() } };
    await redactSubjectsFromAuditLog(tx as never, "t1", [{ memberId: "m1" }]);
    expect(tx.auditLog.findMany).toHaveBeenCalledTimes(1);
    expect(await redactSubjectsFromAuditLog(tx as never, "t1", [])).toBe(0);
    expect(tx.auditLog.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("redactAuditMetadata — signerName", () => {
  it("nulls the kiosk signer's name", () => {
    expect(redactAuditMetadata({ signerName: "Cara Lee", method: "kiosk_waiver_link" })).toEqual({ signerName: null, method: "kiosk_waiver_link", redactedForErasure: true });
  });
});
