// @vitest-environment jsdom
// Functional review round 3 (F12): the Family card offered Unlink for an
// under-13, which the database can never allow (a kids row needs a guardian).
// Juniors keep Unlink; an under-13 is told to move to another guardian.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

vi.mock("next/link", () => ({
  default: ({ href, children, ...rest }: { href: string; children: React.ReactNode }) => (
    <a href={href} {...rest}>{children}</a>
  ),
}));
vi.mock("@/components/ui/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));

import OwnerFamilyManagement, { type FamilyChildSummary } from "@/components/dashboard/OwnerFamilyManagement";

afterEach(cleanup);

const child = (id: string, name: string, accountType: string): FamilyChildSummary => ({
  id,
  name,
  accountType,
  dateOfBirth: null,
  waiverAccepted: true,
  paymentStatus: null,
});

function renderCard(role = "owner") {
  return render(
    <OwnerFamilyManagement
      memberId="par-1"
      memberName="Pat Parent"
      hasKidsHint
      parent={null}
      initialChildren={[child("k1", "Sol Kid", "kids"), child("j1", "Jo Junior", "junior")]}
      primaryColor="#000"
      role={role}
    />,
  );
}

describe("OwnerFamilyManagement — Unlink by account type", () => {
  it("offers Unlink for a junior but not for an under-13", () => {
    renderCard();
    expect(screen.getByRole("button", { name: "Unlink Jo Junior" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Unlink Sol Kid" })).toBeNull();
    expect(screen.getByText(/to move them, open the other guardian and use Link existing/)).toBeTruthy();
  });

  it("a coach sees neither", () => {
    renderCard("coach");
    expect(screen.queryByRole("button", { name: /^Unlink/ })).toBeNull();
    expect(screen.queryByText(/open the other guardian/)).toBeNull();
  });
});
