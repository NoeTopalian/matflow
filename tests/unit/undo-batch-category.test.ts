// Undo of a class edit whose category was archived (or removed) between the undo's own check and its write: the
// database trigger refuses the write (migration 20261111120000_class_categories), and executeUndo says so as the same
// refusal the undo's check would have given, never a server error (review of Release A, S6).
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/mats", () => ({ lockClubMats: vi.fn(async () => {}) }));
vi.mock("@/lib/undo-registry", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/undo-registry")>();
  return { ...real, applyUndo: vi.fn() };
});

import { applyUndo, REASON, type AuditRowLike, type TxLike } from "@/lib/undo-registry";
import { executeUndo, UndoBatchFailed } from "@/lib/undo-batch";

const row: AuditRowLike = {
  id: "a1", tenantId: "t1", userId: "u1", action: "class.updated", entityType: "Class", entityId: "c1",
  metadata: { fields: ["categoryId"], before: { categoryId: "cat-old" }, after: { categoryId: "cat-new" } },
  createdAt: new Date("2026-11-11T09:00:00.000Z"),
};
const tx = { auditLog: { create: vi.fn() }, $queryRaw: vi.fn(async () => []) } as unknown as TxLike;
const run = () => executeUndo(tx, [{ row, decision: { ok: true } }], { tenantId: "t1", userId: "u1" });

describe("executeUndo — the category trigger's refusal", () => {
  it("an archived category becomes the stale refusal, and nothing is recorded as undone", async () => {
    vi.mocked(applyUndo).mockRejectedValueOnce(new Error("MF_CLASS_CATEGORY_ARCHIVED: that category is archived"));
    const p = run();
    await expect(p).rejects.toBeInstanceOf(UndoBatchFailed);
    await expect(p).rejects.toMatchObject({ reason: REASON.categoryArchived });
    expect((tx as unknown as { auditLog: { create: ReturnType<typeof vi.fn> } }).auditLog.create).not.toHaveBeenCalled();
  });

  it("a category no longer in the club becomes the same refusal the undo's own check gives", async () => {
    vi.mocked(applyUndo).mockRejectedValueOnce(new Error("MF_CLASS_CATEGORY_NOT_FOUND: no such category in this club"));
    await expect(run()).rejects.toMatchObject({ reason: REASON.categoryGone });
  });

  it("any other error is not dressed up as a category refusal", async () => {
    vi.mocked(applyUndo).mockRejectedValueOnce(new Error("connection reset"));
    await expect(run()).rejects.toThrow("connection reset");
  });
});
