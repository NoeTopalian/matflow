// @vitest-environment jsdom
// /dashboard/members/<id>?tab=payments&paymentId=<id> — the page a payment link
// lands on: the Payments tab, with that payment marked and brought into view.
// Nothing is filtered (the member's other payments stay), and an id that is
// not in the list says so rather than marking nothing in silence.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import React from "react";

vi.mock("next-auth/react", () => ({ signOut: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => "/",
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import MemberProfile, { type MemberDetail } from "@/components/dashboard/MemberProfile";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const MEMBER: MemberDetail = {
  id: "mem_1",
  name: "Sam Carter",
  email: "sam@example.com",
  phone: null,
  membershipType: null,
  membershipTierId: null,
  status: "active",
  paymentStatus: "paid",
  notes: null,
  profilePictureUrl: null,
  joinedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-09-30T09:00:00.000Z",
  emergencyContactName: null,
  emergencyContactPhone: null,
  emergencyContactRelation: null,
  medicalConditions: null,
  dateOfBirth: null,
  waiverAccepted: true,
  waiverAcceptedAt: null,
  subscriptions: [],
  ranks: [],
  attendances: [],
};

const PAYMENTS = [
  { id: "pay1", amountPence: 6500, currency: "GBP", status: "succeeded", description: "October membership", paidAt: "2026-10-01T09:00:00.000Z", method: "card" },
  { id: "pay2", amountPence: 4500, currency: "GBP", status: "succeeded", description: "Grading fee", paidAt: "2026-11-03T09:00:00.000Z", method: "manual" },
];

const scrollSpy = vi.fn();

async function open(search: string) {
  window.history.pushState({}, "", `/dashboard/members/mem_1${search}`);
  render(<MemberProfile member={MEMBER} rankOptions={[]} primaryColor="#3b82f6" role="owner" tenantSlug="t" />);
  await act(async () => {});
}

beforeEach(() => {
  scrollSpy.mockClear();
  Element.prototype.scrollIntoView = scrollSpy;
  const store = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
    },
  });
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith("/api/members/mem_1/payments")) return json({ payments: PAYMENTS });
    return json({});
  }) as unknown as typeof fetch;
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("member page ?tab=payments&paymentId=", () => {
  it("opens Payments with that payment marked and in view", async () => {
    await open("?tab=payments&paymentId=pay2");
    await waitFor(() => expect(document.querySelectorAll('tbody tr[aria-current="true"]')).toHaveLength(1));
    const marked = document.querySelector('tbody tr[aria-current="true"]')!;
    expect(marked.textContent).toContain("Grading fee");
    // The member's other payments are still listed.
    expect(screen.getAllByText("October membership").length).toBeGreaterThan(0);
    expect(scrollSpy).toHaveBeenCalled();
    expect(screen.queryByText("That payment isn't among this member's latest payments.")).toBeNull();
  });

  it("says so when the payment is not in the member's list", async () => {
    await open("?tab=payments&paymentId=paymissing");
    await screen.findByText("That payment isn't among this member's latest payments.");
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
  });

  it("marks nothing on a plain Payments tab link", async () => {
    await open("?tab=payments");
    await waitFor(() => expect(screen.getAllByText("Grading fee").length).toBeGreaterThan(0));
    expect(document.querySelectorAll('[aria-current="true"]')).toHaveLength(0);
    expect(screen.queryByText("That payment isn't among this member's latest payments.")).toBeNull();
  });
});
