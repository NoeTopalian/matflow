// T6b: the Activity page's Undo for the class lifecycle.
//
//  - class.deleted (Archive) records the state before; Undo restores exactly
//    that state (a class paused before it was archived returns to PAUSED) and
//    refuses as stale when the class has been restored or re-archived since.
//  - Rows written before T6b carry no prior state: refused with a reason that
//    is true (Restore exists now and is where to go).
//  - class.updated (Pause / Resume / Restore) undoes through the snapshot
//    handler, now including deletedAt, and never puts an imported history
//    class on the timetable.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/checkin", () => ({ restorePackCreditsForAttendance: vi.fn(async () => 0) }));
vi.mock("@/lib/class-lifecycle", () => ({ mintUpcomingSessions: vi.fn(async () => 3) }));

import { decideUndo, applyUndo, REASON, UndoStale, type AuditRowLike, type TxLike } from "@/lib/undo-registry";
import { mintUpcomingSessions } from "@/lib/class-lifecycle";

const ARCHIVED_AT = "2026-10-17T09:00:00.000Z";

const row = (action: string, metadata: unknown): AuditRowLike => ({
  id: "a1",
  tenantId: "t1",
  userId: "u1",
  action,
  entityType: "Class",
  entityId: "c1",
  metadata,
  createdAt: new Date(ARCHIVED_AT),
});

const fake = {
  class: { findFirst: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
};
const tx = fake as unknown as TxLike;

beforeEach(() => {
  vi.clearAllMocks();
  fake.class.updateMany.mockResolvedValue({ count: 1 });
  fake.class.update.mockResolvedValue({});
});

const archiveRow = (beforeIsActive: boolean) =>
  row("class.deleted", {
    soft: true,
    archived: true,
    attendanceCount: 4,
    rosterCount: 0,
    bookingCount: 2,
    before: { isActive: beforeIsActive, deletedAt: null },
    after: { isActive: false, deletedAt: ARCHIVED_AT },
  });

describe("class.deleted (Archive) — decide", () => {
  it("a T6b archive row can be undone", () => {
    expect(decideUndo(archiveRow(true), false)).toEqual({ ok: true });
  });

  it("a pre-T6b row (counts only, no prior state) is refused with a TRUE reason pointing at Restore", () => {
    const legacy = row("class.deleted", { soft: true, force: true, attendanceCount: 31, rosterCount: 12 });
    expect(decideUndo(legacy, false)).toEqual({ ok: false, reason: REASON.archivedNoSnapshot });
    expect(REASON.archivedNoSnapshot).toMatch(/restore it from Paused and archived/i);
    // True even when the class has been restored since (decide sees only the row).
    expect(REASON.archivedNoSnapshot).toMatch(/If it is still archived/);
    // Not the generic "Recorded before snapshots were kept" sentence.
    expect(decideUndo(legacy, false)).not.toEqual({ ok: false, reason: REASON.noSnapshot });
  });
});

describe("class.deleted (Archive) — apply", () => {
  it("an active class that was archived goes back to ACTIVE, and its sessions are minted", async () => {
    fake.class.findFirst.mockResolvedValue({ isActive: false, deletedAt: new Date(ARCHIVED_AT), sourceImportJobId: null });
    await applyUndo(tx, archiveRow(true));
    expect(fake.class.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", tenantId: "t1", isActive: false, deletedAt: new Date(ARCHIVED_AT) },
      data: { isActive: true, deletedAt: null },
    });
    expect(mintUpcomingSessions).toHaveBeenCalledWith(tx, "t1", "c1");
  });

  it("acceptance 4: a class PAUSED before it was archived goes back to PAUSED, not active (no sessions minted)", async () => {
    fake.class.findFirst.mockResolvedValue({ isActive: false, deletedAt: new Date(ARCHIVED_AT), sourceImportJobId: null });
    await applyUndo(tx, archiveRow(false));
    expect(fake.class.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false, deletedAt: null } }),
    );
    expect(mintUpcomingSessions).not.toHaveBeenCalled();
  });

  it("stale: refused when the class has been restored since", async () => {
    fake.class.findFirst.mockResolvedValue({ isActive: true, deletedAt: null, sourceImportJobId: null });
    await expect(applyUndo(tx, archiveRow(true))).rejects.toBeInstanceOf(UndoStale);
    expect(fake.class.updateMany).not.toHaveBeenCalled();
  });

  it("stale: refused when it was restored and archived AGAIN (a different archive)", async () => {
    fake.class.findFirst.mockResolvedValue({ isActive: false, deletedAt: new Date("2026-10-18T09:00:00.000Z"), sourceImportJobId: null });
    await expect(applyUndo(tx, archiveRow(true))).rejects.toBeInstanceOf(UndoStale);
    expect(fake.class.updateMany).not.toHaveBeenCalled();
  });

  it("refused when the class no longer exists; reads are tenant-scoped", async () => {
    fake.class.findFirst.mockResolvedValue(null);
    await expect(applyUndo(tx, archiveRow(true))).rejects.toBeInstanceOf(UndoStale);
    expect(fake.class.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "c1", tenantId: "t1" } }));
  });
});

