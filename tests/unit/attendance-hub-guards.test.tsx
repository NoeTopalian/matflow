// @vitest-environment jsdom
//
// Mark attendance (25 Nov 2026, Noe): two guards on the writes.
//   1. The scanner sends nothing while the class picker OR the cancel
//      confirmation is open, nor while the day's list is being read again
//      after one; it resumes when the list is back.
//   2. A desk tablet left awake across the club's midnight: the first mark or
//      card read after the date changes writes nothing and shows a dated
//      Reload notice, with no focus, visibility or timer event having fired.
// Fake camera, fake clock and timers, mocked fetch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within, cleanup } from "@testing-library/react";
import React from "react";
import AttendanceHub from "@/components/dashboard/AttendanceHub";
import type { TodaySession } from "@/components/dashboard/SessionPicker";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const session = (id: string, name: string, extra: Partial<TodaySession> = {}): TodaySession => ({
  id, classId: `class-${id}`, name, coachName: null, location: null, color: null, startTime: "18:00", endTime: "19:00",
  maxCapacity: null, attendedCount: 0, waitlistCount: 0, status: "ongoing", isCancelled: false, cancellationReason: null, isMine: false, ...extra,
});
const DAY: TodaySession[] = [session("a", "Fundamentals", { auto: "on_now", onNowCount: 1 }), session("b", "No-Gi Advanced", { startTime: "19:00", endTime: "20:00", status: "future" })];

type Deferred = { promise: Promise<void>; release: () => void };
const deferred = (): Deferred => {
  let release!: () => void;
  const promise = new Promise<void>((r) => { release = r; });
  return { promise, release };
};

let inView: string[] = [];
class FakeDetector {
  static getSupportedFormats = async () => ["qr_code"];
  async detect() { return inView.map((rawValue) => ({ rawValue })); }
}

type Call = { url: string; method: string; body: unknown };
function stub(opts: { holdToday?: { current: Deferred | null } } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    const json = (status: number, b: unknown) => ({ ok: status < 300, status, type: "basic", headers: { get: () => "application/json" }, json: async () => b });
    if (url === "/api/coach/today") {
      if (opts.holdToday?.current) await opts.holdToday.current.promise;
      return json(200, DAY);
    }
    if (/^\/api\/coach\/instances\/[^/]+\/register$/.test(url)) {
      return json(200, {
        instance: { name: "x", maxCapacity: null, isKids: false, allowedTiers: [] },
        expected: [{ memberId: "ada", name: "Ada Example", attended: false, accountType: "adult", waiverAccepted: true, rank: null, attendedMethod: null, lastVisitAt: null, medicalConditions: null }],
        waitlist: [],
      });
    }
    if (url.startsWith("/api/checkin/members")) return json(200, []);
    if (url === "/api/checkin" && method === "POST") return json(201, { success: true });
    if (url === "/api/checkin/card" && method === "POST") return json(200, { results: [{ status: "checked_in", memberName: "Ada Example" }] });
    if (/^\/api\/classes\/[^/]+\/instances\/[^/]+$/.test(url) && method === "PATCH") return json(200, { ok: true });
    if (url === "/api/settings/kiosk") return json(200, { enabled: false, issuedAt: null });
    return json(404, { error: "Not found" });
  }));
  return calls;
}
const writes = (calls: Call[]) => calls.filter((c) => c.method !== "GET");
const cardPosts = (calls: Call[]) => calls.filter((c) => c.url === "/api/checkin/card" && c.method === "POST");

async function tick(ms = 250) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}
const hub = (role = "owner", initialMode: "tick" | "scan" = "scan") =>
  render(<AttendanceHub initialMode={initialMode} preselectClassId={null} role={role} primaryColor="#3b82f6" timeZone="Europe/London" />);
