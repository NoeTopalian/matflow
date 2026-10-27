/**
 * G4: a coach's one-off in the Activity log. `attendance.one_off` reads as a
 * sentence with the reason, and its undo removes exactly the visit it
 * admitted (the ClassOneOff row goes with it: ON DELETE CASCADE, proven on a
 * real database in tests/integration/class-one-off-db.test.ts). Also the pure
 * helpers the register and the member's history share.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/checkin", () => ({ restorePackCreditsForAttendance: vi.fn(async () => 0) }));
import { restorePackCreditsForAttendance } from "@/lib/checkin";
import { decideUndo, applyUndo, type AuditRowLike, type TxLike } from "@/lib/undo-registry";
import { auditEntryLabel, auditLabel, undoneMessage } from "@/lib/audit-labels";
import { oneOffCanAdmit, oneOffHistoryLine, oneOffReason, oneOffRowLabel } from "@/lib/one-off";

const META = {
  classInstanceId: "ci1", memberId: "m1", method: "admin", recordId: "att1", created: true,
  oneOffId: "oo1", reason: "Trial for the comp squad",
};
const row = (action: string, metadata: unknown = META): AuditRowLike => ({
  id: "a1", tenantId: "t1", userId: "u-coach", action, entityType: "AttendanceRecord", entityId: "ci1:m1",
  metadata, createdAt: new Date("2026-10-27T10:00:00Z"),
});

const fake = { attendanceRecord: { findMany: vi.fn(), deleteMany: vi.fn() } };
const tx = fake as unknown as TxLike;

beforeEach(() => {
  fake.attendanceRecord.findMany.mockReset();
  fake.attendanceRecord.deleteMany.mockReset();
  vi.mocked(restorePackCreditsForAttendance).mockClear();
});

describe("Activity: attendance.one_off", () => {
  it("has a readable sentence, and the row names the reason", () => {
    expect(auditLabel("attendance.one_off")).toBe("Added a member to one session as a one-off");
    expect(auditEntryLabel("attendance.one_off", META)).toBe("Added a member to one session as a one-off: “Trial for the comp squad”");
    expect(auditEntryLabel("attendance.one_off", {})).toBe("Added a member to one session as a one-off");
    expect(auditEntryLabel("undo.attendance.one_off", {})).toBe("Undid: Added a member to one session as a one-off");
  });

  it("can be undone, and the undo removes exactly the visit it admitted", async () => {
    expect(decideUndo(row("attendance.one_off"), false)).toEqual({ ok: true });
    fake.attendanceRecord.findMany.mockResolvedValue([{ id: "att1", checkInMethod: "admin", importJobId: null }]);
    fake.attendanceRecord.deleteMany.mockResolvedValue({ count: 1 });
    await applyUndo(tx, row("attendance.one_off"));
    expect(fake.attendanceRecord.findMany).toHaveBeenCalledWith({
      where: { id: "att1", member: { tenantId: "t1" } },
      select: { id: true, checkInMethod: true, importJobId: true },
    });
    expect(restorePackCreditsForAttendance).toHaveBeenCalledWith(tx, ["att1"]);
    expect(fake.attendanceRecord.deleteMany).toHaveBeenCalledWith({ where: { id: { in: ["att1"] } } });
  });

  it("an already-undone one-off is refused like any other row", () => {
    expect(decideUndo(row("attendance.one_off"), true).ok).toBe(false);
  });

  it("the undo toast lower-cases the label but keeps the reason as typed", () => {
    expect(undoneMessage("attendance.one_off", { reason: "Guest of Sean, BJJ Globetrotters" }))
      .toBe("Undone: added a member to one session as a one-off: “Guest of Sean, BJJ Globetrotters”.");
    // Every other action reads exactly as before.
    expect(undoneMessage("member.update", {})).toBe("Undone: updated a member's details.");
    expect(undoneMessage("attendance.mark", {})).toBe("Undone: checked a member in.");
  });
});

describe("the shared one-off helpers", () => {
  it("only the squad list, the plan restriction and the allowance offer a one-off", () => {
    for (const r of ["allowance_reached", "tier_not_included", "roster_not_listed"]) expect(oneOffCanAdmit(r)).toBe(true);
    for (const r of ["on_hold", "waiver_unsigned", "kids_class", "class_cancelled", "class_full", "no_coverage", null, undefined]) {
      expect(oneOffCanAdmit(r)).toBe(false);
    }
  });

  it("validates and trims the reason (3 to 200 characters)", () => {
    expect(oneOffReason("  abc ")).toBe("abc");
    expect(oneOffReason("ab")).toBeNull();
    expect(oneOffReason("x".repeat(200))).toHaveLength(200);
    expect(oneOffReason("x".repeat(201))).toBeNull();
    expect(oneOffReason(undefined)).toBeNull();
  });

  it("reads on the register row and in the member's history as agreed", () => {
    expect(oneOffRowLabel("Trial for the comp squad")).toBe("One-off · Trial for the comp squad");
    expect(oneOffHistoryLine("Coach Jo", "Trial for the comp squad")).toBe("One-off — added by Coach Jo: Trial for the comp squad");
    // The staff user was removed since (grantedById SET NULL): still a sentence.
    expect(oneOffHistoryLine(null, "Trial")).toBe("One-off — added by a staff member: Trial");
  });
});