describe("class.updated (Pause / Resume / Restore) — undo through the snapshot", () => {
  it("undoing a RESTORE puts the archive back (deletedAt restored as a Date)", async () => {
    fake.class.findFirst.mockResolvedValue({ id: "c1", tenantId: "t1", isActive: true, deletedAt: null, sourceImportJobId: null });
    const restoreRow = row("class.updated", {
      fields: ["isActive"],
      before: { isActive: false, deletedAt: ARCHIVED_AT },
      after: { isActive: true, deletedAt: null },
    });
    expect(decideUndo(restoreRow, false)).toEqual({ ok: true });
    await applyUndo(tx, restoreRow);
    expect(fake.class.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { isActive: false, deletedAt: new Date(ARCHIVED_AT) },
    });
    expect(mintUpcomingSessions).not.toHaveBeenCalled();
  });

  it("undoing a PAUSE resumes the class and mints its sessions", async () => {
    fake.class.findFirst.mockResolvedValue({ id: "c1", tenantId: "t1", isActive: false, deletedAt: null, sourceImportJobId: null });
    await applyUndo(tx, row("class.updated", { fields: ["isActive"], before: { isActive: true }, after: { isActive: false } }));
    expect(fake.class.update).toHaveBeenCalledWith({ where: { id: "c1" }, data: { isActive: true } });
    expect(mintUpcomingSessions).toHaveBeenCalledWith(tx, "t1", "c1");
  });

  it("undoing an old PAUSE after the class was archived is refused (never 'active but archived', nothing minted)", async () => {
    fake.class.findFirst.mockResolvedValue({
      id: "c1", tenantId: "t1", isActive: false, deletedAt: new Date(ARCHIVED_AT), sourceImportJobId: null,
    });
    const pauseRow = row("class.updated", { fields: ["isActive"], before: { isActive: true }, after: { isActive: false } });
    await expect(applyUndo(tx, pauseRow)).rejects.toThrow(REASON.archivedSince);
    expect(fake.class.update).not.toHaveBeenCalled();
    expect(mintUpcomingSessions).not.toHaveBeenCalled();
  });

  it("undoing the Restore of a pre-T6b archive puts it back ARCHIVED (deletedAt set), not paused", async () => {
    // The PATCH records the legacy archive date as before.deletedAt.
    fake.class.findFirst.mockResolvedValue({ id: "c1", tenantId: "t1", isActive: true, deletedAt: null, sourceImportJobId: null });
    await applyUndo(tx, row("class.updated", {
      fields: ["isActive"],
      lifecycle: "restored",
      before: { isActive: false, deletedAt: "2026-09-01T10:00:00.000Z" },
      after: { isActive: true, deletedAt: null },
    }));
    expect(fake.class.update).toHaveBeenCalledWith({
      where: { id: "c1" },
      data: { isActive: false, deletedAt: new Date("2026-09-01T10:00:00.000Z") },
    });
    expect(mintUpcomingSessions).not.toHaveBeenCalled();
  });

  it("never puts an imported history class on the timetable", async () => {
    fake.class.findFirst.mockResolvedValue({ id: "c1", tenantId: "t1", isActive: false, deletedAt: null, sourceImportJobId: "job-1" });
    await expect(
      applyUndo(tx, row("class.updated", { fields: ["isActive"], before: { isActive: true }, after: { isActive: false } })),
    ).rejects.toBeInstanceOf(UndoStale);
    expect(fake.class.update).not.toHaveBeenCalled();
  });
});