async function startCamera() {
  fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
  await tick(0);
  await tick(0);
  expect(screen.getByRole("button", { name: "Stop camera" })).toBeTruthy();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-25T18:20:00Z")); // Wednesday 25 November, 18:20 in London
  inView = [];
  (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = FakeDetector;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) } });
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn(async () => {}) });
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("1: the scanner is paused while the cancel confirmation is open, and until the day's list is back", () => {
  it("a card held during the confirmation sends nothing; Keep it resumes, and a hold then sends once to the class on screen", async () => {
    const calls = stub();
    hub();
    await tick(50);
    await startCamera();
    fireEvent.click(screen.getByRole("button", { name: /Session details/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel this session" }));
    const confirm = screen.getByRole("dialog");
    inView = ["card-1"];
    await tick(1500);
    expect(cardPosts(calls)).toHaveLength(0);
    // Lifted, the confirmation dismissed, then held again.
    inView = [];
    await tick(1500);
    fireEvent.click(within(confirm).getByRole("button", { name: "Keep it" }));
    await tick(50);
    inView = ["card-1"];
    await tick(1500);
    expect(cardPosts(calls).map((c) => (c.body as { classInstanceId: string }).classInstanceId)).toEqual(["a"]);
  });

  it("confirmed: nothing is sent while the day's list is read again, and once it is back a hold sends exactly once", async () => {
    const holdToday: { current: Deferred | null } = { current: null };
    const calls = stub({ holdToday });
    hub();
    await tick(50);
    await startCamera();
    fireEvent.click(screen.getByRole("button", { name: /Session details/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel this session" }));
    const confirm = screen.getByRole("dialog");
    inView = ["card-1"];
    await tick(1500);
    expect(cardPosts(calls)).toHaveLength(0);
    // Confirmed: the dialog closes and the day is read again, slowly; the card is still under the lens.
    holdToday.current = deferred();
    fireEvent.change(within(confirm).getByLabelText(/Reason/), { target: { value: "Coach ill" } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel this session" }));
    // One short step for the confirmation to close (React applies it when the step ends), then the window itself.
    await tick(50);
    expect(screen.queryByRole("dialog")).toBeNull();
    await tick(1500);
    expect(cardPosts(calls)).toHaveLength(0);
    // The list is back: the session's scanner starts again from scratch, camera off until started.
    const held = holdToday.current;
    holdToday.current = null;
    await act(async () => { held.release(); await vi.advanceTimersByTimeAsync(50); });
    expect(cardPosts(calls)).toHaveLength(0);
    await startCamera();
    await tick(1500);
    expect(cardPosts(calls)).toHaveLength(1);
    expect((cardPosts(calls)[0].body as { classInstanceId: string }).classInstanceId).toBe("a");
  });
});

describe("2: across the club's midnight with no focus or visibility event", () => {
  const NOTICE = "It is now Thursday 26 November. This register is for Wednesday 25 November. Reload to see today’s classes.";

  it("a mark pressed after midnight writes nothing and shows the dated notice; the class is not switched", async () => {
    vi.setSystemTime(new Date("2026-11-25T23:50:00Z")); // 23:50 in London
    const calls = stub();
    hub("coach", "tick");
    await tick(50);
    const button = screen.getByRole("button", { name: "Mark Ada Example attended" });
    vi.setSystemTime(new Date("2026-11-26T00:05:00Z")); // past the club's midnight; no event fired
    fireEvent.click(button);
    await tick(50);
    expect(writes(calls)).toEqual([]);
    expect(screen.getByTestId("stale-day").textContent).toContain(NOTICE);
    expect(screen.getByTestId("selected-class-name").textContent).toBe("Fundamentals");
    expect(screen.queryByRole("button", { name: "Change class" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reload" })).toBeTruthy();
  });

  it("a card held after midnight is not sent and shows the dated notice; the class is not switched", async () => {
    vi.setSystemTime(new Date("2026-11-25T23:50:00Z"));
    const calls = stub();
    hub("coach", "scan");
    await tick(50);
    await startCamera();
    vi.setSystemTime(new Date("2026-11-26T00:05:00Z"));
    inView = ["card-1"];
    await tick(1500);
    expect(writes(calls)).toEqual([]);
    expect(screen.getByTestId("stale-day").textContent).toContain(NOTICE);
    expect(screen.getByTestId("selected-class-name").textContent).toBe("Fundamentals");
  });
});
