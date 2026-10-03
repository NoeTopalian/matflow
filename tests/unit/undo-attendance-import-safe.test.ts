import { describe, it, expect, vi, beforeEach } from "vitest";
import { decideUndo, applyUndo, REASON, UndoStale, type AuditRowLike, type TxLike } from "@/lib/undo-registry";

/**
 * Undoing a staff check-in must never delete an attendance row it did not
 * create. A tick on a member who is already in is a no-op upsert, so the row
 * belongs to whatever made it — a card scan, a self check-in, or imported
 * history. The tick's audit row now records `created` and `recordId`; the undo
 * removes only the row the tick made, and never an imported row.
 */
vi.mock("@/lib/checkin", () => ({ restorePackCreditsForAttendance: vi.fn(async () => 0) }));
import { restorePackCreditsForAttendance } from "@/lib/checkin";

const fake = { attendanceRecord: { findMany: vi.fn(), deleteMany: vi.fn() } };
const tx = fake as unknown as TxLike;

const mark = (metadata: Record<string, unknown>): AuditRowLike => ({
  id: "a1",
  tenantId: "t1",
  userId: "u-coach",
  action: "attendance.mark",
  entityType: "AttendanceRecord",
  entityId: "ci1:m1",
  metadata,
  createdAt: new Date("2026-10-03T10:00:00Z"),
});

beforeEach(() => {
  fake.attendanceRecord.findMany.mockReset();
  fake.attendanceRecord.deleteMany.mockReset();
  vi.mocked(restorePackCreditsForAttendance).mockClear();
});

describe("undo attendance.mark — only the row the tick created", () => {
  it("created: removes exactly the recorded row, by id, with pack credits restored first", async () => {
    fake.attendanceRecord.findMany.mockResolvedValue([{ id: "rec_new", checkInMethod: "admin", importJobId: null }]);
    const row = mark({ classInstanceId: "ci1", memberId: "m1", recordId: "rec_new", created: true });

    expect(decideUndo(row, false)).toEqual({ ok: true });
    await applyUndo(tx, row);

    expect(fake.attendanceRecord.findMany).toHaveBeenCalledWith({
      where: { id: "rec_new", member: { tenantId: "t1" } },
      select: { id: true, checkInMethod: true, importJobId: true },
    });
    expect(restorePackCreditsForAttendance).toHaveBeenCalledWith(tx, ["rec_new"]);
    expect(fake.attendanceRecord.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["rec_new"] } } });
  });

  it("created, then removed and re-made by someone else: the new row is not the tick's, so nothing is deleted", async () => {
    fake.attendanceRecord.findMany.mockResolvedValue([]);
    const row = mark({ classInstanceId: "ci1", memberId: "m1", recordId: "rec_new", created: true });

    await expect(applyUndo(tx, row)).rejects.toBeInstanceOf(UndoStale);
    expect(fake.attendanceRecord.deleteMany).not.toHaveBeenCalled();
  });

  it("pre-existing (the tick found a row): refused, and apply leaves the row alone", async () => {
    const row = mark({ classInstanceId: "ci1", memberId: "m1", recordId: "rec_imported", created: false });

    expect(decideUndo(row, false)).toEqual({ ok: false, reason: REASON.tickFoundRow });
    await expect(applyUndo(tx, row)).rejects.toBeInstanceOf(UndoStale);
    expect(fake.attendanceRecord.findMany).not.toHaveBeenCalled();
    expect(fake.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    expect(restorePackCreditsForAttendance).not.toHaveBeenCalled();
  });

  it("a legacy pair-keyed row never deletes an imported row (checkInMethod import)", async () => {
    fake.attendanceRecord.findMany.mockResolvedValue([{ id: "rec_imp", checkInMethod: "import", importJobId: "job1" }]);
    const row = mark({ classInstanceId: "ci1", memberId: "m1" });

    await expect(applyUndo(tx, row)).rejects.toThrow(REASON.importedRow);
    expect(fake.attendanceRecord.deleteMany).not.toHaveBeenCalled();
    expect(restorePackCreditsForAttendance).not.toHaveBeenCalled();
  });

  it("an imported row is never deleted even when it carries only importJobId", async () => {
    fake.attendanceRecord.findMany.mockResolvedValue([{ id: "rec_imp", checkInMethod: "admin", importJobId: "job1" }]);

    await expect(applyUndo(tx, mark({ classInstanceId: "ci1", memberId: "m1" }))).rejects.toBeInstanceOf(UndoStale);
    expect(fake.attendanceRecord.deleteMany).not.toHaveBeenCalled();
  });

  it("a self check-in undo (record id as entityId) refuses an imported row too", async () => {
    fake.attendanceRecord.findMany.mockResolvedValue([{ id: "att2", checkInMethod: "import", importJobId: "job1" }]);
    const row: AuditRowLike = { ...mark({ method: "self" }), action: "attendance.self_checkin", entityId: "att2" };

    await expect(applyUndo(tx, row)).rejects.toBeInstanceOf(UndoStale);
    expect(fake.attendanceRecord.deleteMany).not.toHaveBeenCalled();
  });
});
