// @vitest-environment jsdom
//
// Round-3 review L6 (23 Oct 2026): the dashboard's "Missing phone numbers"
// item counts people who can train (CAN_TRAIN_MEMBER: active and tasters) and
// links to the Members "Missing Phone" chip, which counted current members
// (inactive too). An inactive member without a phone read 0 on the dashboard
// and 1 on the chip it opened. Both twins now count CAN_TRAIN_MEMBER, the same
// alignment "Waiver missing" got earlier.
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { matchRows } from "./support/prisma-where-eval";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => new URLSearchParams("filter=missing-phone"),
  usePathname: () => "/dashboard/members",
}));

import { CAN_TRAIN_MEMBER } from "@/lib/member-population";
import { countMemberRows, memberListCountWheres } from "@/lib/member-list-counts";
import { clubMonthWindow } from "@/lib/club-month";
import MembersList, { inStatusView, type MemberRow } from "@/components/dashboard/MembersList";

const NOW = new Date("2026-10-23T10:00:00Z");
const MONTH = clubMonthWindow(NOW, "Europe/London");
const INACTIVE_NO_PHONE = { tenantId: "club", id: "i1", name: "Ivo Inactive", email: "ivo@example.test", status: "inactive", accountType: "adult", phone: null, joinedAt: "2025-01-01T00:00:00.000Z" };
const ACTIVE_NO_PHONE = { ...INACTIVE_NO_PHONE, id: "a1", name: "Ada Active", email: "ada@example.test", status: "active" };

afterEach(() => cleanup());

describe("Missing phone counts people who can train, on the dashboard and on Members", () => {
  it("an inactive member without a phone is 0 on both; an active one is 1 on both", () => {
    // The dashboard's where (app/dashboard/page.tsx), as written there.
    const dashboard = (rows: Record<string, unknown>[]) =>
      matchRows(rows, { tenantId: "club", ...CAN_TRAIN_MEMBER, OR: [{ phone: null }, { phone: "" }] }).length;
    expect(readFileSync("app/dashboard/page.tsx", "utf8")).toMatch(/\.\.\.CAN_TRAIN_MEMBER,\s*OR: \[\{ phone: null \}, \{ phone: "" \}\]/);
    const server = (rows: Record<string, unknown>[]) => matchRows(rows, memberListCountWheres("club", NOW, MONTH).missingPhone).length;
    const browser = (rows: MemberRow[]) => countMemberRows(rows, NOW, MONTH).missingPhone;

    expect(dashboard([INACTIVE_NO_PHONE])).toBe(0);
    expect(server([INACTIVE_NO_PHONE])).toBe(0);
    expect(browser([INACTIVE_NO_PHONE])).toBe(0);
    expect(inStatusView(INACTIVE_NO_PHONE, "missing-phone")).toBe(false);

    expect(dashboard([ACTIVE_NO_PHONE])).toBe(1);
    expect(server([ACTIVE_NO_PHONE])).toBe(1);
    expect(browser([ACTIVE_NO_PHONE])).toBe(1);
    expect(inStatusView(ACTIVE_NO_PHONE, "missing-phone")).toBe(true);
  });

  it("the chip the dashboard opens lists only the active member", () => {
    render(<MembersList members={[INACTIVE_NO_PHONE, ACTIVE_NO_PHONE]} primaryColor="#3b82f6" role="owner" />);
    expect(screen.getByRole("button", { name: "Missing Phone · 1" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.queryAllByText("Ada Active").length).toBeGreaterThan(0);
    expect(screen.queryAllByText("Ivo Inactive")).toHaveLength(0);
  });
});
