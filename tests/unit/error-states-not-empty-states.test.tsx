// @vitest-environment jsdom
//
// UI-RULES §7: an HTTP error is never an empty state.
//
// The regression these tests exist for is not cosmetic. Every case below is a
// failed request that the UI used to describe as ordinary emptiness, and each
// one has a consequence a person then acts on:
//
//   AdhocChargeDrawer  — a failed card lookup printed "No saved card", so the
//                        front desk takes cash for a charge that would have
//                        gone on the member's card. Money.
//   MemberActionsPanel — a failed task load printed "Nothing to do", so a
//                        member with an unsigned waiver trains anyway.
//   PromotionAlerts    — a failed check printed nothing at all, so kids stay
//                        on child accounts with no sign the check ever ran.
//
// The assertions are deliberately about the COPY, not the internals: the bug
// was never in the state shape, it was in what the screen said.

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import React from "react";

import AdhocChargeDrawer from "@/components/dashboard/AdhocChargeDrawer";
import MemberActionsPanel from "@/components/member/MemberActionsPanel";
import PromotionAlerts from "@/components/dashboard/PromotionAlerts";
import { ToastProvider } from "@/components/ui/Toast";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockFetch(impl: (url: string) => Promise<unknown>) {
  global.fetch = vi.fn((url: string) => impl(String(url))) as unknown as typeof fetch;
}

const ok = (body: unknown) =>
  Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) } as unknown as Response);
const status = (code: number) =>
  Promise.resolve({ ok: false, status: code, json: () => Promise.resolve({}) } as unknown as Response);

const CARD = { brand: "visa", last4: "4242", expMonth: 4, expYear: 2029 };

function renderDrawer() {
  render(
    <ToastProvider>
      <AdhocChargeDrawer memberId="m1" memberName="Ana Silva" open onClose={vi.fn()} />
    </ToastProvider>,
  );
}

describe("AdhocChargeDrawer — 'no card' and 'couldn't check' are different states", () => {
  it("says the member has no saved card only when the server actually said so", async () => {
    mockFetch(() => ok({ card: null }));
    renderDrawer();
    await act(async () => {});

    expect(screen.getByText(/no saved card/i)).toBeTruthy();
    expect(screen.queryByText(/couldn't check/i)).toBeNull();
  });

  it("shows the card when there is one", async () => {
    mockFetch(() => ok({ card: CARD }));
    renderDrawer();
    await act(async () => {});

    expect(screen.getByText(/4242/)).toBeTruthy();
    expect(screen.queryByText(/no saved card/i)).toBeNull();
  });

  it("does NOT claim 'no saved card' when the lookup returns a non-ok status", async () => {
    // This is the money bug. A 500 used to be indistinguishable from a member
    // who has never added a card.
    mockFetch(() => status(500));
    renderDrawer();
    await act(async () => {});

    expect(screen.queryByText(/no saved card/i)).toBeNull();
    expect(screen.getByText(/couldn't check for a saved card/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("does NOT claim 'no saved card' when the lookup never comes back", async () => {
    mockFetch(() => Promise.reject(new Error("network down")));
    renderDrawer();
    await act(async () => {});

    expect(screen.queryByText(/no saved card/i)).toBeNull();
    expect(screen.getByText(/couldn't check for a saved card/i)).toBeTruthy();
  });

  it("keeps charging disabled while the card is unknown, and never offers a charge amount", async () => {
    mockFetch(() => status(503));
    renderDrawer();
    await act(async () => {});

    const submit = screen.getByRole("button", { name: /charge/i }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    const amount = screen.getByPlaceholderText("0.00") as HTMLInputElement;
    expect(amount.disabled).toBe(true);
  });

  it("recovers on retry: a failure followed by a success shows the real card", async () => {
    let attempt = 0;
    mockFetch(() => {
      attempt += 1;
      return attempt === 1 ? status(500) : ok({ card: CARD });
    });
    renderDrawer();
    await act(async () => {});
    expect(screen.getByText(/couldn't check for a saved card/i)).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    });

    expect(screen.getByText(/4242/)).toBeTruthy();
    expect(screen.queryByText(/couldn't check for a saved card/i)).toBeNull();
  });
});

describe("MemberActionsPanel — a failed load is not 'nothing to do'", () => {
  // Noe 2026-08-20: an empty action list renders NOTHING — no card, no tick,
  // no "see you on the mats". The guarantee this file exists to protect is
  // unchanged and is asserted by the two error tests below: a failed load must
  // never be indistinguishable from "you are all clear". Silence is now the
  // correct rendering for empty, which makes those error assertions MORE
  // load-bearing, not less — they are the only thing separating the two states.
  it("renders nothing at all on a real empty list", async () => {
    mockFetch(() => ok({ items: [] }));
    const { container } = render(<MemberActionsPanel mode="full" />);
    await act(async () => {});

    expect(container.innerHTML).toBe("");
    expect(screen.queryByText(/nothing to do/i)).toBeNull();
    // And critically, an empty list must not look like a failure either.
    expect(screen.queryByText(/couldn't load your action list/i)).toBeNull();
  });

  it("shows a retryable error on a non-ok response", async () => {
    mockFetch(() => status(500));
    render(<MemberActionsPanel mode="full" />);
    await act(async () => {});

    expect(screen.queryByText(/nothing to do/i)).toBeNull();
    expect(screen.getByText(/couldn't load your action list/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });

  it("shows a retryable error when the request throws", async () => {
    mockFetch(() => Promise.reject(new Error("offline")));
    render(<MemberActionsPanel mode="full" />);
    await act(async () => {});

    expect(screen.queryByText(/nothing to do/i)).toBeNull();
    expect(screen.getByText(/couldn't load your action list/i)).toBeTruthy();
  });
});

describe("PromotionAlerts — a failed check is not 'nobody to promote'", () => {
  it("renders nothing when the server says there is nobody due", async () => {
    mockFetch(() => ok({ members: [] }));
    render(
      <ToastProvider>
        <PromotionAlerts />
      </ToastProvider>,
    );
    await act(async () => {});

    // No banner at all — and, crucially, no error either: this is the one
    // case where rendering nothing is the honest answer.
    expect(screen.queryByText(/ready for promotion/i)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces a retryable error instead of silently rendering nothing", async () => {
    mockFetch(() => status(500));
    render(
      <ToastProvider>
        <PromotionAlerts />
      </ToastProvider>,
    );
    await act(async () => {});

    expect(screen.getByText(/couldn't check who's ready to move to an adult account/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /try again/i })).toBeTruthy();
  });
});
