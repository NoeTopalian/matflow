// @vitest-environment jsdom
//
// Round 11 (baseline 6.1), rollout: after the class form (#99), the other overlay forms ask
// "Discard your changes?" before a stray scrim tap or Escape throws typed input away: plans,
// ranks, record a payment (and, by the same one-line wiring, add member, new announcement,
// promote rank and the profile's record payment). A form nobody touched still closes at once.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import React, { useState } from "react";

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

import { useDirtySince } from "@/lib/use-dirty-since";
import MembershipsManager from "@/components/dashboard/MembershipsManager";
import RanksManager from "@/components/dashboard/RanksManager";
import RecordPaymentModal from "@/components/dashboard/RecordPaymentModal";
import MemberProfile, { type MemberDetail } from "@/components/dashboard/MemberProfile";

const realFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const body = url === "/api/locations" ? { locations: [] } : url.includes("/payments") ? { payments: [] } : url.startsWith("/api/members") ? { members: [] } : {};
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  globalThis.fetch = realFetch;
  document.body.style.overflow = "";
});

const question = () => screen.queryByRole("dialog", { name: "Discard your changes?" });
const escape = () => fireEvent.keyDown(document, { key: "Escape" });

describe("useDirtySince", () => {
  function Probe({ open, value }: { open: boolean; value: string }) {
    return <output>{String(useDirtySince(open, { value }))}</output>;
  }
  it("is clean when opened, dirty after a change, and takes a new snapshot on the next open", () => {
    const { rerender } = render(<Probe open value="seeded" />);
    expect(screen.getByRole("status").textContent).toBe("false");
    rerender(<Probe open value="typed" />);
    expect(screen.getByRole("status").textContent).toBe("true");
    rerender(<Probe open={false} value="typed" />);
    expect(screen.getByRole("status").textContent).toBe("false");
    rerender(<Probe open value="typed" />); // reopened on what is now there
    expect(screen.getByRole("status").textContent).toBe("false");
  });
});

describe("plans: Add tier", () => {
  it("asks after a name is typed; a clean sheet closes at once", async () => {
    render(<MembershipsManager initialTiers={[]} primaryColor="#123456" />);
    await act(async () => {});
    fireEvent.click(screen.getAllByRole("button", { name: "Add tier" })[0]);
    escape();
    expect(question()).toBeNull();
    expect(screen.queryByRole("dialog", { name: "Add tier" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Add tier" })[0]);
    fireEvent.change(screen.getByLabelText("Name *"), { target: { value: "Adults Unlimited" } });
    escape();
    expect(question()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect((screen.getByLabelText("Name *") as HTMLInputElement).value).toBe("Adults Unlimited");
  });
});

describe("ranks: Add rank", () => {
  it("asks after a rank name is typed", async () => {
    render(<RanksManager initialRanks={[]} primaryColor="#123456" role="owner" />);
    await act(async () => {});
    fireEvent.click(screen.getAllByRole("button", { name: "Add rank" })[0]);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText(/Rank name/), { target: { value: "Purple Belt" } });
    await act(async () => {});
    fireEvent.click(document.querySelector('[data-slot="sheet-scrim"]') as HTMLElement);
    expect(question()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("dialog", { name: "Add rank" })).toBeNull();
  });
});

describe("Record a payment", () => {
  function Host({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = useState(true);
    return <RecordPaymentModal open={open} onClose={() => { onClose(); setOpen(false); }} onRecorded={() => {}} member={{ id: "m1", name: "Ana Silva" }} />;
  }
  it("closes at once when nothing was entered", async () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    await act(async () => {});
    escape();
    expect(question()).toBeNull();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("asks once an amount is entered", async () => {
    const onClose = vi.fn();
    render(<Host onClose={onClose} />);
    await act(async () => {});
    fireEvent.change(screen.getByPlaceholderText("0.00"), { target: { value: "40" } });
    escape();
    expect(question()).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("member profile: Record payment sheet", () => {
  const MEMBER: MemberDetail = {
    id: "mem_1", name: "Sam Carter", email: "sam@example.com", phone: null, membershipType: null, membershipTierId: null,
    status: "active", paymentStatus: "paid", notes: null, profilePictureUrl: null, joinedAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-09-30T09:00:00.000Z", emergencyContactName: null, emergencyContactPhone: null, emergencyContactRelation: null,
    medicalConditions: null, dateOfBirth: null, waiverAccepted: true, waiverAcceptedAt: null, subscriptions: [], ranks: [], attendances: [],
  };
  it("asks once an amount is typed, and Discard really discards: reopening starts empty", async () => {
    render(<MemberProfile member={MEMBER} rankOptions={[]} primaryColor="#3b82f6" role="owner" tenantSlug="t" />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("tab", { name: /Payments/ }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /^Record$/ }));
    fireEvent.change(screen.getByLabelText("Amount (£)"), { target: { value: "40" } });
    escape();
    expect(question()).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(screen.queryByRole("dialog", { name: "Record payment" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Record$/ }));
    expect((screen.getByLabelText("Amount (£)") as HTMLInputElement).value).toBe("");
    escape();
    expect(question()).toBeNull();
  });
});
