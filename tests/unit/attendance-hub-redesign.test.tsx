// @vitest-environment jsdom
//
// Mark attendance, redesigned (25 Nov 2026): one selected-class card, Change
// class, By name / Scan QR. What matters most is pinned here with a mocked
// server: the class on the card is the class that receives the attendance,
// whatever order answers arrive in.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, within, cleanup } from "@testing-library/react";
import React from "react";
import AttendanceHub from "@/components/dashboard/AttendanceHub";
import { groupByStart, pickDefault, placePicker, type TodaySession } from "@/components/dashboard/SessionPicker";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const session = (id: string, name: string, startTime: string, endTime: string, extra: Partial<TodaySession> = {}): TodaySession => ({
  id, classId: `class-${id}`, name, coachName: null, location: null, color: null, startTime, endTime,
  maxCapacity: null, attendedCount: 0, waitlistCount: 0, status: "future", isCancelled: false, cancellationReason: null, isMine: false, ...extra,
});

// Two at 18:00 on two mats (the order the server sends is NOT the display order), one earlier, one later.
const DAY: TodaySession[] = [
  session("b", "No-Gi Advanced", "18:00", "19:00", { status: "ongoing", matName: "Mat 2", matOrder: 1 }),
  session("a", "Fundamentals", "18:00", "19:00", { status: "ongoing", matName: "Mat 1", matOrder: 0, auto: "on_now", onNowCount: 2 }),
  session("late", "Open Mat", "19:30", "20:30", { status: "future", matName: "Mat 1", matOrder: 0 }),
  session("early", "Morning Drilling", "06:30", "07:30", { status: "ended", location: "Sports hall" }),
];

type Reg = { status?: number; rows: Array<{ memberId: string; name: string; attended?: boolean }> };
type Deferred = { promise: Promise<void>; release: () => void };
const deferred = (): Deferred => {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
};

function stub(opts: { day?: TodaySession[] | (() => TodaySession[]); registers?: Record<string, Reg>; hold?: Record<string, Deferred>; candidates?: Array<{ id: string; name: string }> } = {}) {
  const calls: Array<{ url: string; method: string; body: unknown }> = [];
  const attended = new Set<string>();
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    const json = (status: number, b: unknown) => ({ ok: status < 300, status, json: async () => b });
    if (url === "/api/coach/today") return json(200, typeof opts.day === "function" ? opts.day() : opts.day ?? DAY);
    const reg = /^\/api\/coach\/instances\/([^/]+)\/register$/.exec(url);
    if (reg) {
      const id = reg[1];
      if (opts.hold?.[id]) await opts.hold[id].promise;
      const r = opts.registers?.[id] ?? { rows: [] };
      if (r.status && r.status >= 400) return json(r.status, { error: "The register could not be read." });
      return json(200, {
        instance: { name: `server name ${id}`, maxCapacity: null, isKids: false, allowedTiers: [] },
        expected: r.rows.map((m) => ({ ...m, attended: m.attended || attended.has(`${id}:${m.memberId}`), accountType: "adult", waiverAccepted: true, rank: null, attendedMethod: null, lastVisitAt: null, medicalConditions: null })),
        waitlist: [],
      });
    }
    if (url.startsWith("/api/checkin/members")) return json(200, (opts.candidates ?? []).map((c) => ({ ...c, accountType: "adult" })));
    if (url === "/api/checkin" && method === "POST") {
      attended.add(`${body.classInstanceId}:${body.memberId}`);
      return json(201, { success: true });
    }
    if (url === "/api/settings/kiosk") return json(200, { enabled: false, issuedAt: null });
    return json(404, { error: "Not found" });
  }));
  return calls;
}

const hub = (props: Partial<React.ComponentProps<typeof AttendanceHub>> = {}) =>
  render(<AttendanceHub initialMode="tick" preselectClassId={null} role="coach" primaryColor="#3b82f6" dateLabel="Wednesday 25 November" {...props} />);
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });
const card = () => screen.getByTestId("selected-class");
const openPicker = () => { fireEvent.click(screen.getByRole("button", { name: "Change class" })); return screen.getByRole("dialog", { name: "Change class" }); };

