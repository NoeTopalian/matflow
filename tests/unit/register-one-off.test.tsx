// @vitest-environment jsdom
//
// G4 (owner, 27 Oct 2026): the register's "Add as a one-off". A mark the
// server refuses for the allowance, the plan restriction or the squad list
// offers it on the refusal line; the dialog names the member and the session
// and requires a reason; Confirm sends `oneOff` (with whatever the desk
// already confirmed for that mark). A failed save keeps the typed reason and
// shows the error beside the action, and each Confirm sends one request.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";
import RegisterPanel from "@/components/dashboard/RegisterPanel";
import { ONE_OFF_REASON_ERROR } from "@/lib/one-off";

const toast = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast }) }));

const INSTANCE = {
  id: "inst-1", classId: "c1", name: "Competition", coachName: "Cian", location: "Mat 1", color: "#3b82f6",
  startTime: "18:00", endTime: "19:00", maxCapacity: 20, attendedCount: 0, waitlistCount: 0,
  status: "ongoing" as const, isCancelled: false, cancellationReason: null, isMine: true,
};

type Resp = { status: number; body: unknown } | "network" | "hang";
let calls: Array<{ url: string; init?: RequestInit }> = [];
let postResponses: Resp[] = [];
let registerExpected: unknown[] = [];
let release: (() => void) | null = null;
const posts = () => calls.filter((c) => c.url === "/api/checkin" && c.init?.method === "POST");
const postBody = (i: number) => JSON.parse(posts()[i].init!.body as string);

const ALLOWANCE = { status: 403, body: { error: "Ava Green has used all 4 classes this 4-week period.", reason: "allowance_reached" } };
const SQUAD = { status: 403, body: { error: "This class is for its squad list only.", reason: "roster_not_listed" } };
const RECORDED = { status: 201, body: { success: true, record: { id: "rec-1" }, oneOff: { id: "oo-1", reason: "Trial for the comp squad" } } };

type Candidate = { id: string; name: string; accountType: string; onHold?: boolean };
const AVA: Candidate = { id: "m1", name: "Ava Green", accountType: "adult" };

async function renderPanel(candidates: Candidate[] = [AVA]) {
  calls = [];
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.includes("/register")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ instance: { name: "Competition", maxCapacity: 20, isKids: false, allowedTiers: [] }, expected: registerExpected, waitlist: [] }),
      });
    }
    if (url.includes("/api/checkin/members")) return Promise.resolve({ ok: true, json: async () => candidates });
    const next = postResponses.shift() ?? RECORDED;
    if (next === "network") return Promise.reject(new TypeError("Failed to fetch"));
    if (next === "hang") return new Promise((resolve) => { release = () => resolve({ ok: true, status: 201, json: async () => RECORDED.body }); });
    return Promise.resolve({ ok: next.status < 300, status: next.status, json: async () => next.body });
  }) as unknown as typeof fetch;
  render(<RegisterPanel instance={INSTANCE} primaryColor="#3b82f6" onCountChange={() => {}} />);
  await act(async () => {});
  return screen.getByPlaceholderText(/Search members/i) as HTMLInputElement;
}

async function markByEnter(input: HTMLInputElement, q: string) {
  fireEvent.change(input, { target: { value: q } });
  await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
  await act(async () => {});
}

async function openDialog() {
  await act(async () => { fireEvent.click(screen.getByTestId("register-one-off-offer")); });
  await act(async () => {});
  return screen.getByTestId("register-one-off-reason") as HTMLTextAreaElement;
}

async function confirm() {
  await act(async () => { fireEvent.click(screen.getByTestId("register-one-off-confirm")); });
  await act(async () => {});
}

