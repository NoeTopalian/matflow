// Pre-Resend adversarial pass (W6, 28 Oct 2026): a support (operator) session
// against the changed doors through direct requests. proxy.ts applies
// supportRequestDecision to every request a support session makes; these pin
// what it answers for the check-in doors, the class-pack routes, the settings
// route and the import routes, including path-spelling tricks.
//
// Pure: no database, no provider.

import { describe, it, expect } from "vitest";
import { supportRequestDecision, refuseSupportEditFields, SUPPORT_EDIT_FIELD_POLICY } from "@/lib/support-session";

const VIEW_REFUSED: Array<[string, string]> = [
  ["POST", "/api/checkin"],
  ["DELETE", "/api/checkin"],
  ["POST", "/api/checkin/card"],
  ["POST", "/api/coach/instances/inst_1/attendance"],
  ["POST", "/api/class-packs"],
  ["PATCH", "/api/class-packs/pack_1"],
  ["DELETE", "/api/class-packs/pack_1"],
  ["POST", "/api/member/class-packs/buy"],
  ["POST", "/api/payments/pay_1/refund"],
  ["PATCH", "/api/settings"],
  ["POST", "/api/admin/import/job_1/commit"],
  ["POST", "/api/admin/import/job_1/rollback"],
  ["POST", "/api/admin/import/job_1/preview"],
];

// An EDIT session may mark attendance at the register (POST /api/checkin) and
// change routine settings; everything else on the changed surfaces stays with
// the club.
const EDIT_REFUSED: Array<[string, string]> = VIEW_REFUSED.filter(([m, p]) => !(m === "POST" && p === "/api/checkin") && !(m === "PATCH" && p === "/api/settings"));

/** The path as sent, with a trailing slash, with doubled slashes, and with its first letter after /api/ percent-encoded. */
const SPELLINGS = (p: string) => [
  p,
  `${p}/`,
  p.replace(/\//g, "//"),
  p.replace(/^\/api\/(.)/, (_m, c: string) => `/api/%${c.charCodeAt(0).toString(16)}`),
];

describe("W6 support sessions on the changed doors", () => {
  it("a VIEW session is refused every mutation on the changed doors, however the path is spelt", () => {
    for (const [m, p] of VIEW_REFUSED) {
      for (const path of SPELLINGS(p)) {
        const d = supportRequestDecision(m, path, "view");
        expect(d.allowed, `${m} ${path}`).toBe(false);
      }
      // A lower-case or missing method is not a way round it.
      expect(supportRequestDecision(m.toLowerCase(), p, "view").allowed).toBe(false);
    }
  });

  it("an EDIT session is refused the pack, card, coach-tick, refund, unmark and import routes", () => {
    for (const [m, p] of EDIT_REFUSED) {
      for (const path of SPELLINGS(p)) expect(supportRequestDecision(m, path, "edit").allowed, `${m} ${path}`).toBe(false);
    }
  });

  it("the exports on the changed surfaces are refused to both scopes", () => {
    for (const scope of ["view", "edit"] as const) {
      expect(supportRequestDecision("GET", "/api/payments/export.csv", scope).allowed).toBe(false);
      expect(supportRequestDecision("GET", "/api/admin/import/job_1/exceptions", scope).allowed).toBe(false);
      expect(supportRequestDecision("GET", "/api/admin/import/attendance/export", scope).allowed).toBe(false);
    }
  });

  it("an EDIT session cannot turn member app check-in on or off, alone or hidden among routine fields", () => {
    const edit = { user: { impersonatedBy: "op", supportScope: "edit" } };
    const allowed = SUPPORT_EDIT_FIELD_POLICY["settings.update"];
    expect(refuseSupportEditFields(edit, { memberAppCheckin: false }, allowed)).not.toBeNull();
    expect(refuseSupportEditFields(edit, { name: "Club", memberAppCheckin: true }, allowed)).not.toBeNull();
    expect(refuseSupportEditFields(edit, { name: "Club" }, allowed)).toBeNull();
    // A scope that is not exactly "edit" is a view session.
    expect(refuseSupportEditFields({ user: { impersonatedBy: "op", supportScope: "Edit" } }, { name: "Club" }, allowed)).not.toBeNull();
  });
});
