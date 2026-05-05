// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import AdminCheckin from "@/components/dashboard/AdminCheckin";
import { ToastProvider } from "@/components/ui/Toast";

const PRIMARY = "#3b82f6";

const INSTANCES = [
  {
    id: "inst-1",
    name: "Beginner BJJ",
    coachName: "Coach Mike",
    location: "Mat 1",
    startTime: "10:00",
    endTime: "11:00",
    maxCapacity: 20,
    color: "#3b82f6",
  },
];

const MEMBERS_TWO_NOES = [
  { id: "m1", name: "Noe Topalian", membershipType: "Pro", rankName: null, rankColor: null, checkedIn: false },
  { id: "m2", name: "Noe Tisson",   membershipType: "Pro", rankName: null, rankColor: null, checkedIn: false },
  { id: "m3", name: "Bob Smith",    membershipType: "Pro", rankName: null, rankColor: null, checkedIn: false },
];

const MEMBERS_UNIQUE_NOE_T = [
  { id: "m1", name: "Noe Topalian", membershipType: "Pro", rankName: null, rankColor: null, checkedIn: false },
  { id: "m2", name: "Sarah Adams",  membershipType: "Pro", rankName: null, rankColor: null, checkedIn: false },
];

function renderWithProviders(ui: React.ReactElement) {
  return render(<ToastProvider>{ui}</ToastProvider>);
}

describe("AdminCheckin smart auto-select", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Mock fetch — return a 201 success on POST /api/checkin
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 201,
      json: async () => ({ success: true, record: { id: "rec-1" } }),
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("auto-fires POST /api/checkin after debounce when one unchecked match", async () => {
    renderWithProviders(
      <AdminCheckin
        instances={INSTANCES}
        initialInstanceId="inst-1"
        initialMembers={MEMBERS_UNIQUE_NOE_T}
        primaryColor={PRIMARY}
        role="owner"
      />,
    );

    const searchInput = screen.getByPlaceholderText(/Search members/i) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "Noe T" } });

    expect(global.fetch).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const call = (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("/api/checkin");
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.memberId).toBe("m1");
    expect(body.classInstanceId).toBe("inst-1");
  });

  it("does NOT auto-fire when the query matches more than one member", async () => {
    renderWithProviders(
      <AdminCheckin
        instances={INSTANCES}
        initialInstanceId="inst-1"
        initialMembers={MEMBERS_TWO_NOES}
        primaryColor={PRIMARY}
        role="owner"
      />,
    );

    const searchInput = screen.getByPlaceholderText(/Search members/i) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "Noe" } });

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("does NOT auto-fire when query is shorter than 2 characters", async () => {
    renderWithProviders(
      <AdminCheckin
        instances={INSTANCES}
        initialInstanceId="inst-1"
        initialMembers={MEMBERS_UNIQUE_NOE_T}
        primaryColor={PRIMARY}
        role="owner"
      />,
    );

    const searchInput = screen.getByPlaceholderText(/Search members/i) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "N" } });

    await act(async () => {
      vi.advanceTimersByTime(1500);
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("rapid typing cancels prior debounce — only the final unique-match state fires once", async () => {
    renderWithProviders(
      <AdminCheckin
        instances={INSTANCES}
        initialInstanceId="inst-1"
        initialMembers={MEMBERS_UNIQUE_NOE_T}
        primaryColor={PRIMARY}
        role="owner"
      />,
    );

    const searchInput = screen.getByPlaceholderText(/Search members/i) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "No" } });
    await act(async () => { vi.advanceTimersByTime(200); });
    fireEvent.change(searchInput, { target: { value: "Noe" } });
    await act(async () => { vi.advanceTimersByTime(200); });
    fireEvent.change(searchInput, { target: { value: "Noe T" } });

    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does NOT auto-fire when the unique match is already checked in", async () => {
    const alreadyChecked = MEMBERS_UNIQUE_NOE_T.map((m) =>
      m.id === "m1" ? { ...m, checkedIn: true } : m,
    );
    renderWithProviders(
      <AdminCheckin
        instances={INSTANCES}
        initialInstanceId="inst-1"
        initialMembers={alreadyChecked}
        primaryColor={PRIMARY}
        role="owner"
      />,
    );

    const searchInput = screen.getByPlaceholderText(/Search members/i) as HTMLInputElement;
    fireEvent.change(searchInput, { target: { value: "Noe T" } });

    await act(async () => {
      vi.advanceTimersByTime(700);
    });

    expect(global.fetch).not.toHaveBeenCalled();
  });
});
