// @vitest-environment jsdom
// The Member filter's search box (components/activity/MemberSearchPicker.tsx):
// what it asks, what it says in each state, and where the keyboard is left.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React, { useState } from "react";

import { MemberSearchPicker, type PickedMember } from "@/components/activity/MemberSearchPicker";

type Pending = { url: string; signal: AbortSignal; resolve: (status: number, body: unknown) => void };
let pending: Pending[] = [];
const picks: (PickedMember | null)[] = [];

const person = (n: number) => ({ id: `m${n}`, name: `Member ${n}`, email: `m${n}@example.test`, status: "active" });

beforeEach(() => {
  vi.useFakeTimers();
  pending = [];
  picks.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      (url: string, init?: { signal?: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const signal = init!.signal!;
          signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
          pending.push({ url, signal, resolve: (status, body) => resolve({ ok: status >= 200 && status < 300, status, json: async () => body }) });
        }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** The picker as the page holds it: the picked member comes back in as `value`. */
function Harness() {
  const [value, setValue] = useState<PickedMember | null>(null);
  return (
    <MemberSearchPicker
      value={value}
      onChange={(member) => {
        picks.push(member);
        setValue(member);
      }}
    />
  );
}

const field = () => screen.getByRole("combobox", { name: "Member" }) as HTMLInputElement;
const spoken = () => screen.getByTestId("member-search-status").textContent;
const type = async (text: string, wait = 300) => {
  fireEvent.focus(field());
  fireEvent.change(field(), { target: { value: text } });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(wait);
  });
};
const answer = async (p: Pending, status: number, body: unknown) => {
  await act(async () => {
    p.resolve(status, body);
    await vi.advanceTimersByTimeAsync(0);
  });
};

describe("MemberSearchPicker", () => {
  it("asks nothing for one character, then asks once for eight matches after a pause", async () => {
    render(<Harness />);
    await type("m");
    expect(pending).toHaveLength(0);
    expect(screen.getByText("Type at least 2 characters")).toBeTruthy();
    await type("me", 299);
    expect(pending).toHaveLength(0);
    expect(screen.getByText("Searching…")).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(pending.map((p) => p.url)).toEqual(["/api/members?search=me&take=8"]);
  });

  it("lists the matches, says how many, and marks a child account and a cancelled member", async () => {
    render(<Harness />);
    await type("me");
    await answer(pending[0], 200, { members: [person(1), { id: "k1", name: "Kid One", email: "kid-abc@no-login.matflow.local", status: "cancelled" }] });
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["Member 1m1@example.test", expect.stringMatching(/^Kid One.* · Cancelled$/)]);
    expect(spoken()).toBe("2 members found");
    // Only options are inside the listbox, and the field points at it only while it exists.
    expect([...screen.getByRole("listbox").children].every((el) => el.getAttribute("role") === "option")).toBe(true);
    expect(field().getAttribute("aria-controls")).toBe(screen.getByRole("listbox").id);
  });

  it("says when nobody matches, and when there may be more than the eight shown", async () => {
    render(<Harness />);
    await type("zz");
    await answer(pending[0], 200, { members: [] });
    expect(screen.getByText("No member matches “zz”")).toBeTruthy();
    expect(spoken()).toBe("No member matches zz");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(field().getAttribute("aria-controls")).toBeNull();
    await type("me");
    await answer(pending[1], 200, { members: Array.from({ length: 9 }, (_, i) => person(i + 1)) });
    expect(screen.getAllByRole("option")).toHaveLength(8);
    expect(screen.getByText("Showing the first 8 — keep typing to narrow")).toBeTruthy();
    expect(spoken()).toBe("8 members found");
  });

  it("a failed search says so — never 'no member matches' — and Enter tries again", async () => {
    render(<Harness />);
    await type("me");
    await answer(pending[0], 500, {});
    expect(screen.getByText("Couldn't search members")).toBeTruthy();
    expect(screen.queryByText(/No member matches/)).toBeNull();
    expect(spoken()).toBe("Couldn't search members. Press Enter to try again.");
    fireEvent.keyDown(field(), { key: "Enter" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(pending).toHaveLength(2);
    await answer(pending[1], 200, { members: [person(1)] });
    expect(screen.getAllByRole("option")).toHaveLength(1);
  });

  it("the arrow keys move, Enter picks, and focus lands on the clear button", async () => {
    render(<Harness />);
    await type("me");
    await answer(pending[0], 200, { members: [person(1), person(2), person(3)] });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "ArrowDown" });
    fireEvent.keyDown(field(), { key: "ArrowUp" });
    expect(screen.getAllByRole("option").map((o) => o.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    expect(field().getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1].id);
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(picks).toEqual([{ id: "m2", name: "Member 2" }]);
    const clear = screen.getByRole("button", { name: "Clear member filter: Member 2" });
    expect(document.activeElement).toBe(clear);
    // Clearing brings the field back, empty, with the caret in it.
    fireEvent.click(clear);
    expect(picks.at(-1)).toBeNull();
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("");
  });

  it("Escape closes the list and keeps what was typed", async () => {
    render(<Harness />);
    await type("me");
    await answer(pending[0], 200, { members: [person(1)] });
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(screen.queryByRole("option")).toBeNull();
    expect(field().value).toBe("me");
    expect(field().getAttribute("aria-expanded")).toBe("false");
    expect(picks).toEqual([]);
  });

  it("the matches for what was typed before are never offered for the new text, and a late answer is dropped", async () => {
    render(<Harness />);
    await type("me");
    await answer(pending[0], 200, { members: [person(1)] });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    // More typing: the old match goes at once, before the pause is over, so Enter cannot pick it.
    fireEvent.change(field(), { target: { value: "mel" } });
    expect(screen.queryByRole("option")).toBeNull();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(picks).toEqual([]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    const first = pending[1];
    await type("melo");
    expect(first.signal.aborted).toBe(true);
    await answer(first, 200, { members: [person(7)] });
    expect(screen.queryByRole("option")).toBeNull();
    await answer(pending[2], 200, { members: [person(2)] });
    expect(screen.getAllByRole("option").map((o) => o.textContent)).toEqual(["Member 2m2@example.test"]);
  });

  it("a space after the text is not new text: the matches stay, and Enter still picks", async () => {
    render(<Harness />);
    await type("me");
    await answer(pending[0], 200, { members: [person(1)] });
    fireEvent.change(field(), { target: { value: "me " } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    // Nothing new to search for, so nothing was asked and nothing was withdrawn.
    expect(pending).toHaveLength(1);
    expect(screen.getAllByRole("option")).toHaveLength(1);
    expect(screen.queryByText("Searching…")).toBeNull();
    fireEvent.keyDown(field(), { key: "Enter" });
    expect(picks).toEqual([{ id: "m1", name: "Member 1" }]);
  });

  it("a member who is no longer in the club is shown as removed, and can be cleared", () => {
    render(<MemberSearchPicker value={{ id: "gone", name: null }} onChange={(m) => picks.push(m)} />);
    expect(screen.getByTestId("member-picked").textContent).toContain("Removed member");
    fireEvent.click(screen.getByRole("button", { name: "Clear member filter: removed member" }));
    expect(picks).toEqual([null]);
  });
});
