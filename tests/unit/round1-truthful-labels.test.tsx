// Round 1 (9 Nov 2026): labels say what their data is, and the Attendance
// footer never implies the loaded rows are the whole history.
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";
import AttendanceView, { attendanceFooter } from "@/components/dashboard/AttendanceView";
import { paymentStatusLabel } from "@/components/dashboard/SettingsPage";
import type { AttendanceRow, AttendanceSummary } from "@/app/dashboard/attendance/page";

const SUMMARY: AttendanceSummary = { totalThisMonth: 3, totalThisWeek: 2, uniqueMembersThisMonth: 2, topClass: "Advanced No-Gi" };

function row(i: number): AttendanceRow {
  return {
    id: `a${i}`,
    memberId: `m${i}`,
    memberName: `Member ${i}`,
    className: i % 2 ? "Fundamentals" : "Advanced No-Gi",
    classInstanceId: `ci${i}`,
    date: "2026-11-03",
    startTime: "18:00",
    checkInMethod: "manual",
    checkInTime: new Date(Date.UTC(2026, 10, 3, 18, 0, i)).toISOString(),
    checkedInByName: null,
  };
}

describe("Attendance footer wording", () => {
  it("says the list is capped only when the loaded count reaches the server limit", () => {
    expect(attendanceFooter({ loaded: 100, shown: 100, limit: 100, session: false })).toBe(
      "Latest 100 records. Older records aren't loaded here.",
    );
    expect(attendanceFooter({ loaded: 37, shown: 37, limit: 100, session: false })).toBe("37 records.");
  });

  it("tells filtered matches apart from loaded rows and says search covers only the loaded rows", () => {
    expect(attendanceFooter({ loaded: 100, shown: 4, limit: 100, session: false })).toBe(
      "4 matches among the latest 100 loaded records. Search covers only these loaded records.",
    );
    expect(attendanceFooter({ loaded: 100, shown: 0, limit: 100, session: false })).toBe(
      "No matches among the latest 100 loaded records. Search covers only these loaded records.",
    );
    expect(attendanceFooter({ loaded: 37, shown: 1, limit: 100, session: false })).toBe("1 match among 37 records.");
  });

  it("keeps the single-session view accurate, including when a session hits its cap", () => {
    expect(attendanceFooter({ loaded: 2, shown: 2, limit: 1000, session: true })).toBe("2 check-ins for this session.");
    expect(attendanceFooter({ loaded: 1000, shown: 1000, limit: 1000, session: true })).toBe(
      "Latest 1000 check-ins for this session. Older check-ins aren't loaded here.",
    );
    expect(attendanceFooter({ loaded: 0, shown: 0, limit: 1000, session: true })).toBe("No check-ins for this session.");
  });

  it("keeps a genuinely empty history distinct from a filtered list with no matches", () => {
    expect(attendanceFooter({ loaded: 0, shown: 0, limit: 100, session: false })).toBe("No attendance records yet.");
    render(<AttendanceView records={[]} summary={SUMMARY} primaryColor="#3b82f6" loadedLimit={100} />);
    // Both the list's empty state and the footer say it; neither says "found".
    expect(screen.getAllByText("No attendance records yet.").length).toBeGreaterThan(0);
    expect(screen.queryByText("No attendance records found")).toBeNull();
  });

  it("renders the capped footer when the page passes the limit and the rows fill it", () => {
    const rows = Array.from({ length: 100 }, (_, i) => row(i));
    render(<AttendanceView records={rows} summary={SUMMARY} primaryColor="#3b82f6" loadedLimit={100} />);
    expect(screen.getByTestId("attendance-footer").textContent).toBe("Latest 100 records. Older records aren't loaded here.");
    // The stat card names what the query finds: the one session with most check-ins.
    expect(screen.getByText("Busiest session")).toBeTruthy();
    expect(screen.queryByText("Top Class")).toBeNull();
  });
});

describe("Revenue recent payments label", () => {
  it("names the payment status and never a membership movement", () => {
    expect(paymentStatusLabel("succeeded", "joined")).toBe("Paid");
    expect(paymentStatusLabel("pending", "joined")).toBe("Pending");
    expect(paymentStatusLabel("disputed", "joined")).toBe("Disputed");
    expect(paymentStatusLabel("failed", "cancelled")).toBe("Failed");
    expect(paymentStatusLabel("refunded", "cancelled")).toBe("Refunded");
    for (const [s, a] of [["succeeded", "joined"], ["failed", "cancelled"], [undefined, "joined"], [undefined, "cancelled"]] as const) {
      const label = paymentStatusLabel(s, a);
      expect(label).not.toMatch(/joined|cancel/i);
    }
  });

  it("falls back to neutral wording when the response has no status", () => {
    expect(paymentStatusLabel(undefined, "joined")).toBe("Payment recorded");
    expect(paymentStatusLabel(undefined, "cancelled")).toBe("Failed or refunded");
  });
});
