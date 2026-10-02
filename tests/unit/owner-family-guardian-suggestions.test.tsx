// @vitest-environment jsdom
// 2 Oct 2026: an import may SUGGEST a guardian (shared email / emergency
// contact). The Family card shows the suggestion as not confirmed, offers
// Confirm / Not a guardian to owner + manager only, posts to the CHILD's
// guardian route, and never shows the controls on a confirmed link.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
const toastMock = vi.fn();
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: toastMock }) }));

import OwnerFamilyManagement, { type FamilyChildSummary, type FamilyParentSummary } from "@/components/dashboard/OwnerFamilyManagement";

afterEach(cleanup);
const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  toastMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

const child = (id: string, name: string, over: Partial<FamilyChildSummary> = {}): FamilyChildSummary => ({
  id, name, accountType: "kids", dateOfBirth: null, waiverAccepted: true, paymentStatus: null, linkConfirmed: true, suggestedBy: null, ...over,
});

describe("Family card — guardian suggestions", () => {
  it("a suggested child shows 'guardian not confirmed' with Confirm / Not a guardian; a confirmed child shows neither", () => {
    render(
      <OwnerFamilyManagement memberId="p1" memberName="Pat" hasKidsHint parent={null} primaryColor="#000" role="owner"
        initialChildren={[child("k1", "Kit", { linkConfirmed: false, suggestedBy: "shared_email" }), child("k2", "Kim")]} />,
    );
    expect(screen.getByText("guardian not confirmed")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Confirm Pat as Kit's guardian" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Confirm Pat as Kim's guardian" })).toBeNull();
  });

  it("a coach sees the status but no controls", () => {
    render(
      <OwnerFamilyManagement memberId="p1" memberName="Pat" hasKidsHint parent={null} primaryColor="#000" role="coach"
        initialChildren={[child("k1", "Kit", { linkConfirmed: false, suggestedBy: "emergency_contact" })]} />,
    );
    expect(screen.getByText("guardian not confirmed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Confirm Pat as/ })).toBeNull();
  });

  it("Confirm posts to the CHILD's guardian route and the pill clears", async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true, message: "done" }) });
    render(
      <OwnerFamilyManagement memberId="p1" memberName="Pat" hasKidsHint parent={null} primaryColor="#000" role="manager"
        initialChildren={[child("k1", "Kit", { linkConfirmed: false, suggestedBy: "shared_email" })]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Confirm Pat as Kit's guardian" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/members/k1/guardian");
    expect(JSON.parse(String(init.body))).toEqual({ action: "confirm", adoptUnverifiedEmail: false });
    await waitFor(() => expect(screen.queryByText("guardian not confirmed")).toBeNull());
  });

  it("on a child's profile, a suggested parent shows the reason and 'Confirm guardian' with the adopt-email option", () => {
    const parent: FamilyParentSummary = { id: "p1", name: "Pat", linkConfirmed: false, suggestedBy: "emergency_contact", adoptableEmail: "pat@example.test" };
    render(<OwnerFamilyManagement memberId="k1" memberName="Kit" hasKidsHint={false} parent={parent} initialChildren={[]} primaryColor="#000" role="owner" />);
    expect(screen.getByText("Suggested guardian")).toBeTruthy();
    expect(screen.getByText(/from the emergency contact in the import/)).toBeTruthy();
    expect(screen.getByText("pat@example.test")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Confirm guardian/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Not a guardian/ })).toBeTruthy();
  });

  it("a confirmed parent reads as Parent / sub-account with no controls", () => {
    const parent: FamilyParentSummary = { id: "p1", name: "Pat", linkConfirmed: true, suggestedBy: "staff", adoptableEmail: null };
    render(<OwnerFamilyManagement memberId="k1" memberName="Kit" hasKidsHint={false} parent={parent} initialChildren={[]} primaryColor="#000" role="owner" />);
    expect(screen.getByText("Parent")).toBeTruthy();
    expect(screen.getByText("sub-account")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Confirm guardian/ })).toBeNull();
  });

  it("a refused reject (under-13) surfaces the server's sentence and keeps the row", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ error: "A child under 13 must have a guardian." }) });
    render(
      <OwnerFamilyManagement memberId="p1" memberName="Pat" hasKidsHint parent={null} primaryColor="#000" role="owner"
        initialChildren={[child("k1", "Kit", { linkConfirmed: false, suggestedBy: "shared_email" })]} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Pat is not Kit's guardian" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove suggestion" }));
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith("A child under 13 must have a guardian.", "error"));
    expect(screen.getByText("Kit")).toBeTruthy();
  });
});
