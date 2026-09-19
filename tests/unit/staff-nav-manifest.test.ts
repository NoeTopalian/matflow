// Noe, 18 Sep 2026: "the scan cards should be a section under mark attendance
// … it's not clear where I can mark attendance manually easily as a coach on
// the app." One attendance entry, for every staff role, in the bottom bar.
import { describe, it, expect } from "vitest";
import { STAFF_NAV } from "@/components/layout/routes";

describe("staff navigation manifest", () => {
  const byHref = (href: string) => STAFF_NAV.find((i) => i.href === href);

  it("has one attendance entry, open to all four roles, in the bottom tab bar", () => {
    const checkin = byHref("/dashboard/checkin");
    expect(checkin?.roles).toEqual(["owner", "manager", "coach", "admin"]);
    expect(checkin?.mobilePrimary).toBe(true);
    expect(checkin?.mobileLabel).toBe("Register");
  });

  it("no longer advertises Scan Cards or Today's Register as separate screens", () => {
    expect(byHref("/dashboard/scan")).toBeUndefined();
    expect(byHref("/dashboard/coach")).toBeUndefined();
  });

  it("keeps exactly four bottom tabs, with the attendance entry in the centre slot", () => {
    const primary = STAFF_NAV.filter((i) => i.mobilePrimary).map((i) => i.href);
    expect(primary).toEqual(["/dashboard", "/dashboard/timetable", "/dashboard/checkin", "/dashboard/members"]);
  });

  // Campaign lane L-B, J18: the nav and the page gate must agree, or a role is
  // either shown a link it cannot open or — as here — allowed through a door it
  // is never given. `app/dashboard/payments/page.tsx` gates on
  // `requireOwnerOrManager()`, so a manager could reach Payments by typing the
  // URL while the sidebar and the mobile More sheet hid it from them. The gate
  // is the correct side: `GET /api/payments/export.csv` answers a manager 200,
  // and Reports and Notifications are already owner+manager in both places.
  it("shows Payments to the two roles its page gate admits", () => {
    expect(byHref("/dashboard/payments")?.roles).toEqual(["owner", "manager"]);
  });
});
