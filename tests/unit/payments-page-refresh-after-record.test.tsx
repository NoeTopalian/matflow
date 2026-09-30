// @vitest-environment jsdom
//
// End-user simulation, 30 Sep 2026: the desk recorded £75 cash from the
// Payments page, the dialog closed, and the page still said "0 payments total"
// / "No payments found" until a browser reload — an invitation to record it
// twice. The re-read only ran when the "All payments" tab was open; the page
// opens on "Outstanding". Now every recorded payment re-reads the list (and
// the Outstanding panel), whichever tab is showing.
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import React from "react";

const { outstandingMounts } = vi.hoisted(() => ({ outstandingMounts: { n: 0 } }));

vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/components/dashboard/ExportCsvButton", () => ({ default: () => null }));
vi.mock("@/components/dashboard/OutstandingPanel", () => ({
  default: function OutstandingStub({ onRecorded }: { onRecorded?: () => void }) {
    React.useEffect(() => { outstandingMounts.n += 1; }, []);
    return (
      <>
        <p>outstanding</p>
        <button type="button" onClick={() => onRecorded?.()}>stub-row-record</button>
      </>
    );
  },
}));
vi.mock("@/components/dashboard/RecordPaymentModal", () => ({
  default: ({ open, onRecorded }: { open: boolean; onRecorded?: (id: string) => void }) =>
    open ? <button type="button" onClick={() => onRecorded?.("m1")}>stub-record</button> : null,
}));

import PaymentsPageClient from "@/components/dashboard/PaymentsPageClient";

let paymentReads = 0;

beforeEach(() => {
  paymentReads = 0;
  outstandingMounts.n = 0;
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (url.startsWith("/api/payments?")) {
      paymentReads += 1;
      const total = paymentReads > 1 ? 1 : 0;
      return Promise.resolve({
        ok: true,
        json: async () => ({ payments: [], total, page: 1, pages: 1, openDisputes: [] }),
      });
    }
    return Promise.resolve({ ok: true, json: async () => ({ total: 0, orders: [] }) });
  }) as unknown as typeof fetch;
});

describe("Payments page after Record payment", () => {
  it("re-reads the payment list and the Outstanding panel while the Outstanding tab is open", async () => {
    render(<PaymentsPageClient />);
    await act(async () => {});
    expect(paymentReads).toBe(1);
    expect(screen.getByText("0 payments total")).toBeTruthy();
    const mountsBefore = outstandingMounts.n;

    fireEvent.click(screen.getByRole("button", { name: /Record payment/ }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "stub-record" }));
    });
    await act(async () => {});

    expect(paymentReads).toBe(2);
    expect(screen.getByText("1 payment total")).toBeTruthy();
    expect(outstandingMounts.n).toBeGreaterThan(mountsBefore);
  });

  // End-user check, 30 Sep 2026: recording cash from an Outstanding ROW (its
  // own dialog, inside the panel) left the header at "0 payments total ·
  // Collected today £0.00" until a reload.
  it("re-reads the header totals when a payment is recorded from an Outstanding row", async () => {
    render(<PaymentsPageClient />);
    await act(async () => {});
    expect(screen.getByText("0 payments total")).toBeTruthy();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "stub-row-record" }));
    });
    await act(async () => {});

    expect(paymentReads).toBe(2);
    expect(screen.getByText("1 payment total")).toBeTruthy();
  });
});