// jsdom has no layout: say the window is a phone, so the picker is the sheet.
const asPhone = () => { Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 }); Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 }); };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("selected class", () => {
  it("opens on the session the server chose and says why, with time, mat and how many are on now", async () => {
    stub();
    hub();
    await settle();
    expect(within(card()).getByTestId("selected-class-name").textContent).toBe("Fundamentals");
    expect(within(card()).getByTestId("selected-class-when").textContent).toBe("18:00–19:00 · Mat 1");
    expect(within(card()).getByTestId("selected-class-label").textContent).toBe("On now");
    expect(screen.getByTestId("classes-on-now").textContent).toBe("2 classes on now");
    // Both methods, side by side, one active and neither disabled.
    const tabs = screen.getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["By name", "Scan QR"]);
    expect(tabs.map((t) => t.getAttribute("aria-selected"))).toEqual(["true", "false"]);
    expect(tabs.every((t) => !(t as HTMLButtonElement).disabled)).toBe(true);
  });

  it("shows no mat when none is known, and never an empty one", async () => {
    stub({ day: [session("x", "Open Mat", "18:00", "19:00", { auto: "up_next" })] });
    hub();
    await settle();
    expect(screen.getByTestId("selected-class-when").textContent).toBe("18:00–19:00");
    expect(screen.getByTestId("selected-class-label").textContent).toBe("Up next");
    expect(screen.queryByTestId("classes-on-now")).toBeNull();
  });

  it("after the last class it opens on the class the server names, labelled Last class today", async () => {
    stub({ day: [session("x", "Evening Gi", "19:00", "20:00", { status: "ended", auto: "last_today" }), session("y", "Morning", "06:00", "07:00", { status: "ended" })] });
    hub();
    await settle();
    expect(screen.getByTestId("selected-class-name").textContent).toBe("Evening Gi");
    expect(screen.getByTestId("selected-class-label").textContent).toBe("Last class today");
  });

  it("no sessions: says so, with no attendance controls", async () => {
    stub({ day: [] });
    hub();
    await settle();
    expect(screen.getByTestId("no-classes-today").textContent).toContain("No classes today");
    expect(screen.queryByRole("tab")).toBeNull();
    expect(screen.queryByRole("button", { name: "Change class" })).toBeNull();
    expect(screen.queryByLabelText("Find a member")).toBeNull();
  });

  it("a failed load is not 'no classes'", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ error: "x" }) })));
    hub();
    await settle();
    expect(screen.queryByTestId("no-classes-today")).toBeNull();
    expect(screen.getByText(/Couldn't load today's classes/)).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });

  it("a session opened from the timetable wins over the automatic choice; a cancelled one is never chosen", () => {
    expect(pickDefault(DAY, "class-late")).toBe("late");
    expect(pickDefault(DAY, "class-nope")).toBe("a");
    expect(pickDefault([session("off", "Off", "18:00", "19:00", { isCancelled: true, status: "ongoing" })], null)).toBeNull();
  });
});

