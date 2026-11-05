// @vitest-environment jsdom
//
// P6 (lost update): the form sends the slot ids it loaded with; a 409 from the
// server is shown IN the form, beside the buttons (UI-RULES §7), the form stays
// open with its typed values, nothing is toasted over the controls. A save that
// creates a class sends no base.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";
import TimetableManager from "@/components/dashboard/TimetableManager";
import type { ClassRow } from "@/app/dashboard/timetable/page";

const toastSpy = vi.fn();
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

const GI: ClassRow = {
  id: "c1", name: "Gi", coachName: null, coachUserId: null, coachUser: null, location: null, locationId: null,
  duration: 60, maxCapacity: null, color: null, description: null, requiredRankId: null, requiredRank: null,
  maxRankId: null, maxRank: null,
  schedules: [{ id: "slot-mon", dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }],
  roster: [], lifecycle: "active", archivedAt: null,
};
const PROPS = { rankSystems: [], coachUsers: [], primaryColor: "var(--color-primary)", role: "owner", currentUserId: "u1" };
const STALE = "This class's days or times changed since you opened it. Reload to see the latest, then make your change again.";

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
let calls: Call[] = [];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 10, 5, 10, 0));
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
      calls.push({ url, method, body });
      if (url === "/api/locations") return { ok: true, json: async () => ({ locations: [] }) };
      if (url === "/api/coach/today") return { ok: true, json: async () => [] };
      if (method === "PATCH") return { ok: false, status: 409, json: async () => ({ error: STALE, reason: "stale_schedules" }) };
      if (method === "POST") return { ok: true, status: 201, json: async () => ({ ...GI, id: "c2", name: String(body?.name) }) };
      return { ok: false, json: async () => ({}) };
    }),
  );
});
afterEach(() => vi.useRealTimers());

describe("a refused save stays with the form", () => {
  it("edit sends the slot ids it loaded with; a 409 is shown beside the buttons, the form keeps its values, no toast", async () => {
    render(<TimetableManager initialClasses={[GI]} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Gi/ })[0]);
    const name = screen.getByLabelText("Class Name") as HTMLInputElement;
    fireEvent.change(name, { target: { value: "Gi Fundamentals" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(STALE);
    expect(screen.getByTestId("class-form-save-error")).toBe(alert);
    // A stale-days refusal offers the way out: an installed app has no reload control.
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
    expect((screen.getByLabelText("Class Name") as HTMLInputElement).value).toBe("Gi Fundamentals");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeTruthy();
    expect(toastSpy).not.toHaveBeenCalled();
    const patch = calls.find((c) => c.method === "PATCH");
    expect(patch?.url).toBe("/api/classes/c1");
    expect(patch?.body?.baseScheduleIds).toEqual(["slot-mon"]);
    expect(patch?.body?.schedules).toEqual([{ dayOfWeek: 1, startTime: "18:00", endTime: "19:00" }]);
  });

  it("the message clears when the form is opened again", async () => {
    render(<TimetableManager initialClasses={[GI]} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Gi/ })[0]);
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getAllByRole("button", { name: /^Edit Gi/ })[0]);
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("creating a class sends no base", async () => {
    render(<TimetableManager initialClasses={[GI]} {...PROPS} />);
    fireEvent.click(screen.getAllByRole("button", { name: "Add class" })[0]);
    fireEvent.change(screen.getByLabelText("Class Name"), { target: { value: "No-Gi" } });
    fireEvent.click(screen.getByRole("button", { name: "Add day" }));
    fireEvent.click(screen.getByRole("button", { name: "Create class" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST");
    expect(post?.body).not.toHaveProperty("baseScheduleIds");
  });
});
