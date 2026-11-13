// @vitest-environment jsdom
//
// Round 6 (13 Nov 2026): a booking whose reply is lost. The server commits the
// booking (the route is idempotent, so a retry is safe), but the network drops
// the answer. The member schedule rolled the button back to "not booked" and
// said "Couldn't book this class", the opposite of what the database holds,
// until the page was reloaded. When the answer is unknown (no reply, or a
// server error), the page now re-reads the member's bookings and shows this
// class as the server holds it. It says the change did not happen only after a
// server error (which rolled back); with no reply the request may still land,
// so it says only that it could not be confirmed.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/member/schedule" }));
const toasts = vi.hoisted(() => ({ list: [] as Array<{ text: string; tone?: string }> }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: (text: string, tone?: string) => toasts.list.push({ text, tone }) }) }));

import MemberSchedulePage from "@/app/member/schedule/page";

const A = "cls_lost_reply";
const B = "cls_other";
const row = (classId: string, name: string, startTime: string) => {
  const now = new Date();
  return {
    id: `${classId}-sch1`, classId, scheduleId: "sch1", name, color: "#3b82f6",
    startTime, endTime: `${String(Number(startTime.slice(0, 2)) + 1).padStart(2, "0")}:00`, coach: "Sam Doe", location: "Mat 1", capacity: 20,
    dayOfWeek: now.getDay(), classInstanceId: null, eligibility: "ok", requiredRankName: null, maxRankName: null,
  };
};

/** The server's bookings, changed only by a request that reaches it. */
let serverBooked: Set<string>;
/**
 * What happens to a booking request for class A.
 * "lost": it commits, then the reply never arrives. "dropped": no reply and nothing committed (re-read works).
 * "down": a 503 that changed nothing. "offline": no reply, and every request after it fails too.
 */
let mode: "lost" | "dropped" | "down" | "offline";
let offline = false;
/** Class B's booking request hangs until released: it commits and answers 201 then. */
let releaseB: (() => void) | null = null;

function stubFetch() {
  offline = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = init?.method ?? "GET";
    if (offline) throw new TypeError("Failed to fetch");
    if (url.startsWith("/api/member/schedule")) return { ok: true, status: 200, json: async () => [row(A, "Beginner BJJ", "18:00"), row(B, "Advanced BJJ", "20:00")] } as Response;
    if (url.startsWith("/api/member/me/subscriptions")) return { ok: true, status: 200, json: async () => ({ classIds: [...serverBooked] }) } as Response;
    if (url.startsWith(`/api/member/class-subscriptions/${B}`)) {
      await new Promise<void>((resolve) => { releaseB = resolve; });
      serverBooked.add(B);
      return { ok: true, status: 201, json: async () => ({ success: true }) } as Response;
    }
    if (url.startsWith("/api/member/class-subscriptions/")) {
      if (mode === "lost") {
        if (method === "POST") serverBooked.add(A); else serverBooked.delete(A);
        throw new TypeError("Failed to fetch");
      }
      if (mode === "dropped") throw new TypeError("Failed to fetch");
      if (mode === "down") return { ok: false, status: 503, json: async () => ({}) } as Response;
      offline = true;
      throw new TypeError("Failed to fetch");
    }
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
}

beforeEach(() => {
  toasts.list = [];
  serverBooked = new Set();
  releaseB = null;
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};
});

/** Let the booking request, and anything it triggers, finish. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });
const errorsShown = () => toasts.list.filter((t) => t.tone === "error");

async function load() {
  render(<MemberSchedulePage />);
  await waitFor(() => expect(screen.getAllByText(/Beginner BJJ/i).length).toBeGreaterThan(0));
}
const openClass = (name: RegExp) => fireEvent.click(screen.getAllByText(name)[0]);

describe("member schedule: a booking whose answer is lost", () => {
  it("the booking committed but the reply was lost: the page shows it booked and does not say it failed", async () => {
    mode = "lost";
    stubFetch();
    await load();
    openClass(/Beginner BJJ/i);
    fireEvent.click(await screen.findByRole("button", { name: /subscribe to class/i }));
    await settle();
    expect(screen.getByRole("button", { name: /unsubscribe/i })).toBeTruthy();
    expect(errorsShown()).toEqual([]);
  });

  it("an un-booking that committed but whose reply was lost: the page shows it un-booked", async () => {
    mode = "lost";
    serverBooked.add(A);
    stubFetch();
    await load();
    openClass(/Beginner BJJ/i);
    fireEvent.click(await screen.findByRole("button", { name: /unsubscribe/i }));
    await settle();
    expect(screen.getByRole("button", { name: /subscribe to class/i })).toBeTruthy();
    expect(errorsShown()).toEqual([]);
  });

  it("no reply and nothing committed: shown as not booked, and only 'couldn't confirm' (it may still land), never 'couldn't book'", async () => {
    mode = "dropped";
    stubFetch();
    await load();
    openClass(/Beginner BJJ/i);
    fireEvent.click(await screen.findByRole("button", { name: /subscribe to class/i }));
    await settle();
    expect(screen.getByRole("button", { name: /subscribe to class/i })).toBeTruthy();
    expect(errorsShown().map((t) => t.text)).toEqual([expect.stringMatching(/couldn't confirm the booking/i)]);
  });

  it("a server error that booked nothing: the re-read shows not booked, and the member is told it did not go through", async () => {
    mode = "down";
    stubFetch();
    await load();
    openClass(/Beginner BJJ/i);
    fireEvent.click(await screen.findByRole("button", { name: /subscribe to class/i }));
    await waitFor(() => expect(errorsShown().length).toBe(1));
    expect(screen.getByRole("button", { name: /subscribe to class/i })).toBeTruthy();
    expect(errorsShown()[0].text).toMatch(/couldn't book/i);
  });

  it("no reply and the re-read fails too: told the outcome is unknown, never that it failed; the button shows the last known state", async () => {
    mode = "offline";
    stubFetch();
    await load();
    openClass(/Beginner BJJ/i);
    fireEvent.click(await screen.findByRole("button", { name: /subscribe to class/i }));
    await waitFor(() => expect(errorsShown().length).toBe(1));
    const text = errorsShown()[0].text;
    expect(text).not.toMatch(/couldn't book/i);
    expect(text).toMatch(/couldn't confirm/i);
    expect(screen.getByRole("button", { name: /subscribe to class/i })).toBeTruthy();
  });

  it("another class's booking in flight is not undone by this class's re-read (review finding, 13 Nov)", async () => {
    mode = "dropped";
    stubFetch();
    await load();
    // B's booking is sent and hangs.
    openClass(/Advanced BJJ/i);
    fireEvent.click(await screen.findByRole("button", { name: /subscribe to class/i }));
    await settle();
    // A's booking gets no reply; its re-read reaches the server before B's has committed.
    openClass(/Beginner BJJ/i);
    fireEvent.click(await screen.findByRole("button", { name: /subscribe to class/i }));
    await settle();
    // B now commits and answers 201.
    await act(async () => { releaseB?.(); });
    await settle();
    openClass(/Advanced BJJ/i);
    expect(await screen.findByRole("button", { name: /unsubscribe/i })).toBeTruthy();
    expect(serverBooked.has(B)).toBe(true);
  });
});
