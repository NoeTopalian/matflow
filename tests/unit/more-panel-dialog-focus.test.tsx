// @vitest-environment jsdom
// Round 11, review of #97 (M1): a class opened from the "+N more" panel keeps the panel (and the row that opened it), so
// closing the class sheet returns focus to that row instead of <body>. Adapted from the reviewer's jsdom probe.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";
vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/member/schedule" }));
import MemberSchedulePage from "@/app/member/schedule/page";
function row(n: number) {
  return { id: `cls_${n}-sch_${n}`, classId: `cls_${n}`, scheduleId: `sch_${n}`, name: `Class ${n}`, color: "#3b82f6",
    startTime: "18:00", endTime: "19:00", coach: "Sam", location: "Mat 1", capacity: 20, dayOfWeek: new Date().getDay(),
    classInstanceId: null, eligibility: "ok", requiredRankName: null, maxRankName: null };
}
beforeEach(() => {
  if (!Element.prototype.scrollTo) Element.prototype.scrollTo = function () {};
  Element.prototype.scrollIntoView = Element.prototype.scrollIntoView ?? function () {};
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/api/member/schedule")) return { ok: true, status: 200, json: async () => [1,2,3,4,5].map(row) } as Response;
    if (url.startsWith("/api/member/me/subscriptions")) return { ok: true, status: 200, json: async () => ({ classIds: [] }) } as Response;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }));
});
afterEach(() => { cleanup(); document.body.style.overflow = ""; });
describe("a class opened from \"+N more\"", () => {
  it("keeps the panel open while its sheet is open, and Escape returns focus to the row", async () => {
    render(<MemberSchedulePage />);
    const pane = await waitFor(() => { const p = screen.getByTestId("schedule-pane"); const m = p.querySelector('[data-testid="schedule-more"]'); expect(m).toBeTruthy(); return p; });
    const more = pane.querySelector<HTMLElement>('[data-testid="schedule-more"]')!;
    more.focus(); fireEvent.click(more);
    const panel = await waitFor(() => { const x = pane.querySelector<HTMLElement>('[data-testid="more-panel"]'); expect(x).toBeTruthy(); return x!; });
    const rowBtn = document.activeElement as HTMLElement;
    expect(panel.contains(rowBtn)).toBe(true);
    fireEvent.click(rowBtn);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(pane.querySelector('[data-testid="more-panel"]')).toBeTruthy();
    expect(document.contains(rowBtn)).toBe(true);
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(rowBtn));
  });
});