describe("RegisterPanel - Add as a one-off", () => {
  beforeEach(() => { postResponses = []; registerExpected = []; release = null; toast.mockClear(); });
  afterEach(() => { vi.restoreAllMocks(); });

  it("a refusal for the allowance offers it; the dialog names the member and the session and sends oneOff", async () => {
    postResponses = [ALLOWANCE, RECORDED];
    const input = await renderPanel();
    await markByEnter(input, "Ava");
    expect(screen.getByRole("alert").textContent).toContain("used all 4 classes");
    const reason = await openDialog();
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toContain("Ava Green");
    expect(dialog.textContent).toContain("Competition");
    expect(dialog.textContent).toContain("18:00");
    fireEvent.change(reason, { target: { value: "  Trial for the comp squad " } });
    await confirm();
    expect(posts()).toHaveLength(2);
    expect(postBody(1)).toEqual({
      classInstanceId: "inst-1", memberId: "m1", checkInMethod: "admin", oneOff: { reason: "Trial for the comp squad" },
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(toast).toHaveBeenCalledWith("Added as a one-off: Ava Green", "success");
    // The refusal line is cleared; the search is cleared for the next name.
    expect(screen.queryByTestId("register-one-off-offer")).toBeNull();
    expect(input.value).toBe("");
  });

  it("a refusal for the squad list offers it too; one the one-off cannot admit past does not", async () => {
    postResponses = [SQUAD];
    let input = await renderPanel();
    await markByEnter(input, "Ava");
    expect(screen.getByTestId("register-one-off-offer")).toBeTruthy();
    document.body.innerHTML = "";

    postResponses = [{ status: 409, body: { error: "Class has been cancelled", reason: "class_cancelled" } }];
    input = await renderPanel();
    await markByEnter(input, "Ava");
    expect(screen.getByRole("alert").textContent).toContain("cancelled");
    expect(screen.queryByTestId("register-one-off-offer")).toBeNull();
  });

  it("a failed save keeps the typed reason, shows the error beside the action, and a retry sends one request", async () => {
    postResponses = [ALLOWANCE, "network", { status: 500, body: { error: "Failed to check in" } }, RECORDED];
    const input = await renderPanel();
    await markByEnter(input, "Ava");
    const reason = await openDialog();
    fireEvent.change(reason, { target: { value: "Guest of the head coach" } });

    await confirm();
    expect(posts()).toHaveLength(2);
    expect(screen.getByTestId("register-one-off-error").textContent).toMatch(/Couldn.t reach MatFlow/);
    expect((screen.getByTestId("register-one-off-reason") as HTMLTextAreaElement).value).toBe("Guest of the head coach");

    await confirm();
    expect(posts()).toHaveLength(3);
    expect(screen.getByTestId("register-one-off-error").textContent).toBe("Failed to check in");
    expect((screen.getByTestId("register-one-off-reason") as HTMLTextAreaElement).value).toBe("Guest of the head coach");

    await confirm();
    expect(posts()).toHaveLength(4);
    expect(postBody(3).oneOff).toEqual({ reason: "Guest of the head coach" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a second press while the first is in flight sends nothing more", async () => {
    postResponses = [ALLOWANCE, "hang"];
    const input = await renderPanel();
    await markByEnter(input, "Ava");
    const reason = await openDialog();
    fireEvent.change(reason, { target: { value: "Guest of the head coach" } });
    await act(async () => { fireEvent.click(screen.getByTestId("register-one-off-confirm")); });
    await act(async () => { fireEvent.keyDown(screen.getByTestId("register-one-off-reason"), { key: "Enter" }); });
    expect(posts()).toHaveLength(2);
    await act(async () => { release?.(); });
    await act(async () => {});
    expect(posts()).toHaveLength(2);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("a reason under 3 characters is refused before anything is sent", async () => {
    postResponses = [ALLOWANCE];
    const input = await renderPanel();
    await markByEnter(input, "Ava");
    const reason = await openDialog();
    fireEvent.change(reason, { target: { value: " ok " } });
    await confirm();
    expect(posts()).toHaveLength(1);
    expect(screen.getByTestId("register-one-off-error").textContent).toBe(ONE_OFF_REASON_ERROR);
  });

  it("Enter in the reason confirms (keyboard), Escape closes and keeps the reason for that member", async () => {
    postResponses = [ALLOWANCE, RECORDED];
    const input = await renderPanel();
    await markByEnter(input, "Ava");
    let reason = await openDialog();
    fireEvent.change(reason, { target: { value: "Trial for the comp squad" } });
    await act(async () => { fireEvent.keyDown(document.activeElement ?? reason, { key: "Escape" }); });
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    reason = await openDialog();
    expect(reason.value).toBe("Trial for the comp squad");
    await act(async () => { fireEvent.keyDown(reason, { key: "Enter" }); });
    await act(async () => {});
    expect(posts()).toHaveLength(2);
    expect(postBody(1).oneOff).toEqual({ reason: "Trial for the comp squad" });
  });

  it("asks the same questions: what the desk confirmed for the refused mark travels with the one-off", async () => {
    postResponses = [ALLOWANCE, RECORDED];
    const input = await renderPanel([{ ...AVA, onHold: true }]);
    await markByEnter(input, "Ava");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: /Admit anyway/ })); });
    await act(async () => {});
    expect(postBody(0).acknowledged).toEqual(["on_hold"]);
    const reason = await openDialog();
    fireEvent.change(reason, { target: { value: "Back from injury, trial session" } });
    await confirm();
    expect(postBody(1)).toMatchObject({ acknowledged: ["on_hold"], oneOff: { reason: "Back from injury, trial session" } });
  });

  it("the row reads One-off · <reason>, and removing it says the one-off goes too", async () => {
    registerExpected = [{
      memberId: "m1", name: "Ava Green", accountType: "adult", waiverAccepted: true, rank: null,
      attended: true, attendedMethod: "admin", walkIn: true, lastVisitAt: null, medicalConditions: null,
      oneOff: { reason: "Trial for the comp squad", grantedByName: "Cian" },
    }];
    await renderPanel();
    expect(screen.getByTestId("register-one-off").textContent).toBe("One-off · Trial for the comp squad");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Mark Ava Green absent" })); });
    expect(screen.getByRole("dialog").textContent).toContain("The one-off is removed with it.");
  });
});
