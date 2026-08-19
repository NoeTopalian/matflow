// @vitest-environment jsdom
//
// Task 3c, the honesty half. RULES §2: "A success message must mean success.
// Do not report 'Class updated' for a field the server silently discarded."
// That is exactly what this screen did — TimetableManager sent `schedules`,
// Zod stripped it, the client merged the OLD rows back into state, and the
// toast said "Class updated".
//
// Now the save is real, and it CASCADES: changing a class's time deletes the
// upcoming sessions generated at the old time and mints new ones. RULES §5:
// "A cascade that removes user-visible state must be visible to the user."
// So the message has to say what happened — and in particular has to surface
// the sessions that could NOT be moved because members are already on them.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";

const toastSpy = vi.fn();

vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

const CLASS: ClassRow = {
  id: "c1",
  name: "Fundamentals BJJ",
  coachName: null,
  coachUserId: null,
  coachUser: null,
  location: null,
  duration: 60,
  maxCapacity: null,
  color: null,
  description: null,
  requiredRankId: null,
  requiredRank: null,
  maxRankId: null,
  maxRank: null,
  schedules: [{ id: "s1", dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
  roster: [],
};

const PROPS = {
  initialClasses: [CLASS],
  rankSystems: [],
  coachUsers: [],
  primaryColor: "var(--color-primary)",
  role: "owner",
  currentUserId: "u1",
};

type ScheduleChange = {
  slotsAdded: number;
  slotsRemoved: number;
  instancesRemoved: string[];
  instancesKept: string[];
  instancesCreated: number;
};

function mockPatch(scheduleChange: ScheduleChange | null) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      json: async () => ({
        ...CLASS,
        schedules: [{ id: "s2", dayOfWeek: 1, startTime: "19:00", endTime: "20:00" }],
        scheduleChange,
      }),
    })),
  );
}

async function saveTheClass() {
  // Two edit affordances carry this label: the weekly grid cell and the class
  // card. Either opens the same sheet.
  fireEvent.click(screen.getAllByLabelText("Edit Fundamentals BJJ")[0]);
  fireEvent.click(await screen.findByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(toastSpy).toHaveBeenCalled());
  return toastSpy.mock.calls[0] as [string, string];
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("Task 3c — the save toast states what actually happened", () => {
  it("stays a plain 'Class updated' when nothing about the timetable moved", async () => {
    mockPatch({ slotsAdded: 0, slotsRemoved: 0, instancesRemoved: [], instancesKept: [], instancesCreated: 0 });
    render(<TimetableManager {...PROPS} />);
    const [message, kind] = await saveTheClass();
    expect(message).toBe("Class updated");
    expect(kind).toBe("success");
  });

  it("names the upcoming sessions a time change removed and created", async () => {
    mockPatch({
      slotsAdded: 1,
      slotsRemoved: 1,
      instancesRemoved: ["i1", "i2", "i3"],
      instancesKept: [],
      instancesCreated: 8,
    });
    render(<TimetableManager {...PROPS} />);
    const [message, kind] = await saveTheClass();

    expect(message).toContain("Timetable changed");
    expect(message).toContain("3 upcoming sessions removed");
    expect(message).toContain("8 new sessions added");
    expect(kind).toBe("success");
  });

  it("warns about sessions kept at the old time because members are on them", async () => {
    mockPatch({
      slotsAdded: 1,
      slotsRemoved: 1,
      instancesRemoved: ["i1"],
      instancesKept: ["i2", "i3"],
      instancesCreated: 8,
    });
    render(<TimetableManager {...PROPS} />);
    const [message, kind] = await saveTheClass();

    // The cascade left member-visible state behind; the operator has to know,
    // and a green tick would say the opposite.
    expect(message).toContain("2 sessions kept at the old time");
    expect(message).toContain("already checked in or joined the waitlist");
    expect(kind).toBe("warning");
  });

  it("says it in singular when it is one session", async () => {
    mockPatch({
      slotsAdded: 1,
      slotsRemoved: 1,
      instancesRemoved: ["i1"],
      instancesKept: [],
      instancesCreated: 1,
    });
    render(<TimetableManager {...PROPS} />);
    const [message] = await saveTheClass();
    expect(message).toContain("1 upcoming session removed");
    expect(message).toContain("1 new session added");
  });

  it("sends the edited schedules to the server", async () => {
    mockPatch(null);
    render(<TimetableManager {...PROPS} />);
    await saveTheClass();

    const body = JSON.parse(
      (vi.mocked(fetch).mock.calls[0][1] as RequestInit).body as string,
    ) as { schedules: Array<{ dayOfWeek: number; startTime: string }> };
    // The field the server used to throw away.
    expect(body.schedules).toEqual([{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }]);
  });

  it("does not let the report leak onto the class row", async () => {
    mockPatch({
      slotsAdded: 1,
      slotsRemoved: 1,
      instancesRemoved: ["i1"],
      instancesKept: [],
      instancesCreated: 8,
    });
    render(<TimetableManager {...PROPS} />);
    await saveTheClass();

    // The grid now shows the NEW time, from the server's rows — the old code
    // merged `updated.schedules ?? c.schedules` over a response that never
    // carried updated schedules, so the chip never moved.
    await waitFor(() => expect(screen.getAllByText(/Mon 19:00/).length).toBeGreaterThan(0));
  });
});
