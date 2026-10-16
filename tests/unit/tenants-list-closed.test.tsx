// @vitest-environment jsdom
//
// Keep closed clubs (product rule, Noe, 16 Oct 2026): the hub used to hide a
// closed club entirely (`where: { deletedAt: null }`), which is why a club
// "soft-deleted" from the Danger Zone simply vanished. Now closed clubs are
// fetched; the default view leaves them out, and a "Closed" status filter
// shows only them, each row badged "Closed <d Mon yyyy>".
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import React from "react";

vi.mock("next/navigation", () => ({
  usePathname: () => "/admin/tenants",
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("@/app/admin/AdminTopNav", () => ({ default: () => null }));

import TenantsList from "@/app/admin/tenants/TenantsList";
import type { TenantRow } from "@/app/admin/tenants/page";

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/admin/tenants");
});

function row(over: Partial<TenantRow> & { id: string; name: string; slug: string }): TenantRow {
  return {
    ownerEmail: null,
    ownerName: null,
    ownerUserId: null,
    memberCount: 0,
    status: "active",
    stripeConnected: false,
    stripeChargesEnabled: null,
    onboardingCompleted: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    deletedAt: null,
    ...over,
  };
}

const OPEN = row({ id: "t-open", name: "Open Gym", slug: "open-gym" });
const CLOSED = row({ id: "t-closed", name: "Closed Gym", slug: "closed-gym", deletedAt: "2026-03-03T12:00:00.000Z" });
const SUSPENDED = row({ id: "t-susp", name: "Paused Gym", slug: "paused-gym", status: "suspended" });

describe("(d) TenantsList and closed clubs", () => {
  it("the default view hides closed rows", () => {
    render(<TenantsList tenants={[OPEN, CLOSED, SUSPENDED]} />);
    expect(screen.getByText("Open Gym")).toBeTruthy();
    expect(screen.getByText("Paused Gym")).toBeTruthy();
    expect(screen.queryByText("Closed Gym")).toBeNull();
  });

  it("the 'Closed' filter shows only closed rows, each badged with its closing date", () => {
    render(<TenantsList tenants={[OPEN, CLOSED, SUSPENDED]} />);
    fireEvent.click(screen.getByRole("button", { name: "Closed" }));
    expect(screen.getByText("Closed Gym")).toBeTruthy();
    expect(screen.queryByText("Open Gym")).toBeNull();
    expect(screen.queryByText("Paused Gym")).toBeNull();
    const tr = screen.getByText("Closed Gym").closest("tr")!;
    expect(within(tr).getByText("Closed 3 Mar 2026")).toBeTruthy();
  });

  it("the other status filters never show a closed club, even one whose status matches", () => {
    render(<TenantsList tenants={[OPEN, { ...CLOSED, status: "active" }]} />);
    // The Status chip group (the Stripe group has an "All" of its own, and the
    // table header is also "Status" — the chip label is the SPAN).
    const label = screen.getAllByText("Status").find((el) => el.tagName === "SPAN")!;
    const statusChips = within(label.parentElement!);
    fireEvent.click(statusChips.getByRole("button", { name: "Active" }));
    expect(screen.getByText("Open Gym")).toBeTruthy();
    expect(screen.queryByText("Closed Gym")).toBeNull();
    fireEvent.click(statusChips.getByRole("button", { name: "All" }));
    expect(screen.queryByText("Closed Gym")).toBeNull();
  });

  it("?status=closed in the URL opens on the closed view", () => {
    window.history.replaceState(null, "", "/admin/tenants?status=closed");
    render(<TenantsList tenants={[OPEN, CLOSED]} />);
    expect(screen.getByText("Closed Gym")).toBeTruthy();
    expect(screen.queryByText("Open Gym")).toBeNull();
  });
});
