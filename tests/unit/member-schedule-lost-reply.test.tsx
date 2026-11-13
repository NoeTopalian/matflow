// @vitest-environment jsdom
//
// Round 6 (13 Nov 2026): a booking whose reply is lost. The server commits the
// booking (the route is idempotent, so a retry is safe), but the network drops
// the answer. The member schedule rolled the button back to "not booked" and
// said "Couldn't book this class", the opposite of what the database holds,
// until the page was reloaded. When the answer is unknown (no reply, or a
// server error), the page now re-reads the member's bookings and shows what is
// true; it claims a failure only when the re-read shows one.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent, act } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/member/schedule" }));
const toasts = vi.hoisted(() => ({ list: [] as Array<{ text: string; tone?: string }> }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: (text: string, tone?: string) => toasts.list.push({ text, tone }) }) }));

import MemberSchedulePage from "@/app/member/schedule/page";

const CLASS_ID = "cls_lost_reply";
const row = () => {
  const now = new Date();
  return {
    id: `${CLASS_ID}-sch1`, classId: CLASS_ID, scheduleId: "sch1", name: "Beginner BJJ", color: "#3b82f6",
    startTime: "18:00", endTime: "19:00", coach: "Sam Doe", location: "Mat 1", capacity: 20,
    dayOfWeek: now.getDay(), classInstanceId: null, eligibility: "ok", requiredRankName: null, maxRankName: null,
  };
};

/** The server's bookings, changed only by a request that reaches it. */
let serverBooked: Set<string>;
/**
 * What happens to the booking request. "lost": it commits on the server, then the reply never arrives.
 * "down": a 503 that changed nothing. "offline": no reply, and every request after it fails too.
 */
let mode: "lost" | "down" | "offline";
let offline = false;

function stubFetch() {
  offline = false;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    const method = init?.method ?? "GET";
    if (offline) throw new TypeError("Failed to fetch");
    if (url.startsWith("/api/member/schedule")) return { ok: true, status: 200, json: async () => [row()] } as Response;
    if (url.startsWith("/api/member/me/subscriptions")) return { ok: true, status: 200, json: async () => ({ classIds: [...serverBooked] }) } as Response;
    if (url.startsWith("/api/member/class-subscriptions/")) {
      if (mode === "lost") {
        if (method === "POST") serverBooked.add(CLASS_ID); else serverBooked.delete(CLASS_ID);
        throw new TypeError("Failed to fetch");
      }
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
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function scrollTo() {};
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function scrollIntoView() {};
});

/** Let the booking request, and anything it triggers, finish. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

async function openSheet() {
  render(<MemberSchedulePage />);
  await waitFor(() => expect(screen.getAllByText(/Beginner BJJ/i).length).toBeGreaterThan(0));
  fireEvent.click(screen.getAllByText(/Beginner BJJ/i)[0]);
}

describe("member schedule: a booking whose answer is lost", () => {
  it("the booking committed but the reply was lost: the page shows it booked and does not say it failed", async () => {
    mode = "lost";
    stubFetch();
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: /subscribe to class/i }));
    await settle();
    expect(screen.getByRole("button", { name: /unsubscribe/i })).toBeTruthy();
    expect(toasts.list.filter((t) => t.tone === "error")).toEqual([]);
  });

  it("an un-booking that committed but whose reply was lost: the page shows it un-booked", async () => {
    mode = "lost";
    serverBooked.add(CLASS_ID);
    stubFetch();
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: /unsubscribe/i }));
    await settle();
    expect(screen.getByRole("button", { name: /subscribe to class/i })).toBeTruthy();
    expect(toasts.list.filter((t) => t.tone === "error")).toEqual([]);
  });

  it("a server error that booked nothing: the re-read shows not booked, and the member is told it did not go through", async () => {
    mode = "down";
    stubFetch();
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: /subscribe to class/i }));
    await waitFor(() => expect(toasts.list.some((t) => t.tone === "error")).toBe(true));
    expect(screen.getByRole("button", { name: /subscribe to class/i })).toBeTruthy();
    expect(toasts.list.find((t) => t.tone === "error")!.text).toMatch(/couldn't book/i);
  });

  it("no reply and the re-read fails too: the member is told the outcome is unknown, never that it failed", async () => {
    mode = "offline";
    stubFetch();
    await openSheet();
    fireEvent.click(await screen.findByRole("button", { name: /subscribe to class/i }));
    await waitFor(() => expect(toasts.list.some((t) => t.tone === "error")).toBe(true));
    const text = toasts.list.find((t) => t.tone === "error")!.text;
    expect(text).not.toMatch(/couldn't book/i);
    expect(text).toMatch(/couldn't confirm/i);
  });
});
