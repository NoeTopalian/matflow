// @vitest-environment jsdom
//
// Round 11 (baseline 2.1): a refused tick was shown only in one banner at the top of
// the register. A coach ticking row 20 of 30 on a phone saw the row stay unticked and
// the reason off-screen. The refusal now sits under the row that was ticked (or under
// the search field for someone added from it); the top banner stays for the register
// itself failing to load; and the tick button gets focus back after its request.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, act, within, cleanup } from "@testing-library/react";
import React from "react";
import RegisterPanel from "@/components/dashboard/RegisterPanel";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

const INSTANCE = {
  id: "inst-1", classId: "c1", name: "Fundamentals", coachName: "Cian", location: "Mat 1", color: "#3b82f6",
  startTime: "18:00", endTime: "19:00", maxCapacity: 40, attendedCount: 0, waitlistCount: 0,
  status: "ongoing" as const, isCancelled: false, cancellationReason: null, isMine: true,
};

const REFUSAL = "Member 20 has used all 4 classes this 4-week period (resets on Monday 26 October) and has no class-pack credit, so they can't be checked in.";

const row = (i: number, attended = false) => ({
  memberId: `m${i}`, name: `Member ${i}`, accountType: "adult", waiverAccepted: true, rank: null,
  attended, attendedMethod: attended ? "admin" : null, lastVisitAt: null, medicalConditions: null,
});

type Reply = { status: number; body: unknown } | "network" | Promise<{ status: number; body: unknown }>;
let replies: Reply[] = [];
let attended = new Set<string>();

async function renderPanel(candidates: { id: string; name: string; accountType: string }[] = []) {
  global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.includes("/register")) {
      return {
        ok: true,
        json: async () => ({
          instance: { name: "Fundamentals", maxCapacity: 40, isKids: false, allowedTiers: [] },
          expected: Array.from({ length: 30 }, (_, k) => row(k + 1, attended.has(`m${k + 1}`))),
          waitlist: [],
        }),
      };
    }
    if (url.includes("/api/checkin/members")) return { ok: true, json: async () => candidates };
    const next = replies.shift() ?? { status: 201, body: { success: true } };
    if (next === "network") throw new TypeError("Failed to fetch");
    const r = await next;
    if (init?.method === "POST" && r.status < 300) attended.add(JSON.parse(init.body as string).memberId);
    return { ok: r.status < 300, status: r.status, json: async () => r.body };
  }) as unknown as typeof fetch;
  render(<RegisterPanel instance={INSTANCE} primaryColor="#3b82f6" onCountChange={() => {}} />);
  await act(async () => {});
}

const rowOf = (name: string) => screen.getByText(name, { selector: "p" }).closest("li") as HTMLElement;
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });

afterEach(() => { cleanup(); replies = []; attended = new Set(); vi.restoreAllMocks(); });

describe("register: a refused tick is shown on the row that was ticked (Round 11, 2.1)", () => {
  it("row 20's refusal is inside row 20, not in a banner at the top", async () => {
    replies = [{ status: 403, body: { error: REFUSAL, reason: "allowance_reached" } }];
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Mark Member 20 attended" }));
    await settle();
    const alerts = screen.getAllByRole("alert");
    expect(alerts).toHaveLength(1);
    expect(within(rowOf("Member 20")).getByRole("alert").textContent).toContain(REFUSAL);
    expect(within(rowOf("Member 19")).queryByRole("alert")).toBeNull();
  });

  it("a dropped request is also said on the row, and a successful retry clears it", async () => {
    replies = ["network", { status: 201, body: { success: true } }];
    await renderPanel();
    fireEvent.click(screen.getByRole("button", { name: "Mark Member 20 attended" }));
    await settle();
    expect(within(rowOf("Member 20")).getByRole("alert").textContent).toContain("Couldn't reach MatFlow");
    fireEvent.click(screen.getByRole("button", { name: "Mark Member 20 attended" }));
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("button", { name: "Mark Member 20 absent" })).toBeTruthy();
  });

  it("a failed un-tick is said on that row", async () => {
    attended = new Set(["m7"]);
    replies = [{ status: 409, body: { error: "This check-in was already removed." } }];
    await renderPanel();
    const untick = screen.getByRole("button", { name: "Mark Member 7 absent" });
    untick.focus(); // a tap or Enter puts focus on the tick; jsdom's click does not
    fireEvent.click(untick);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Remove check-in" }));
    await settle();
    expect(within(rowOf("Member 7")).getByRole("alert").textContent).toContain("already removed");
    // After the "Remove this check-in?" question and the failed request, focus is on that row's tick.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Mark Member 7 absent" }));
  });

  it("a booked member added from the search is refused under the search field, not on their row; editing the search clears it", async () => {
    replies = [{ status: 403, body: { error: REFUSAL } }];
    await renderPanel([{ id: "m20", name: "Member 20", accountType: "adult" }]);
    const search = screen.getByLabelText("Search members");
    fireEvent.change(search, { target: { value: "Member 20" } });
    await act(async () => { fireEvent.keyDown(search, { key: "Enter" }); });
    await settle();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(REFUSAL);
    expect(within(rowOf("Member 20")).queryByRole("alert")).toBeNull();
    expect(search.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.change(search, { target: { value: "Member 2" } });
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("focus is not pulled back if the person moved on while the request ran", async () => {
    let answer!: (r: { status: number; body: unknown }) => void;
    replies = [new Promise((r) => { answer = r; })];
    await renderPanel();
    const tick = screen.getByRole("button", { name: "Mark Member 20 attended" });
    tick.focus();
    fireEvent.click(tick);
    await act(async () => {});
    const search = screen.getByLabelText("Search members");
    search.focus();
    answer({ status: 403, body: { error: REFUSAL } });
    await settle();
    expect(document.activeElement).toBe(search);
  });

  it("someone added from the search is refused under the search field", async () => {
    replies = [{ status: 403, body: { error: "Walk In isn't included in Kids Monthly." } }];
    await renderPanel([{ id: "w1", name: "Walk In", accountType: "adult" }]);
    const search = screen.getByLabelText("Search members");
    fireEvent.change(search, { target: { value: "Walk" } });
    await act(async () => { fireEvent.keyDown(search, { key: "Enter" }); });
    await settle();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("isn't included");
    expect(alert.closest("li")).toBeNull();
    // It follows the search field, so it is where the person is looking.
    expect(search.compareDocumentPosition(alert) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("the tick button gets focus back when the browser dropped it while the request ran", async () => {
    let answer!: (r: { status: number; body: unknown }) => void;
    replies = [new Promise((r) => { answer = r; })];
    await renderPanel();
    const tick = screen.getByRole("button", { name: "Mark Member 20 attended" });
    tick.focus();
    fireEvent.click(tick);
    await act(async () => {});
    // A browser moves focus off a control that becomes disabled (jsdom does not, and
    // will not blur a disabled button): park focus on a node, then remove it.
    const parked = document.createElement("input");
    document.body.appendChild(parked);
    parked.focus();
    parked.remove();
    expect(document.activeElement).toBe(document.body);
    answer({ status: 403, body: { error: REFUSAL } });
    await settle();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Mark Member 20 attended" }));
  });
});