describe("change class", () => {
  it("lists the day by start time, then the club's mat order, with the selected row ticked in place", async () => {
    asPhone();
    stub();
    hub();
    await settle();
    const dialog = openPicker();
    expect(within(dialog).getByText("Wednesday 25 November")).toBeTruthy();
    const rows = within(dialog).getAllByRole("button").filter((b) => b.hasAttribute("data-session-id"));
    expect(rows.map((r) => r.getAttribute("data-session-id"))).toEqual(["early", "a", "b", "late"]);
    expect(rows.map((r) => r.getAttribute("aria-current"))).toEqual([null, "true", null, null]);
    // The two at 18:00 are told apart by name and mat.
    expect(rows[1].textContent).toContain("Fundamentals");
    expect(rows[1].textContent).toContain("Mat 1");
    expect(rows[2].textContent).toContain("No-Gi Advanced");
    expect(rows[2].textContent).toContain("Mat 2");
    expect(rows[0].textContent).toContain("Sports hall");
  });

  it("choosing a row switches once, closes the picker and keeps the method", async () => {
    asPhone();
    stub();
    hub({ initialMode: "scan" });
    await settle();
    const dialog = openPicker();
    fireEvent.click(within(dialog).getByRole("button", { name: /No-Gi Advanced/ }));
    await settle();
    expect(screen.queryByRole("dialog", { name: "Change class" })).toBeNull();
    expect(screen.getByTestId("selected-class-name").textContent).toBe("No-Gi Advanced");
    expect(screen.getByRole("tab", { name: "Scan QR" }).getAttribute("aria-selected")).toBe("true");
  });

  it("Close and Escape change nothing", async () => {
    asPhone();
    const calls = stub();
    hub();
    await settle();
    const before = calls.length;
    fireEvent.click(within(openPicker()).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Change class" })).toBeNull();
    openPicker();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Change class" })).toBeNull();
    expect(screen.getByTestId("selected-class-name").textContent).toBe("Fundamentals");
    expect(calls.length).toBe(before);
  });

  it("a wide window with room gets the popover; a narrow or short one gets the sheet", () => {
    expect(placePicker({ top: 200, bottom: 240, left: 900 }, { width: 1280, height: 800 })).toMatchObject({ kind: "popover", top: 244 });
    // No room below: above the button.
    const above = placePicker({ top: 600, bottom: 640, left: 900 }, { width: 1280, height: 720 });
    expect(above).toMatchObject({ kind: "popover" });
    expect(above.kind === "popover" && above.bottom).toBe(124);
    // Kept inside the right edge.
    const right = placePicker({ top: 200, bottom: 240, left: 1200 }, { width: 1280, height: 800 });
    expect(right.kind === "popover" && right.left + right.width).toBeLessThanOrEqual(1280 - 12);
    expect(placePicker({ top: 200, bottom: 240, left: 100 }, { width: 390, height: 844 })).toEqual({ kind: "sheet" });
    // 200% zoom on a desktop: wide enough, not tall enough either way.
    expect(placePicker({ top: 180, bottom: 220, left: 300 }, { width: 1024, height: 400 })).toEqual({ kind: "sheet" });
  });

  it("two sessions of one class name stay two rows", () => {
    const twice = [session("s2", "Open Mat", "12:00", "13:00"), session("s1", "Open Mat", "12:00", "13:00")];
    expect(groupByStart(twice)[0].sessions.map((s) => s.id)).toEqual(["s1", "s2"]);
  });
});

describe("the class on screen receives the attendance", () => {
  const REG = {
    a: { rows: [{ memberId: "ada", name: "Ada Example" }] },
    b: { rows: [{ memberId: "ben", name: "Ben Sample" }] },
  };

  it("switch class, then mark by name: the check-in carries the new class's id and the other class is untouched", async () => {
    asPhone();
    const calls = stub({ registers: REG });
    hub();
    await settle();
    fireEvent.click(within(openPicker()).getByRole("button", { name: /No-Gi Advanced/ }));
    await settle();
    fireEvent.click(screen.getByRole("button", { name: "Mark Ben Sample attended" }));
    await settle();
    const posts = calls.filter((c) => c.url === "/api/checkin" && c.method === "POST");
    expect(posts.map((p) => p.body)).toEqual([{ classInstanceId: "b", memberId: "ben", checkInMethod: "admin" }]);
    expect(screen.getByTestId("checked-in-count").textContent).toContain("1 checked in");
    expect(screen.queryByText("Ada Example")).toBeNull();
  });

  it("a register that answers late for the class left behind never appears under the new class", async () => {
    asPhone();
    const hold = { a: deferred() };
    stub({ registers: REG, hold });
    hub();
    await settle();
    // A's register is still loading; the coach moves to B.
    fireEvent.click(within(openPicker()).getByRole("button", { name: /No-Gi Advanced/ }));
    await settle();
    expect(screen.getByText("Ben Sample")).toBeTruthy();
    // Now A answers.
    await act(async () => { hold.a.release(); await new Promise((r) => setTimeout(r, 5)); });
    expect(screen.getByTestId("selected-class-name").textContent).toBe("No-Gi Advanced");
    expect(screen.getByText("Ben Sample")).toBeTruthy();
    expect(screen.queryByText("Ada Example")).toBeNull();
    expect(screen.getByTestId("checked-in-count").textContent).toContain("0 checked in of 1 expected");
  });

  it("a new class whose register fails to load offers Try again and nothing to act on", async () => {
    asPhone();
    stub({ registers: { ...REG, b: { status: 500, rows: [] } } });
    hub();
    await settle();
    expect(screen.getByLabelText("Find a member")).toBeTruthy();
    fireEvent.click(within(openPicker()).getByRole("button", { name: /No-Gi Advanced/ }));
    await settle();
    expect(screen.getByTestId("selected-class-name").textContent).toBe("No-Gi Advanced");
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    // Not the last class's rows, no search, no count from the last class.
    expect(screen.queryByText("Ada Example")).toBeNull();
    expect(screen.queryByLabelText("Find a member")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Mark .* attended$/ })).toBeNull();
    expect(screen.getByTestId("checked-in-count").textContent).toBe("");
    expect(screen.queryByText(/No bookings yet/)).toBeNull();
  });

  it("the open register keeps its class when the day is read again and another class is now 'on now'", async () => {
    asPhone();
    let later = false;
    const calls = stub({
      registers: REG,
      day: () => (later ? DAY.map((s) => ({ ...s, auto: s.id === "late" ? ("on_now" as const) : undefined, status: s.id === "late" ? ("ongoing" as const) : ("ended" as const) })) : DAY),
    });
    hub({ role: "owner" });
    await settle();
    // The coach deliberately picks the earlier class.
    fireEvent.click(within(openPicker()).getByRole("button", { name: /Morning Drilling/ }));
    await settle();
    // Time passes; the list is read again (cancelling and restoring does this).
    later = true;
    fireEvent.click(screen.getByRole("button", { name: /Session details/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel this session" }));
    const confirm = screen.getByRole("dialog");
    fireEvent.change(within(confirm).getByLabelText(/Reason/), { target: { value: "Test" } });
    // The PATCH is not stubbed (404): the refusal is shown and nothing changes, but switching methods must not move the class either.
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep it" }));
    fireEvent.click(screen.getByRole("tab", { name: "Scan QR" }));
    fireEvent.click(screen.getByRole("tab", { name: "By name" }));
    await settle();
    expect(screen.getByTestId("selected-class-name").textContent).toBe("Morning Drilling");
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("changing method writes nothing", async () => {
    const calls = stub({ registers: REG });
    hub();
    await settle();
    fireEvent.click(screen.getByRole("tab", { name: "Scan QR" }));
    fireEvent.click(screen.getByRole("tab", { name: "By name" }));
    await settle();
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(screen.getByTestId("selected-class-name").textContent).toBe("Fundamentals");
  });
});

describe("by name, details and kiosk", () => {
  it("the search comes before the register, and an empty register points up to it", async () => {
    stub();
    hub();
    await settle();
    const search = screen.getByLabelText("Find a member");
    const empty = screen.getByText("No bookings yet. Search above to check someone in.");
    expect(search.compareDocumentPosition(empty) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("cancelling sits under Session details, for owner and manager only", async () => {
    stub();
    hub({ role: "coach" });
    await settle();
    fireEvent.click(screen.getByRole("button", { name: /Session details/ }));
    expect(screen.getByText("No coach assigned")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Cancel this session" })).toBeNull();
    cleanup();
    stub();
    hub({ role: "manager" });
    await settle();
    expect(screen.queryByRole("button", { name: "Cancel this session" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Session details/ }));
    expect(screen.getByRole("button", { name: "Cancel this session" })).toBeTruthy();
  });

  it("the kiosk is last, with Open kiosk for the owner only", async () => {
    stub();
    hub({ role: "owner" });
    await settle();
    const kiosk = screen.getByTestId("kiosk-section");
    expect(within(kiosk).getByText("Self-service kiosk")).toBeTruthy();
    expect(within(kiosk).getByText("Let members check themselves in")).toBeTruthy();
    expect(screen.getByTestId("session-details").compareDocumentPosition(kiosk) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(kiosk).getByRole("button", { name: "Open kiosk" })).toBeTruthy();
    cleanup();
    stub();
    hub({ role: "coach" });
    await settle();
    expect(within(screen.getByTestId("kiosk-section")).queryByRole("button", { name: "Open kiosk" })).toBeNull();
  });
});
