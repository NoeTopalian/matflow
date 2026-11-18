// Round 2 (10 Nov 2026): the staff member profile's 2FA and comp-class reads
// tell a failed read apart from "none", and a failure enables nothing.
// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";

const withTenantContext = vi.fn();
vi.mock("@/lib/prisma-tenant", () => ({ withTenantContext: (...a: unknown[]) => withTenantContext(...a) }));

import { loadMemberProfileExtras } from "@/lib/member-profile-extras";
import { MemberExtrasUnavailable } from "@/components/dashboard/MemberExtrasUnavailable";

function txWith(totp: unknown, roster: unknown[]) {
  return {
    member: { findFirst: vi.fn<(args: unknown) => Promise<unknown>>(async () => totp) },
    classRoster: { findMany: vi.fn<(args: unknown) => Promise<unknown>>(async () => roster) },
  };
}

beforeEach(() => {
  withTenantContext.mockReset();
  cleanup();
});

describe("loadMemberProfileExtras", () => {
  it("returns the member's 2FA status and roster, scoped to the club", async () => {
    const tx = txWith({ totpEnabled: true }, [{ id: "r1", classId: "c1", addedAt: new Date(), class: { id: "c1", name: "Comp" } }]);
    withTenantContext.mockImplementation(async (_t: string, fn: (tx: unknown) => unknown) => fn(tx));
    const out = await loadMemberProfileExtras("t-A", "m-1");
    expect(out.extrasUnavailable).toBe(false);
    expect(out.totpRow).toEqual({ totpEnabled: true });
    expect(out.rosterMemberships).toHaveLength(1);
    expect(withTenantContext.mock.calls[0][0]).toBe("t-A");
    expect(tx.member.findFirst.mock.calls[0][0]).toMatchObject({ where: { id: "m-1", tenantId: "t-A" } });
    expect(tx.classRoster.findMany.mock.calls[0][0]).toMatchObject({ where: { memberId: "m-1", tenantId: "t-A" } });
  });

  it("an empty roster is a successful read, not an unavailable one", async () => {
    withTenantContext.mockImplementation(async (_t: string, fn: (tx: unknown) => unknown) => fn(txWith({ totpEnabled: false }, [])));
    const out = await loadMemberProfileExtras("t-A", "m-1");
    expect(out).toMatchObject({ extrasUnavailable: false, rosterMemberships: [], totpRow: { totpEnabled: false } });
  });

  it("a failed read says unavailable and enables nothing (no confirmed 2FA)", async () => {
    withTenantContext.mockRejectedValue(new Error("connection terminated"));
    const out = await loadMemberProfileExtras("t-A", "m-1");
    expect(out.extrasUnavailable).toBe(true);
    expect(out.totpRow).toBeNull();
    expect(out.rosterMemberships).toEqual([]);
  });
});

describe("MemberExtrasUnavailable", () => {
  it("tells an owner or manager that 2FA and comp class details weren't loaded, with Reload", () => {
    render(<MemberExtrasUnavailable memberId="m-1" mentionTwoFactor />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Two-factor and comp class details couldn't be loaded");
    expect(alert.textContent).toContain("Nothing about them has changed.");
    expect(screen.getByRole("link", { name: "Reload" }).getAttribute("href")).toBe("/dashboard/members/m-1");
    // No raw error text reaches the page.
    expect(alert.textContent).not.toMatch(/connection|Error|stack/i);
  });

  it("does not mention 2FA to a role that can't see the reset card", () => {
    render(<MemberExtrasUnavailable memberId="m-1" mentionTwoFactor={false} />);
    expect(screen.getByRole("alert").textContent).toBe(
      "Comp class details couldn't be loaded, so they aren't shown. Nothing about them has changed.Reload",
    );
  });
});
