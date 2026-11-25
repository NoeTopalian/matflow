// @vitest-environment jsdom
//
// Mark attendance (25 Nov 2026, Noe): guards on the writes.
//   1. The scanner sends nothing while the class picker OR the cancel
//      confirmation is open, nor while the day's list is being read again
//      after one; it resumes when the list is back.
//   2. A desk tablet left awake across the club's midnight: the first mark,
//      un-mark, card read, cancel or restore after the date changes writes
//      nothing and shows a dated Reload notice, with no focus, visibility or
//      timer event having fired, and the class is never switched by itself.
// The club is in Asia/Makassar (UTC+8, no DST), far from the machine's zone,
// so the club's midnight (16:00 UTC) and the device's are told apart. The
// server's answer carries the club's date and its own clock (X-Club-Date,
// X-Server-Time). Fake camera, fake clock and timers, mocked fetch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act, within, cleanup } from "@testing-library/react";
import React from "react";
import AttendanceHub from "@/components/dashboard/AttendanceHub";
import { SessionCancelControl, type TodaySession } from "@/components/dashboard/SessionPicker";

const { toastMock } = vi.hoisted(() => ({ toastMock: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastMock }) }));

const ZONE = "Asia/Makassar";
const session = (id: string, name: string, extra: Partial<TodaySession> = {}): TodaySession => ({
  id, classId: `class-${id}`, name, coachName: null, location: null, color: null, startTime: "18:00", endTime: "19:00",
  maxCapacity: null, attendedCount: 0, waitlistCount: 0, status: "ongoing", isCancelled: false, cancellationReason: null, isMine: false, ...extra,
});
const DAY: TodaySession[] = [
  session("a", "Fundamentals", { auto: "on_now", onNowCount: 1 }),
  session("b", "No-Gi Advanced", { startTime: "19:00", endTime: "20:00", status: "future" }),
  session("off", "Called Off", { startTime: "12:00", endTime: "13:00", status: "ended", isCancelled: true }),
];

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
type StubOpts = {
  holdToday?: { current: Deferred | null };
  holdPatch?: Deferred;
  holdDelete?: Deferred;
  deleteStatus?: number;
  /** Ada's row: already marked in, or without a signed waiver. */
  ada?: { attended?: boolean; waiverAccepted?: boolean };
  /** The server's clock less the device's, in ms (a device clock that is wrong). */
  serverAheadMs?: number;
};
const clubKey = (ms: number) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: ZONE }).format(new Date(ms));
function stub(opts: StubOpts = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    const json = (status: number, b: unknown, h: Record<string, string> = {}) =>
      ({ ok: status < 300, status, type: "basic", headers: { get: (n: string) => h[n] ?? (n.toLowerCase() === "content-type" ? "application/json" : null) }, json: async () => b });
    if (url === "/api/coach/today") {
      if (opts.holdToday?.current) await opts.holdToday.current.promise;
      const server = Date.now() + (opts.serverAheadMs ?? 0);
      return json(200, DAY, { "X-Club-Date": clubKey(server), "X-Server-Time": String(server) });
    }
    if (/^\/api\/coach\/instances\/[^/]+\/register$/.test(url)) {
      return json(200, {
        instance: { name: "x", maxCapacity: null, isKids: false, allowedTiers: [] },
        expected: [{ memberId: "ada", name: "Ada Example", attended: !!opts.ada?.attended, accountType: "adult", waiverAccepted: opts.ada?.waiverAccepted ?? true, rank: null, attendedMethod: opts.ada?.attended ? "admin" : null, lastVisitAt: null, medicalConditions: null }],
        waitlist: [],
      });
    }
    if (url.startsWith("/api/checkin/members")) return json(200, []);
    if (url === "/api/checkin" && method === "POST") return json(201, { success: true });
    if (url.startsWith("/api/checkin?") && method === "DELETE") {
      if (opts.holdDelete) await opts.holdDelete.promise;
      return opts.deleteStatus ? json(opts.deleteStatus, { error: "The check-in could not be removed." }) : json(200, { ok: true });
    }
    if (url === "/api/checkin/card" && method === "POST") return json(200, { results: [{ status: "checked_in", memberName: "Ada Example" }] });
    if (/^\/api\/classes\/[^/]+\/instances\/[^/]+$/.test(url) && method === "PATCH") {
      if (opts.holdPatch) await opts.holdPatch.promise;
      return json(200, { ok: true });
    }
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
  render(<AttendanceHub initialMode={initialMode} preselectClassId={null} role={role} primaryColor="#3b82f6" timeZone={ZONE} />);
async function startCamera() {
  fireEvent.click(screen.getByRole("button", { name: "Start camera" }));
  await tick(0);
  await tick(0);
  expect(screen.getByRole("button", { name: "Stop camera" })).toBeTruthy();
}
const openPicker = () => { fireEvent.click(screen.getByRole("button", { name: "Change class" })); return screen.getByRole("dialog", { name: "Change class" }); };

// 25 November in Makassar runs 2026-11-24T16:00Z to 2026-11-25T16:00Z.
const BEFORE_CLUB_MIDNIGHT = new Date("2026-11-25T15:50:00Z"); // 23:50 in Makassar, 15:50 on the device (UTC)
const AFTER_CLUB_MIDNIGHT = new Date("2026-11-25T16:05:00Z"); // 00:05 on 26 November in Makassar; still 25 November in UTC
const NOTICE = "It is now Thursday 26 November. This register is for Wednesday 25 November. Reload to see today’s classes.";
const vibrate = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-25T10:20:00Z")); // 18:20 in Makassar
  inView = [];
  toastMock.mockReset();
  vibrate.mockReset();
  (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = FakeDetector;
  Object.defineProperty(navigator, "mediaDevices", { configurable: true, value: { getUserMedia: vi.fn(async () => ({ getTracks: () => [{ stop: vi.fn() }] })) } });
  Object.defineProperty(navigator, "vibrate", { configurable: true, value: vibrate });
  Object.defineProperty(HTMLMediaElement.prototype, "readyState", { configurable: true, get: () => 4 });
  Object.defineProperty(HTMLMediaElement.prototype, "play", { configurable: true, value: vi.fn(async () => {}) });
  Object.defineProperty(HTMLMediaElement.prototype, "srcObject", { configurable: true, writable: true, value: null });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
  Object.defineProperty(window, "innerHeight", { configurable: true, value: 844 });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });

