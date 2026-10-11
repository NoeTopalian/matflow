// @vitest-environment jsdom
//
// Payments lane PB (11 Oct 2026), audit F1 — the adult member self-subscribe
// surface. POST /api/member/subscriptions/start existed with no UI caller.
//
// Pinned:
//   - a member-portal surface calls the route, and the billing page links to it
//   - start posts { priceId, requestId } (a stable key across a retry of the
//     same plan) and goes straight on to the payment step for the returned id
//   - a refusal shows the server's message and no payment step
//   - an unpaid subscription found on load is offered "Finish payment"
//   - Pay later says nothing was taken and Resume remounts the step
//   - a member TeamUp bills, or a club that has not opted in, is offered no
//     plan picker at all

import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import React from "react";

const { mounts, refresh } = vi.hoisted(() => ({
  mounts: [] as Array<{ subscriptionId: string; onAbandon?: () => void; onPaid?: (s: unknown) => void }>,
  refresh: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }));
vi.mock("@/components/billing/ConfirmSubscriptionPayment", () => ({
  default: (props: { subscriptionId: string; onAbandon?: () => void; onPaid?: (s: unknown) => void }) => {
    mounts.push(props);
    return (
      <div data-testid="payment-step" data-subscription={props.subscriptionId}>
        <span role="link" tabIndex={0} onClick={props.onAbandon}>
          probe-abandon
        </span>
        <span role="link" tabIndex={0} onClick={() => props.onPaid?.({})}>
          probe-paid
        </span>
      </div>
    );
  },
}));

import SelfSubscribeCard, { type SelfSubscribeCardProps } from "@/components/member/SelfSubscribeCard";

const PLANS = [
  { id: "tier_a", name: "Adult Unlimited", description: null, pricePence: 6500, currency: "GBP", billingCycle: "monthly", stripePriceId: "price_adult" },
  { id: "tier_b", name: "Two a week", description: "Any two classes", pricePence: 4500, currency: "GBP", billingCycle: "monthly", stripePriceId: "price_two" },
];

function renderCard(over: Partial<SelfSubscribeCardProps> = {}) {
  return render(
    <SelfSubscribeCard gymName="Iron Path" canSelfSubscribe billedElsewhere={false} plans={PLANS} state={{ kind: "none" }} {...over} />,
  );
}

const res = (status: number, body: unknown) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });

beforeEach(() => {
  vi.unstubAllGlobals();
  mounts.length = 0;
  refresh.mockReset();
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

describe("pay-pb: the self-subscribe route has a member-portal caller", () => {
  it("some file under app/member or components/member posts to /api/member/subscriptions/start", () => {
    const root = process.cwd();
    const files = [...walk(path.join(root, "app/member")), ...walk(path.join(root, "components/member"))];
    const callers = files.filter((f) => /["'`]\/api\/member\/subscriptions\/start["'`]/.test(readFileSync(f, "utf8")));
    expect(callers.length).toBeGreaterThan(0);
  });

  it("the member billing page links to the membership page", () => {
    const src = readFileSync(path.join(process.cwd(), "app/member/billing/page.tsx"), "utf8");
    expect(src).toContain('href="/member/membership"');
  });
});

describe("pay-pb: SelfSubscribeCard", () => {
  it("starts the chosen plan with a request id and moves to the payment step for the returned subscription", async () => {
    const fetchMock = vi.fn().mockImplementation(() => res(201, { subscriptionId: "sub_self_1", clientSecret: "pi_s_secret" }));
    vi.stubGlobal("fetch", fetchMock);
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /two a week/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));

    const step = await screen.findByTestId("payment-step");
    expect(step.getAttribute("data-subscription")).toBe("sub_self_1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/member/subscriptions/start");
    const body = JSON.parse(init.body);
    expect(Object.keys(body).sort()).toEqual(["priceId", "requestId"]);
    expect(body.priceId).toBe("price_two");
    expect(body.requestId.length).toBeGreaterThanOrEqual(8);
  });

  it("a retry of the same plan reuses the request id; a different plan mints a new one", async () => {
    const fetchMock = vi.fn().mockImplementation(() => res(503, { error: "We can't take payments for this gym just now." }));
    vi.stubGlobal("fetch", fetchMock);
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /adult unlimited/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));
    await screen.findByRole("alert");
    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: /two a week/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const ids = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).requestId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });

  it("a refusal shows the server's message and no payment step", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => res(409, { error: "You already have an active membership." })));
    renderCard();
    fireEvent.click(screen.getByRole("button", { name: /adult unlimited/i }));
    fireEvent.click(screen.getByRole("button", { name: /continue to payment/i }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("You already have an active membership.");
    expect(screen.queryByTestId("payment-step")).toBeNull();
  });

  it("an unpaid subscription on load is offered Finish payment; Pay later + Resume keep the same subscription", async () => {
    renderCard({ state: { kind: "unpaid", subscriptionId: "sub_unpaid_9" } });
    expect(screen.queryByRole("button", { name: /continue to payment/i })).toBeNull();
    expect(document.body.textContent ?? "").toMatch(/no access until the first payment is received/i);
    fireEvent.click(screen.getByRole("button", { name: /finish payment/i }));
    expect((await screen.findByTestId("payment-step")).getAttribute("data-subscription")).toBe("sub_unpaid_9");

    fireEvent.click(screen.getByText("probe-abandon"));
    await waitFor(() => expect(screen.queryByTestId("payment-step")).toBeNull());
    expect(document.body.textContent ?? "").toMatch(/not been taken/i);
    expect(document.body.textContent ?? "").toMatch(/no access until the first payment is received/i);
    fireEvent.click(screen.getByRole("button", { name: /resume/i }));
    expect((await screen.findByTestId("payment-step")).getAttribute("data-subscription")).toBe("sub_unpaid_9");
  });

  it("once MatFlow records the payment it says so and refreshes the server data", async () => {
    renderCard({ state: { kind: "unpaid", subscriptionId: "sub_unpaid_9" } });
    fireEvent.click(screen.getByRole("button", { name: /finish payment/i }));
    fireEvent.click(await screen.findByText("probe-paid"));
    await screen.findByText(/payment received/i);
    expect(refresh).toHaveBeenCalled();
  });

  it.each([
    ["billed by TeamUp", { billedElsewhere: true }],
    ["club not opted in", { canSelfSubscribe: false }],
  ])("%s: no plan picker and nothing to submit", (_l, over) => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    renderCard(over as Partial<SelfSubscribeCardProps>);
    expect(screen.queryByRole("button", { name: /continue to payment/i })).toBeNull();
    expect(screen.queryByRole("group", { name: /membership plans/i })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an active membership is stated, with no second subscription on offer", () => {
    renderCard({ state: { kind: "active", membershipType: "Adult Unlimited", paymentStatus: "paid" } });
    expect(screen.queryByRole("button", { name: /continue to payment/i })).toBeNull();
    expect(document.body.textContent).toContain("Adult Unlimited");
  });
});
