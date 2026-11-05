// @vitest-environment jsdom
// /dashboard/attendance?instance=<id> — the page a session link lands on.
// Attendance is a list of recent check-ins, not a register, so "open this
// session" means: show that session's check-ins, say which session it is, and
// offer the way back to the whole list. Never an empty table with no reason.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import AttendanceView from "@/components/dashboard/AttendanceView";
import type { AttendanceRow, AttendanceSummary } from "@/app/dashboard/attendance/page";

const SUMMARY: AttendanceSummary = { totalThisMonth: 3, totalThisWeek: 2, uniqueMembersThisMonth: 2, topClass: "Advanced No-Gi" };
const row = (over: Partial<AttendanceRow>): AttendanceRow => ({
  id: "a1",
  memberName: "Robert Goodwin",
  memberId: "m1",
  className: "Advanced No-Gi",
  classInstanceId: "i1",
  date: "2026-11-04",
  startTime: "19:00",
  checkInMethod: "kiosk",
  checkInTime: "2026-11-04T19:02:00.000Z",
  checkedInByName: null,
  ...over,
});
const ROWS = [row({}), row({ id: "a2", memberName: "Sadie Burch", memberId: "m2" })];
const SESSION = { id: "i1", label: "Advanced No-Gi · Wed 4 Nov, 19:00" };

describe("AttendanceView — one session", () => {
  it("shows the recent list with no session chip by default", () => {
    render(<AttendanceView records={ROWS} summary={SUMMARY} primaryColor="#3b82f6" />);
    expect(screen.queryByTestId("attendance-session")).toBeNull();
    expect(screen.getByText("Showing 2 of 2 records")).toBeTruthy();
    expect(screen.getByText("This Month")).toBeTruthy();
  });

  it("leaves the club-wide stats out under a one-session heading", () => {
    render(<AttendanceView records={ROWS} summary={SUMMARY} primaryColor="#3b82f6" session={SESSION} />);
    expect(screen.queryByText("This Month")).toBeNull();
    expect(screen.queryByText("Top Class")).toBeNull();
  });

  it("names the session, counts its check-ins and links back to the whole list", () => {
    render(<AttendanceView records={ROWS} summary={SUMMARY} primaryColor="#3b82f6" session={SESSION} />);
    const chip = screen.getByTestId("attendance-session");
    expect(chip.textContent).toContain("Session: Advanced No-Gi · Wed 4 Nov, 19:00");
    const back = screen.getByRole("link", { name: /show all attendance/i });
    expect(back.getAttribute("href")).toBe("/dashboard/attendance");
    expect(screen.getByText("2 check-ins for this session")).toBeTruthy();
    expect(screen.queryByText(/Showing 2 of 2 records/)).toBeNull();
  });

  it("says nobody was checked in rather than 'no records found'", () => {
    render(<AttendanceView records={[]} summary={SUMMARY} primaryColor="#3b82f6" session={SESSION} />);
    expect(screen.getByText("No one was checked in to this session.")).toBeTruthy();
    expect(screen.queryByText("No attendance records found")).toBeNull();
  });

  it("says so when the session can't be found, above the normal list", () => {
    render(<AttendanceView records={ROWS} summary={SUMMARY} primaryColor="#3b82f6" sessionNotFound />);
    expect(screen.getByRole("status").textContent).toContain("That session can't be found.");
    expect(screen.queryByTestId("attendance-session")).toBeNull();
    expect(screen.getByText("Showing 2 of 2 records")).toBeTruthy();
  });
});