/** The dated notice is up, nothing was written, the class is the one on screen before, and focus is on Reload. */
function expectStale(calls: Call[], className = "Fundamentals") {
  expect(writes(calls)).toEqual([]);
  expect(screen.getByTestId("stale-day").textContent).toContain(NOTICE);
  expect(screen.getByTestId("selected-class-name").textContent).toBe(className);
  expect(screen.queryByRole("button", { name: "Change class" })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reload" }));
}

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

  it("2 (review): the hub is told the confirmation is open in the click itself, before the dialog is on screen", () => {
    // A unit test cannot see the frame between commit and paint; what it can pin is that the pause is not
    // left to an effect that runs after the dialog has rendered.
    const seen: Array<{ open: boolean; dialogOnScreen: boolean }> = [];
    render(<SessionCancelControl session={DAY[0]} onChanged={() => {}} onOpenChange={(open) => seen.push({ open, dialogOnScreen: !!document.querySelector('[role="dialog"]') })} />);
    fireEvent.click(screen.getByRole("button", { name: "Cancel this session" }));
    expect(seen).toEqual([{ open: true, dialogOnScreen: false }]);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Keep it" }));
    expect(seen.at(-1)).toEqual({ open: false, dialogOnScreen: true });
  });
});

describe("2: across the club's midnight (Asia/Makassar) with no focus or visibility event", () => {
  it("nothing goes stale at the device's (UTC) midnight: a mark at 08:10 in Makassar is written", async () => {
    vi.setSystemTime(new Date("2026-11-24T23:50:00Z")); // 07:50 on 25 November in Makassar
    const calls = stub();
    hub("coach", "tick");
    await tick(50);
    vi.setSystemTime(new Date("2026-11-25T00:10:00Z")); // the device's midnight has passed; the club's has not
    fireEvent.click(screen.getByRole("button", { name: "Mark Ada Example attended" }));
    await tick(50);
    expect(writes(calls).map((c) => `${c.method} ${c.url}`)).toEqual(["POST /api/checkin"]);
    expect(screen.queryByTestId("stale-day")).toBeNull();
  });

  it("a mark pressed after the club's midnight writes nothing and shows the dated notice; the class is not switched", async () => {
    vi.setSystemTime(BEFORE_CLUB_MIDNIGHT);
    const calls = stub();
    hub("coach", "tick");
    await tick(50);
    const button = screen.getByRole("button", { name: "Mark Ada Example attended" });
    vi.setSystemTime(AFTER_CLUB_MIDNIGHT);
    fireEvent.click(button);
    await tick(50);
    expectStale(calls);
  });

  it("an un-mark after the club's midnight writes nothing", async () => {
    vi.setSystemTime(BEFORE_CLUB_MIDNIGHT);
    const calls = stub({ ada: { attended: true } });
    hub("coach", "tick");
    await tick(50);
    vi.setSystemTime(AFTER_CLUB_MIDNIGHT);
    fireEvent.click(screen.getByRole("button", { name: "Mark Ada Example absent" }));
    await tick(50);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove check-in" }));
    await tick(50);
    expectStale(calls);
  });

  it("'Remove check-in' asked before the club's midnight and confirmed after it writes nothing", async () => {
    vi.setSystemTime(BEFORE_CLUB_MIDNIGHT);
    const calls = stub({ ada: { attended: true } });
    hub("coach", "tick");
    await tick(50);
    fireEvent.click(screen.getByRole("button", { name: "Mark Ada Example absent" }));
    await tick(50);
    const confirm = screen.getByRole("dialog");
    vi.setSystemTime(AFTER_CLUB_MIDNIGHT);
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove check-in" }));
    await tick(50);
    expectStale(calls);
  });

  it("'Admit anyway' (no signed waiver) asked before the club's midnight and confirmed after it writes nothing", async () => {
    vi.setSystemTime(BEFORE_CLUB_MIDNIGHT);
    const calls = stub({ ada: { waiverAccepted: false } });
    hub("coach", "tick");
    await tick(50);
    fireEvent.click(screen.getByRole("button", { name: "Mark Ada Example attended" }));
    await tick(50);
    const confirm = screen.getByRole("dialog");
    expect(confirm.textContent).toContain("hasn't signed the waiver");
    vi.setSystemTime(AFTER_CLUB_MIDNIGHT);
    fireEvent.click(within(confirm).getByRole("button", { name: "Admit anyway" }));
    await tick(50);
    expectStale(calls);
  });

  it("a card held after the club's midnight is not sent and gets no 'read' buzz; the dated notice shows", async () => {
    vi.setSystemTime(BEFORE_CLUB_MIDNIGHT);
    const calls = stub();
    hub("coach", "scan");
    await tick(50);
    await startCamera();
    vi.setSystemTime(AFTER_CLUB_MIDNIGHT);
    inView = ["card-1"];
    await tick(1500);
    expectStale(calls);
    expect(vibrate).not.toHaveBeenCalled();
  });

  it("1 (review): a cancel confirmed after the club's midnight sends no PATCH; the class is not switched", async () => {
    vi.setSystemTime(BEFORE_CLUB_MIDNIGHT);
    const calls = stub();
    hub("owner", "tick");
    await tick(50);
    fireEvent.click(screen.getByRole("button", { name: /Session details/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel this session" }));
    const confirm = screen.getByRole("dialog");
    fireEvent.change(within(confirm).getByLabelText(/Reason/), { target: { value: "Coach ill" } });
    vi.setSystemTime(AFTER_CLUB_MIDNIGHT);
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel this session" }));
    await tick(50);
    expect(screen.queryByRole("dialog")).toBeNull();
    expectStale(calls);
  });

  it("1 (review): a restore pressed after the club's midnight sends no PATCH; the class is not switched", async () => {
    vi.setSystemTime(BEFORE_CLUB_MIDNIGHT);
    const calls = stub();
    hub("owner", "tick");
    await tick(50);
    fireEvent.click(within(openPicker()).getByRole("button", { name: /Called Off/ }));
    await tick(50);
    vi.setSystemTime(AFTER_CLUB_MIDNIGHT);
    fireEvent.click(screen.getByRole("button", { name: "Restore session" }));
    await tick(50);
    expectStale(calls, "Called Off");
  });

  it("1 (review): a cancel sent before the club's midnight and answered after it: the re-read keeps the class and shows the notice", async () => {
    vi.setSystemTime(new Date("2026-11-25T15:59:30Z"));
    const holdPatch = deferred();
    const calls = stub({ holdPatch });
    hub("owner", "tick");
    await tick(50);
    fireEvent.click(screen.getByRole("button", { name: /Session details/ }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel this session" }));
    const confirm = screen.getByRole("dialog");
    fireEvent.change(within(confirm).getByLabelText(/Reason/), { target: { value: "Coach ill" } });
    fireEvent.click(within(confirm).getByRole("button", { name: "Cancel this session" }));
    await tick(50);
    vi.setSystemTime(AFTER_CLUB_MIDNIGHT);
    await act(async () => { holdPatch.release(); await vi.advanceTimersByTimeAsync(50); });
    // The PATCH was sent before midnight; the re-read after it finds the 26th and does not take it on.
    expect(writes(calls).map((c) => c.method)).toEqual(["PATCH"]);
    expect(screen.getByTestId("stale-day").textContent).toContain(NOTICE);
    expect(screen.getByTestId("selected-class-name").textContent).toBe("Fundamentals");
  });

  it("3 (review): a device clock 40 s fast neither hides the club's midnight nor marks into yesterday after it", async () => {
    // The server's clock reads 23:59:50 in Makassar; the device's already reads 00:00:30 on the 26th.
    vi.setSystemTime(new Date("2026-11-25T16:00:30Z"));
    const calls = stub({ serverAheadMs: -40_000 });
    hub("coach", "tick");
    await tick(50);
    // Before the club's real midnight, the list for the 25th takes marks.
    fireEvent.click(screen.getByRole("button", { name: "Mark Ada Example attended" }));
    await tick(50);
    expect(writes(calls)).toHaveLength(1);
    expect(screen.queryByTestId("stale-day")).toBeNull();
    // A minute later the club's date has changed by the server's clock: the next mark is refused.
    vi.setSystemTime(new Date("2026-11-25T16:01:30Z"));
    // (The stub's register does not keep the first mark, so the row offers a mark again.)
    fireEvent.click(screen.getByRole("button", { name: "Mark Ada Example attended" }));
    await tick(50);
    expect(writes(calls)).toHaveLength(1);
    expect(screen.getByTestId("stale-day").textContent).toContain(NOTICE);
  });
});

describe("6 (review): an un-mark that fails after the coach switched class", () => {
  it("is told in a toast naming the member and the class, not lost", async () => {
    const holdDelete = deferred();
    stub({ ada: { attended: true }, holdDelete, deleteStatus: 500 });
    hub("coach", "tick");
    await tick(50);
    fireEvent.click(screen.getByRole("button", { name: "Mark Ada Example absent" }));
    await tick(50);
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Remove check-in" }));
    await tick(50);
    fireEvent.click(within(openPicker()).getByRole("button", { name: /No-Gi Advanced/ }));
    await tick(50);
    await act(async () => { holdDelete.release(); await vi.advanceTimersByTimeAsync(50); });
    expect(toastMock).toHaveBeenCalledWith("Ada Example is still marked in to Fundamentals at 18:00: The check-in could not be removed.", "error");
  });
});
