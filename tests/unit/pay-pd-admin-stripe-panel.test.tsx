// @vitest-environment jsdom
//
// Payments lane PD (11 Oct 2026) — the operator's Stripe sync panel.
// Pinned: an HTTP error is an error with retry, never an empty page (UI-RULES
// §7); a loaded overview shows the club, its failed event with attempts and
// the masked last error, and the last reconcile run with its mismatch; Replay
// asks for a reason and a code, buys a step-up grant bound to THIS event with
// force false, and sends it in the header; a refused replay shows the server's
// message and changes nothing on screen; a withdrawn club offers no Replay.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

const { toastSpy } = vi.hoisted(() => ({ toastSpy: vi.fn() }));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastSpy }) }));

import StripeSyncPanel from "@/components/admin/stripe/StripeSyncPanel";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

let calls: Array<{ url: string; init?: RequestInit }> = [];
function installFetch(handler: (url: string, init?: RequestInit) => Response) {
  calls = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    calls.push({ url, init });
    return handler(url, init);
  }) as unknown as typeof fetch;
}

const event = {
  eventId: "evt_pd_1",
  type: "invoice.payment_succeeded",
  status: "failed",
  created: 1760000000,
  attempts: 3,
  lastError: "price lookup failed for [email]",
  firstSeenAt: "2026-10-11T10:00:00.000Z",
  lastAttemptAt: "2026-10-11T11:00:00.000Z",
  reconcileFoundAt: null,
  tenantId: "t1",
};
const overview = (connected = true) => ({
  generatedAt: "2026-10-11T12:00:00.000Z",
  clubs: [
    {
      tenantId: "t1",
      name: "Example Club",
      stripeAccountId: "acct_pd",
      stripeConnected: connected,
      account: { chargesEnabled: true, payoutsEnabled: true, requirementsPastDue: 0, disabledReason: null, refreshedAt: "2026-10-11T09:00:00.000Z" },
      counts: { last24h: { failed: 1, processed: 4 }, last7d: { failed: 1, processed: 20 } },
      lastEventAt: "2026-10-11T11:00:00.000Z",
      attention: [event],
    },
  ],
  unattributed: [],
  lastRun: {
    id: "run1",
    startedAt: "2026-10-11T03:15:00.000Z",
    finishedAt: "2026-10-11T03:16:00.000Z",
    status: "mismatches",
    trigger: "cron",
    tenantsChecked: 1,
    tenantsSkipped: 0,
    eventsScanned: 12,
    eventsMissing: 0,
    stateMismatches: [{ tenantId: "t1", kind: "subscription", objectId: "sub_pd", recordId: "m1", field: "paymentStatus", stored: "paid", stripe: "past_due" }],
    skipped: { tenants: [], truncated: [] },
    errors: [],
  },
});

beforeEach(() => toastSpy.mockClear());

describe("pay-pd: operator Stripe sync panel", () => {
  it("an HTTP error is an error with retry, not an empty page; retry loads", async () => {
    let fail = true;
    installFetch(() => (fail ? json({ error: "boom", reference: "MF-PD0001" }, 500) : json(overview())));
    render(<StripeSyncPanel />);
    expect(await screen.findByText("Couldn't load the Stripe sync state.")).toBeTruthy();
    expect(screen.queryByText("No club has a connected Stripe account")).toBeNull();
    expect(screen.getByText("MF-PD0001")).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Example Club" })).toBeTruthy();
  });

  it("shows the club, the failed event with attempts and the masked error, and the reconcile mismatch", async () => {
    installFetch(() => json(overview()));
    render(<StripeSyncPanel />);
    expect(await screen.findByRole("heading", { name: "Example Club" })).toBeTruthy();
    expect(screen.getAllByText("invoice.payment_succeeded").length).toBeGreaterThan(0);
    expect(screen.getAllByText("price lookup failed for [email]").length).toBeGreaterThan(0);
    expect(screen.getByText("Drift found")).toBeTruthy();
    expect(screen.getAllByText("sub_pd").length).toBeGreaterThan(0);
    expect(screen.getAllByText("past_due").length).toBeGreaterThan(0);
  });

  it("Replay buys a grant bound to this event (force false) and sends it in the header", async () => {
    installFetch((url) => {
      if (url === "/api/admin/stripe/events") return json(overview());
      if (url === "/api/admin/auth/step-up") return json({ grant: "grant-token-pd" });
      if (url.startsWith("/api/admin/stripe/events/evt_pd_1/replay")) return json({ ok: true, result: "processed", status: "replayed" });
      return json({}, 404);
    });
    render(<StripeSyncPanel />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Replay" }))[0]);
    const submit = await screen.findByRole("button", { name: "Replay event" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "price table fixed" } });
    fireEvent.change(screen.getByLabelText("Your authenticator code (confirms it is you)"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Replay event" }));
    await waitFor(() => expect(toastSpy).toHaveBeenCalledWith("Event replayed and processed.", "success"));
    const su = calls.find((c) => c.url === "/api/admin/auth/step-up")!;
    expect(JSON.parse(String(su.init?.body))).toEqual({ action: "stripe.event_replay", targetId: "t1/evt_pd_1", change: { force: false }, code: "123456" });
    const rp = calls.find((c) => c.url.startsWith("/api/admin/stripe/events/evt_pd_1/replay"))!;
    expect(new Headers(rp.init?.headers).get("x-matflow-step-up")).toBe("grant-token-pd");
    expect(JSON.parse(String(rp.init?.body))).toEqual({ reason: "price table fixed" });
  });

  it("a refused replay shows the server's message and is not reported as done", async () => {
    installFetch((url) => {
      if (url === "/api/admin/stripe/events") return json(overview());
      if (url === "/api/admin/auth/step-up") return json({ grant: "g" });
      return json({ error: "This club's Stripe access was withdrawn. The event cannot be fetched or replayed." }, 409);
    });
    render(<StripeSyncPanel />);
    fireEvent.click((await screen.findAllByRole("button", { name: "Replay" }))[0]);
    fireEvent.change(await screen.findByLabelText("Reason"), { target: { value: "price table fixed" } });
    fireEvent.change(screen.getByLabelText("Your authenticator code (confirms it is you)"), { target: { value: "123456" } });
    fireEvent.click(screen.getByRole("button", { name: "Replay event" }));
    expect(await screen.findByText("This club's Stripe access was withdrawn. The event cannot be fetched or replayed.")).toBeTruthy();
    expect(toastSpy).not.toHaveBeenCalled();
  });

  it("a club whose Stripe access was withdrawn offers no Replay", async () => {
    installFetch(() => json(overview(false)));
    render(<StripeSyncPanel />);
    expect(await screen.findByText("Access withdrawn")).toBeTruthy();
    expect(screen.queryAllByRole("button", { name: "Replay" })).toHaveLength(0);
  });
});
