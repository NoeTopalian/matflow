// @vitest-environment jsdom
//
// G5 (owner decision, 27 Oct 2026): the Settings switch "Members can check
// themselves in from the app". It confirms, PATCHes exactly
// { memberAppCheckin }, and only moves once the server has saved it.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const toastMock = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastMock }) }));

import {
  MemberAppCheckinSetting,
  MEMBER_APP_CHECKIN_LABEL,
  MEMBER_APP_CHECKIN_OFF_HINT,
  MEMBER_APP_CHECKIN_ON_HINT,
} from "@/components/dashboard/MemberAppCheckinSetting";

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
  globalThis.fetch = fetchMock as unknown as typeof fetch;
});

function confirmButton(label: RegExp) {
  return screen.getAllByRole("button").find((b) => label.test(b.textContent ?? "")) as HTMLButtonElement;
}

describe("MemberAppCheckinSetting", () => {
  it("shows the owner's label and a one-line explanation of what off does", () => {
    render(<MemberAppCheckinSetting initialEnabled={true} />);
    expect(screen.getByText(MEMBER_APP_CHECKIN_LABEL)).toBeTruthy();
    expect(MEMBER_APP_CHECKIN_LABEL).toBe("Members can check themselves in from the app");
    expect(screen.getByTestId("member-app-checkin-hint").textContent).toBe(MEMBER_APP_CHECKIN_ON_HINT);
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
    for (const s of [MEMBER_APP_CHECKIN_LABEL, MEMBER_APP_CHECKIN_ON_HINT, MEMBER_APP_CHECKIN_OFF_HINT]) expect(s).not.toContain("!");
  });

  it("turning it off confirms, sends { memberAppCheckin: false } and then shows the off explanation", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: "t", memberAppCheckin: false }), { status: 200 }));
    render(<MemberAppCheckinSetting initialEnabled={true} />);
    fireEvent.click(screen.getByRole("switch"));
    // Nothing is sent before the owner confirms.
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(confirmButton(/^Turn off$/));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/settings");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ memberAppCheckin: false });
    await waitFor(() => expect(screen.getByTestId("member-app-checkin-hint").textContent).toBe(MEMBER_APP_CHECKIN_OFF_HINT));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("false");
  });

  it("a failed save leaves the switch where it was and says so", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "Only owners can change gym settings" }), { status: 403 }));
    render(<MemberAppCheckinSetting initialEnabled={true} />);
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(confirmButton(/^Turn off$/));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("Only owners can change gym settings"));
    expect(screen.getByRole("switch").getAttribute("aria-checked")).toBe("true");
  });
});
